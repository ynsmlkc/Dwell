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
  /** Acik artirmanin taban fiyati, blok basina. Bkz. `SelectorDeps.reserveCpm`. */
  readonly reserveCpm?: Stroops
  readonly minImpressionMs: number
  readonly minClientVersion: string
  readonly pendingMs: number
  readonly dailyCap: number
  readonly isDatacenterIp?: (ipHash: string | null) => boolean
  /** NEXT.md §10 — yayincinin uye oldugu acik sponsor havuzu. */
  readonly poolOf?: (publisherId: string) => string | null
  /** Havuz butcesi ve uye gunluk siniri izin veriyor mu (bkz. `AdSelector`). */
  readonly poolAllows?: (publisherId: string, poolId: string, rate: Stroops) => boolean
  /** Sponsorun acik havuzlarina ayrilmis, henuz harcanmamis tutar. */
  readonly reservedForPools?: (advertiserId: string) => Stroops

  /**
   * Kalicilik kancalari.
   *
   * Verilmezse her sey yalnizca bellekte kalir — testlerin ve gelistirmenin
   * varsayilani bu. Uretimde SQLite aynasi baglaniyor.
   *
   * Okuma yollarina DOKUNULMUYOR: `Map`'ler oldugu gibi duruyor, yalnizca
   * yazarken bir kopya da diske gidiyor ve acilista geri yukleniyor.
   */
  readonly persist?: {
    readonly loadImpressions: () => readonly StoredImpression[]
    readonly saveImpression: (i: StoredImpression) => void
    readonly loadDeliveries: () => readonly DeliveredAd[]
    readonly saveDelivery: (d: DeliveredAd) => void
    readonly loadTour?: (publisherId: string) => readonly string[]
    readonly saveTour?: (publisherId: string, tour: readonly string[]) => void
    readonly loadBans?: () => readonly Ban[]
    readonly saveBans?: (bans: readonly Ban[]) => void
  }
}

/** Admin'in kapattigi yayinci cuzdani. Reklam gitmez, bekleyenler reddedilir. */
export interface Ban {
  readonly publisherId: string
  readonly reason: string
  readonly at: number
}

export class Pipeline {
  readonly #deliveries = new Map<string, DeliveredAd>()
  /** Sahne hakki tura geri verilmis, suresi dolmus teslimatlar. */
  readonly #returned = new Set<string>()
  readonly #impressions = new Map<string, StoredImpression>()
  readonly #bans = new Map<string, Ban>()
  readonly selector: AdSelector
  readonly ingest: ImpressionIngest
  readonly verifier: Verifier

