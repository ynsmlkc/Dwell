/**
 * Boru hatti — parcalari birbirine baglar.
 *
 *   AdSelector  →  ImpressionIngest  →  Verifier  →  Ledger
 *
 * Tek bir yerde durmasinin sebebi: bu gecislerdeki kurallar dokumanin en
 * pahali kararlarini tasiyor ve dagilirsa biri kacar.
 *   • Fiyat teslimat aninda dondurulur, gosterimle birlikte tasinir (ADR-011)
 *   • Ledger kaydi YALNIZCA `verified` icin yazilir — `rejected` faturalanmaz
 *   • Reklamverenin harcanabilir bakiyesi ledger'dan gelir (ADR-021)
 */

import { type Stroops, stroops, add, sub, ZERO } from '@dwell/protocol'
import type { Clock, IdGenerator } from '@dwell/protocol'
import { AdSelector, type Campaign, type AdSelection } from './ads/selector.js'
import { ImpressionIngest, type DeliveredAd, type StoredImpression } from './impressions/ingest.js'
import { Verifier } from './impressions/verify.js'
import { Ledger } from './ledger/ledger.js'
import { accountId } from './ledger/accounts.js'

export interface PipelineOptions {
  readonly clock: Clock
  readonly ids: IdGenerator
  readonly ledger: Ledger
  readonly campaigns: () => readonly Campaign[]
  readonly minImpressionMs: number
  readonly minClientVersion: string
  readonly pendingMs: number
  readonly dailyCap: number
  readonly isDatacenterIp?: (ipHash: string | null) => boolean
}

export class Pipeline {
  readonly #deliveries = new Map<string, DeliveredAd>()
  readonly #impressions = new Map<string, StoredImpression>()
  readonly selector: AdSelector
  readonly ingest: ImpressionIngest
  readonly verifier: Verifier

  constructor(private readonly opts: PipelineOptions) {
    this.selector = new AdSelector({
      clock: opts.clock,
      ids: opts.ids,
      campaigns: opts.campaigns,
      spendableBalance: (advertiserId) => this.spendable(advertiserId),
    })

    this.ingest = new ImpressionIngest({
      clock: opts.clock,
      findDelivery: (n) => this.#deliveries.get(n) ?? null,
      seen: (p, id) => this.#impressions.get(this.#key(p, id)) ?? null,
      save: (i) => { this.#impressions.set(this.#key(i.publisherId, i.id), i) },
      minImpressionMs: opts.minImpressionMs,
      minClientVersion: opts.minClientVersion,
    })

    this.verifier = new Verifier({
      clock: opts.clock,
      pendingMs: opts.pendingMs,
      dailyCap: opts.dailyCap,
      countToday: (p, at) => this.#countToday(p, at),
      isDatacenterIp: opts.isDatacenterIp ?? (() => false),
    })
  }

  /**
   * Reklamverenin harcayabilecegi tutar — ADR-021.
   *
   * `bakiye − rezerve`. Rezerve, `pending` durumdaki gosterimlerin toplami:
   * o para henuz ledger'a girmedi ama girecek. Rezervasyon olmadan 24 saatlik
   * pending penceresi kadar butce asimi GARANTIDIR.
   */
  spendable(advertiserId: string): Stroops {
    const balance = this.opts.ledger.balance(accountId('advertiser', advertiserId))
    let reserved = ZERO
    for (const i of this.#impressions.values()) {
      if (i.advertiserId === advertiserId && i.state === 'pending') {
        reserved = add(reserved, stroops(i.rateStroops))
      }
    }
    const left = sub(balance, reserved)
    return left > 0n ? left : ZERO
  }

  /** `POST /v1/ads/next` — teslimat kaydedilir ki nonce dogrulanabilsin. */
  serveAd(publisherId: string): AdSelection | null {
    const sel = this.selector.select(publisherId)
    if (!sel) return null

    this.#deliveries.set(sel.nonce, {
      nonce: sel.nonce,
      publisherId,
      campaignId: sel.campaign.id,
      advertiserId: sel.campaign.advertiserId,
      rate: sel.rate,                       // ADR-011 — bu an dondurulur
      revShareBps: sel.campaign.revShareBps,
      expiresAt: sel.nonceExpiresAt,
      consumed: false,
    })
    this.#gcDeliveries()
    return sel
  }

  /**
   * Dogrulama job'i — `pending` kayitlari degerlendirir ve `verified`
   * olanlar icin ledger kaydi yazar.
   *
   * Ledger'a yazan tek yer burasi. `rejected` gosterim icin HICBIR kayit
   * yazilmaz; reklamveren faturalanmaz (§9).
   */
  runVerification(): { verified: number; rejected: number; stillPending: number } {
    const all = [...this.#impressions.values()]
    let verified = 0, rejected = 0, stillPending = 0

    for (const imp of all) {
      if (imp.state !== 'pending') continue
      const outcome = this.verifier.evaluate(imp, all)

      if (outcome.state === 'pending') { stillPending++; continue }

      if (outcome.state === 'rejected') {
        this.#update({ ...imp, state: 'rejected', rejectReason: outcome.reason })
        rejected++
        continue
      }

      // Once ledger, sonra durum. Ters sirada yazilirsa ledger patladiginda
      // gosterim "verified" gorunur ama parasi hic yazilmamis olur.
      this.opts.ledger.postImpression({
        impressionId: imp.id,
        advertiserId: imp.advertiserId,
        publisherId: imp.publisherId,
        campaignId: imp.campaignId,
        rate: stroops(imp.rateStroops),
        revShareBps: imp.revShareBps,
      })
      this.#update({ ...imp, state: 'verified' })
      verified++
    }

    return { verified, rejected, stillPending }
  }

  impressions(): readonly StoredImpression[] { return [...this.#impressions.values()] }

  /* ── ic isler ── */

  #key = (publisherId: string, id: string): string => `${publisherId}|${id}`

  #update(imp: StoredImpression): void {
    this.#impressions.set(this.#key(imp.publisherId, imp.id), imp)
  }

  #countToday(publisherId: string, at: number): number {
    const dayStart = at - (at % 86_400_000)
    let n = 0
    for (const i of this.#impressions.values()) {
      if (i.publisherId === publisherId && i.state === 'verified'
        && i.serverTs >= dayStart && i.serverTs < dayStart + 86_400_000) n++
    }
    return n
  }

  /** Suresi dolmus teslimatlari at — bellek sinirsiz buyumesin. */
  #gcDeliveries(): void {
    const now = this.opts.clock.now()
    for (const [nonce, d] of this.#deliveries) {
      if (d.expiresAt < now - 3600_000) this.#deliveries.delete(nonce)
    }
  }
}
