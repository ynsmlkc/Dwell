/**
 * Reklam secimi — ADR-009 + ADR-021.
 *
 * Gercek acik artirma motoru YOK. Teklif sirali secim ve butce kontrolu
 * yeterli; talep tarafinda 3-5 kampanya varken auction yazmak kod borcudur.
 * Arayuz korunuyor, ici sonradan doldurulabilir.
 */

import { type Stroops, stroops, rateFromCpm } from '@dwell/protocol'
import type { Creative, IdGenerator, Clock } from '@dwell/protocol'

export type CampaignStatus = 'active' | 'paused' | 'suspended' | 'exhausted'

export interface Campaign {
  readonly id: string
  readonly advertiserId: string
  /** Teklif CPM cinsinden — 1.000 gosterim (ADR-009). */
  readonly bidCpm: Stroops
  /** Gosterim aninda dondurulacak pay orani (ADR-011). */
  readonly revShareBps: number
  readonly creative: Creative
  readonly status: CampaignStatus
  /** Ayni reklam ardisik kac gosterimde tekrar etmesin. */
  readonly frequencyCap: number
}

export interface AdSelection {
  readonly campaign: Campaign
  readonly nonce: string
  readonly nonceExpiresAt: number
  /** ADR-011 — bu ANIN fiyati, gosterim kaydina donacak. */
  readonly rate: Stroops
}

export interface SelectorDeps {
  readonly clock: Clock
  readonly ids: IdGenerator
  readonly campaigns: () => readonly Campaign[]
  /**
   * Reklamverenin harcanabilir bakiyesi (ADR-021).
   * Ledger'dan gelir; `balance − reserved`.
   */
  readonly spendableBalance: (advertiserId: string) => Stroops
  readonly nonceTtlMs?: number
}

/** Nonce omru. Kisa: replay penceresini daraltir. */
export const DEFAULT_NONCE_TTL_MS = 5 * 60_000

export class AdSelector {
  readonly #recentByPublisher = new Map<string, string[]>()

  constructor(private readonly deps: SelectorDeps) {}

  /**
   * Bu publisher icin sirada hangi reklam var?
   *
   * `null` donerse HICBIR SEY gosterilmez. Bos bir reklam gostermektense
   * susmak dogrudur (ADR-003).
   */
  select(publisherId: string): AdSelection | null {
    const eligible = this.deps.campaigns()
      .filter((c) => c.status === 'active')
      // ADR-021: parasi olmayan kampanya servis EDILMEZ. Bu kontrol olmadan
      // butce sinirsiz asilir ve acigi platform kapatir.
      .filter((c) => this.deps.spendableBalance(c.advertiserId) > 0n)
      // Gosterim basina oran sifira dusuyorsa satacak bir sey yok.
      .filter((c) => rateFromCpm(c.bidCpm) > 0n)
      .sort((a, b) => (b.bidCpm > a.bidCpm ? 1 : b.bidCpm < a.bidCpm ? -1 : 0))

    if (eligible.length === 0) return null

    const recent = this.#recentByPublisher.get(publisherId) ?? []
    // Frekans kurali: ardisik tekrar etmesin. Havuz tukenirse kurali
    // gevsetiyoruz — reklam gostermemektense tekrar etmek iyidir.
    const fresh = eligible.filter((c) => !recent.slice(-c.frequencyCap).includes(c.id))
    const chosen = fresh[0] ?? eligible[0]!

    const rate = rateFromCpm(chosen.bidCpm)
    const spendable = this.deps.spendableBalance(chosen.advertiserId)
    // Kalan bakiye bir gosterimi bile karsilamiyorsa servis etme.
    if (spendable < rate) return null

    this.#remember(publisherId, chosen.id)

    return {
      campaign: chosen,
      nonce: this.deps.ids.randomHex(16),
      nonceExpiresAt: this.deps.clock.now() + (this.deps.nonceTtlMs ?? DEFAULT_NONCE_TTL_MS),
      rate,
    }
  }

  #remember(publisherId: string, campaignId: string): void {
    const list = this.#recentByPublisher.get(publisherId) ?? []
    list.push(campaignId)
    if (list.length > 32) list.shift()
    this.#recentByPublisher.set(publisherId, list)
  }
}