  constructor(private readonly opts: PipelineOptions) {
    this.selector = new AdSelector({
      clock: opts.clock,
      ids: opts.ids,
      campaigns: opts.campaigns,
      spendableBalance: (advertiserId) => this.spendable(advertiserId),
      spentToday: (campaignId) => this.spentToday(campaignId),
      committedImpressions: (campaignId) => this.committedImpressions(campaignId),
      ...(opts.poolOf ? { poolOf: opts.poolOf } : {}),
      ...(opts.poolAllows ? { poolAllows: opts.poolAllows } : {}),
      ...(opts.reservedForPools ? { reservedForPools: opts.reservedForPools } : {}),
      ...(opts.reserveCpm != null ? { reserveCpm: opts.reserveCpm } : {}),
      ...(opts.persist?.loadTour && opts.persist.saveTour
        ? { tourStore: { load: opts.persist.loadTour, save: opts.persist.saveTour } }
        : {}),
    })

    this.ingest = new ImpressionIngest({
      clock: opts.clock,
      findDelivery: (n) => this.#deliveries.get(n) ?? null,
      seen: (p, id) => this.#impressions.get(this.#key(p, id)) ?? null,
      save: (i) => { this.#update(i) },
      consume: (d) => { this.opts.persist?.saveDelivery(d) },
      minImpressionMs: opts.minImpressionMs,
      minClientVersion: opts.minClientVersion,
    })

    this.verifier = new Verifier({
      clock: opts.clock,
      pendingMs: opts.pendingMs,
      dailyCap: opts.dailyCap,
      countToday: (p, at) => this.#countToday(p, at),
      isDatacenterIp: opts.isDatacenterIp ?? (() => false),
      isBanned: (p) => this.#bans.has(p),
    })

    // Diskteki durumu geri yukle. Yeniden baslatmadan sonra:
    //   • bekleyen gosterimler dogrulanmaya devam eder
    //   • ekranda duran reklamlarin nonce'lari hala taninir
    // Ikincisi olmasaydi, deploy anindaki her gosterim "bilinmeyen nonce"
    // diye reddedilir ve istemci onu kuyrugundan silerdi — kazanc sessizce
    // kaybolurdu.
    if (opts.persist) {
      for (const i of opts.persist.loadImpressions()) {
        this.#impressions.set(this.#key(i.publisherId, i.id), i)
      }
      for (const d of opts.persist.loadDeliveries()) {
        this.#deliveries.set(d.nonce, d)
        // Onceki calismada dolmuslar: hakki geri verildiyse ikinci kez verilmesin.
        if (d.expiresAt < opts.clock.now()) this.#returned.add(d.nonce)
      }
      for (const b of opts.persist.loadBans?.() ?? []) this.#bans.set(b.publisherId, b)
    }
  }

  /**
   * Reklamverenin harcayabilecegi tutar — ADR-021.
   *
   * `bakiye − rezerve`. Rezerve IKI parcadan olusur ve ikisi de gerekli:
   *
   *   1. **Teslim edilmis ama henuz raporlanmamis reklamlar.** Reklam teslim
   *      edildigi anda para taahhut edilmis sayilir. Yalnizca raporlanan
   *      gosterimleri rezerve etseydik, bir istemci butun butceyi asacak
   *      kadar reklam cekip sonra hepsini raporlayabilirdi — teslimat
   *      asamasinda hicbir sinir olmazdi.
   *   2. **`pending` gosterimler.** Borc 24 saat sonra ledger'a yaziliyor;
   *      o pencerede butce serbestmis gibi gorunurdu.
   *
   * Cift sayim yok: gosterim kabul edilince teslimat `consumed` isaretlenir
   * ve birinci parcadan cikar.
   */
  spendable(advertiserId: string): Stroops {
    const balance = this.opts.ledger.balance(accountId('advertiser', advertiserId))
    const now = this.opts.clock.now()
    let reserved = ZERO

    for (const d of this.#deliveries.values()) {
      // Suresi dolmus teslimat rezerve tutmaz — o reklam artik raporlanamaz.
      if (d.advertiserId === advertiserId && !d.consumed && d.expiresAt >= now) {
        reserved = add(reserved, stroops(d.rate))
      }
    }
    for (const i of this.#impressions.values()) {
      if (i.advertiserId === advertiserId && i.state === 'pending') {
        reserved = add(reserved, stroops(i.rateStroops))
      }
    }

    const left = sub(balance, reserved)
    return left > 0n ? left : ZERO
  }

  /**
   * Bir kampanyanin BUGUN harcadigi tutar — PROBLEMS.md #8c.
   *
   * `pending` + `verified` toplanir, yalnizca `verified` DEGIL. Sebep
   * `spendable()`'daki ile ayni: dogrulama `pendingMs` kadar (uretimde
   * 24 saat) gecikiyor, yalnizca `verified` sayilsaydi bir kampanya gun
   * icinde tavanin cok ustune cikip bunu ancak ertesi gun, dogrulama
   * calisinca fark ederdik — tavan o ana kadar hicbir sey yapmamis olurdu.
   *
   * Gun sinirini BELIRLEYEN alan `serverTs` (gosterim raporlandigi an),
   * dogrulamanin NE ZAMAN calistigi degil — dogrulama gecikse bile
   * gosterim dogru gune yazilmis olarak kalir.
   */
  spentToday(campaignId: string): Stroops {
    const now = this.opts.clock.now()
    const dayStart = now - (now % 86_400_000)
    let spent = ZERO
    for (const i of this.#impressions.values()) {
      if (i.campaignId === campaignId
        && (i.state === 'pending' || i.state === 'verified')
        && i.serverTs >= dayStart && i.serverTs < dayStart + 86_400_000) {
        spent = add(spent, stroops(i.rateStroops))
      }
    }
    return spent
  }

  /**
   * NEXT.md §10 — bu kampanyalara yapilmis TUM harcama: teslim edilip henuz
   * raporlanmamis + `pending` + `verified`. `spendable()` ile ayni sebepten
   * teslimat aninda sayiliyor; yoksa havuz butcesi raporlama gecikmesi
   * kadar asilabilirdi.
   *
   * Gosterim kayitlari 90 gun sonra temizleniyor (`vacuumExpired`); havuzlar
   * hackathon suresince yasadigi icin bu yeterli. Daha uzun omurlu havuz
   * gerekirse kaynak defter olmali.
   */
  spentOn(campaignIds: ReadonlySet<string>): Stroops {
    const now = this.opts.clock.now()
    let spent = ZERO
    for (const d of this.#deliveries.values()) {
      if (campaignIds.has(d.campaignId) && !d.consumed && d.expiresAt >= now) spent = add(spent, stroops(d.rate))
    }
    for (const i of this.#impressions.values()) {
      if (campaignIds.has(i.campaignId) && (i.state === 'pending' || i.state === 'verified')) {
        spent = add(spent, stroops(i.rateStroops))
      }
    }
    return spent
  }

  /**
   * Kampanyaya ayrilmis gosterim: defterde faturalanmis + `pending` +
   * teslim edilip raporlanmamis. Faturalanmis kisim DEFTERDEN geliyor;
   * gosterim kayitlari 90 gunde temizlenince sayac geri dusmesin diye.
   */
  committedImpressions(campaignId: string): number {
    const now = this.opts.clock.now()
    let n = this.opts.ledger.billedImpressions(campaignId)
    for (const d of this.#deliveries.values()) {
      if (d.campaignId === campaignId && !d.consumed && d.expiresAt >= now) n++
    }
    for (const i of this.#impressions.values()) {
      if (i.campaignId === campaignId && i.state === 'pending') n++
    }
    return n
  }

  /** Bu yayinciya BUGUN bu kampanyalardan sunulan gosterim sayisi (raporlanmamis teslimatlar dahil). */
  servedToday(publisherId: string, campaignIds: ReadonlySet<string>): number {
    const now = this.opts.clock.now()
    const dayStart = now - (now % 86_400_000)
    let n = 0
    for (const d of this.#deliveries.values()) {
      if (d.publisherId === publisherId && campaignIds.has(d.campaignId) && !d.consumed && d.expiresAt >= now) n++
    }
    for (const i of this.#impressions.values()) {
      if (i.publisherId === publisherId && campaignIds.has(i.campaignId)
        && (i.state === 'pending' || i.state === 'verified') && i.serverTs >= dayStart) n++
    }
    return n
  }

  /** `POST /v1/ads/next` — teslimat kaydedilir ki nonce dogrulanabilsin. */
  serveAd(publisherId: string): AdSelection | null {
    if (this.#bans.has(publisherId)) return null
    this.#returnExpiredSlots(publisherId)
    const sel = this.selector.select(publisherId)
    if (!sel) return null

    const delivery: DeliveredAd = {
      nonce: sel.nonce,
      publisherId,
      campaignId: sel.campaign.id,
      advertiserId: sel.campaign.advertiserId,
      rate: sel.rate,                       // ADR-011 — bu an dondurulur
      revShareBps: sel.campaign.revShareBps,
      expiresAt: sel.nonceExpiresAt,
      consumed: false,
    }
    this.#deliveries.set(sel.nonce, delivery)
    this.opts.persist?.saveDelivery(delivery)
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

  /* ── ban (admin) ── */

  isBanned(publisherId: string): boolean { return this.#bans.has(publisherId) }
  bans(): readonly Ban[] { return [...this.#bans.values()] }

  /**
   * Cuzdani kapatir. Yeni reklam gitmez; bekleyen gosterimleri bir sonraki
   * dogrulama turunda beklemeyi beklemeden reddedilir. Zaten onaylanmis
   * kazanc ledger'da kalir — cekimi HTTP katmani kapatir.
   */
  ban(publisherId: string, reason: string): Ban {
    const b: Ban = { publisherId, reason, at: this.opts.clock.now() }
    this.#bans.set(publisherId, b)
    this.opts.persist?.saveBans?.(this.bans())
    return b
  }

  unban(publisherId: string): boolean {
    const had = this.#bans.delete(publisherId)
    if (had) this.opts.persist?.saveBans?.(this.bans())
    return had
  }

  /* ── ic isler ── */

  #key = (publisherId: string, id: string): string => `${publisherId}|${id}`

  #update(imp: StoredImpression): void {
    this.#impressions.set(this.#key(imp.publisherId, imp.id), imp)
    this.opts.persist?.saveImpression(imp)
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
  /** Bkz. `AdSelector.returnSlots`. Teslimatlar sunum sirasinda, sira korunur. */
  #returnExpiredSlots(publisherId: string): void {
    const now = this.opts.clock.now()
    const ids: string[] = []
    for (const d of this.#deliveries.values()) {
      if (d.publisherId === publisherId && !d.consumed && d.expiresAt < now && !this.#returned.has(d.nonce)) {
        this.#returned.add(d.nonce)
        ids.push(d.campaignId)
      }
    }
    this.selector.returnSlots(publisherId, ids)
  }

  #gcDeliveries(): void {
    const now = this.opts.clock.now()
    for (const [nonce, d] of this.#deliveries) {
      if (d.expiresAt < now - 3600_000) {
        this.#deliveries.delete(nonce)
        this.#returned.delete(nonce)
      }
    }
  }
}
