/**
 * Gosterim kabulu — ADR-004, ADR-011, §9, §10.
 *
 * Olcum istemci-raporludur ve bu KABUL EDILIYOR. Sunucu "12 saniye
 * gosterildi" iddiasini dogrulayamaz; istemci kullanicinin makinesinde
 * calisir ve degistirilebilir. Amac fraud'u sifirlamak degil, MALIYETINI
 * kazancin ustune cikarmak.
 *
 * Bu katmanin isi: ucuz saldirilari kesmek ve her gosterimi
 * `pending` olarak kaydetmek. Dogrulama sonra, odemeden once (§9 katman 2).
 */

import { type Stroops, stroops } from '@dwell/protocol'
import type { Clock, ImpressionEvent } from '@dwell/protocol'

export type ImpressionState = 'pending' | 'verified' | 'rejected'

export interface StoredImpression {
  readonly id: string
  readonly publisherId: string
  readonly campaignId: string
  readonly advertiserId: string
  readonly sessionId: string
  readonly nonce: string
  readonly durationMs: number
  /** ADR-011 — gosterim aninda dondurulan fiyat. Bir daha degismez. */
  readonly rateStroops: Stroops
  /** ADR-011 — pay orani da dondurulur; kampanya sonradan degisebilir. */
  readonly revShareBps: number
  readonly clientTs: number
  readonly serverTs: number
  readonly projectKey: string
  readonly clientVersion: string
  readonly ipHash: string | null
  readonly state: ImpressionState
  readonly rejectReason: string | null
}

/** Sunucunun teslim ettigi reklamin kaydi — nonce dogrulamasi icin. */
export interface DeliveredAd {
  readonly nonce: string
  readonly publisherId: string
  readonly campaignId: string
  readonly advertiserId: string
  readonly rate: Stroops
  readonly revShareBps: number
  readonly expiresAt: number
  consumed: boolean
}

export interface IngestDeps {
  readonly clock: Clock
  /** Teslim edilen reklami nonce ile bulur. */
  readonly findDelivery: (nonce: string) => DeliveredAd | null
  /** `(publisherId, impressionId)` daha once gorulmus mu? */
  readonly seen: (publisherId: string, impressionId: string) => StoredImpression | null
  readonly save: (imp: StoredImpression) => void
  readonly minImpressionMs: number
  /** ADR-016 — bu surumun altindaki istemciler reddedilir. */
  readonly minClientVersion: string
}

export interface IngestResult {
  readonly accepted: readonly string[]
  readonly rejected: readonly { id: string; reason: string }[]
  /** Zaten kayitli olanlar — hata degil, idempotency. */
  readonly duplicates: readonly string[]
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('-')[0]!.split('.').map(Number)
  const pb = b.split('-')[0]!.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

export class ImpressionIngest {
  constructor(private readonly deps: IngestDeps) {}

  ingest(
    publisherId: string,
    events: readonly ImpressionEvent[],
    meta: { ipHash?: string | null } = {},
  ): IngestResult {
    const accepted: string[] = []
    const rejected: { id: string; reason: string }[] = []
    const duplicates: string[] = []

    for (const ev of events) {
      // Idempotency — ADR-004.
      //
      // Tekillik `(publisherId, id)` uzerinde, tablo genelinde DEGIL. ULID
      // istemcide uretiliyor, yani dusman girdisi: global tekillik olsaydi
      // kotu niyetli bir istemci baskasinin ULID'ini gonderip onun kaydini
      // "zaten var" durumuna dusurebilirdi.
      const existing = this.deps.seen(publisherId, ev.id)
      if (existing) { duplicates.push(ev.id); continue }

      const reason = this.#validate(publisherId, ev)
      if (reason) {
        // Reddedilen gosterim de KAYDEDILIR. Red orani fraud pipeline'inin
        // girdisi (§9) ve reklamveren faturalanmaz cunku state 'rejected'.
        const delivery = this.deps.findDelivery(ev.nonce)
        this.deps.save(this.#build(publisherId, ev, delivery, meta, 'rejected', reason))
        rejected.push({ id: ev.id, reason })
        continue
      }

      const delivery = this.deps.findDelivery(ev.nonce)!
      delivery.consumed = true                       // replay'i keser
      this.deps.save(this.#build(publisherId, ev, delivery, meta, 'pending', null))
      accepted.push(ev.id)
    }

    return { accepted, rejected, duplicates }
  }

  /** Ucuz kontroller. Pahali olanlar (anomali, tavan) dogrulama asamasinda. */
  #validate(publisherId: string, ev: ImpressionEvent): string | null {
    // ADR-016: eski istemciler reddedilir. Olcum veya odeme protokolunde bir
    // hata bulunursa yalnizca hatali surumleri devre disi birakabilmeliyiz.
    if (compareVersions(ev.clientVersion, this.deps.minClientVersion) < 0) {
      return `istemci surumu cok eski: ${ev.clientVersion} < ${this.deps.minClientVersion}`
    }

    // ADR-001: yalnizca statusline olculebilir. Spinner'dan gelen bir gosterim
    // raporu ya bug ya saldiri — ikisi de reddedilir.
    if (ev.surface !== 'statusline') {
      return `olculemez yuzey: ${ev.surface}`
    }

    if (ev.durationMs < this.deps.minImpressionMs) {
      return `sure ${ev.durationMs}ms < ${this.deps.minImpressionMs}ms`
    }

    const delivery = this.deps.findDelivery(ev.nonce)
    if (!delivery) return 'nonce bilinmiyor'
    if (delivery.consumed) return 'nonce zaten kullanilmis'
    if (delivery.expiresAt < this.deps.clock.now()) return 'nonce suresi dolmus'
    if (delivery.publisherId !== publisherId) return 'nonce baska publisher\'a ait'
    if (delivery.campaignId !== ev.campaignId) return 'nonce baska kampanyaya ait'

    // Saat tutarliligi: istemcinin saati cok ileriyse veya cok geridiyse
    // ya bozuk ya kurcalanmis.
    const now = this.deps.clock.now()
    const skew = Math.abs(now - ev.clientTs)
    if (skew > 24 * 3600_000) return `saat sapmasi ${Math.round(skew / 60_000)}dk`

    return null
  }

  #build(
    publisherId: string,
    ev: ImpressionEvent,
    delivery: DeliveredAd | null,
    meta: { ipHash?: string | null },
    state: ImpressionState,
    rejectReason: string | null,
  ): StoredImpression {
    return {
      id: ev.id,
      publisherId,
      campaignId: ev.campaignId,
      advertiserId: delivery?.advertiserId ?? '',
      sessionId: ev.sessionId,
      nonce: ev.nonce,
      durationMs: ev.durationMs,
      // Fiyat teslim aninda donduruldu — istemciden GELMEZ, gelemez.
      rateStroops: delivery?.rate ?? stroops(0n),
      revShareBps: delivery?.revShareBps ?? 0,
      clientTs: ev.clientTs,
      serverTs: this.deps.clock.now(),
      projectKey: ev.projectKey,
      clientVersion: ev.clientVersion,
      ipHash: meta.ipHash ?? null,
      state,
      rejectReason,
    }
  }
}
