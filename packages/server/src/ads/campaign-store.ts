/**
 * Kampanyalar — reklamverenin kendi olusturdugu.
 *
 * Onceden `main.ts` icinde sabit bir diziydi; kampanya eklemek deploy
 * gerektiriyordu. Artik reklamveren kendisi olusturuyor.
 *
 * ADR-024: reklamveren tarafi ACIK, icerik kapisi yok. Kontrol edilen tek
 * sey BUTUNLUK: metinde yazan alan adi ile tiklama hedefi ayni olmali.
 * "Bu reklam uygun mu" sorusunu sormuyoruz; "bu reklam yalan soyluyor mu"
 * sorusunu soruyoruz.
 */

import { assertClean, type Stroops, type Creative } from '@dwell/protocol'
import type { Clock } from '@dwell/protocol'
import type { Campaign, CampaignStatus } from './selector.js'
import type { Db } from '../store/db.js'

export interface CampaignInput {
  readonly advertiserId: string
  readonly brand: string
  readonly text: string
  /** Gosterilecek alan adi. Tiklama hedefi de burasi olmak zorunda. */
  readonly cta: string
  readonly bidCpm: Stroops
}

// DIKKAT: `revShareBps` burada YOK ve olmayacak.
//
// Yayinci payi platformun karari (ADR-011). Girdide kabul etseydik, bir gun
// biri onu uc noktadan gecirir ve reklamveren payi sifira cekip yayinciya
// hicbir sey odemeden reklam gosterebilirdi.

export type CampaignError =
  | { readonly ok: false; readonly reason: string; readonly field?: string }

export type CampaignResult =
  | { readonly ok: true; readonly campaign: Campaign }
  | CampaignError

/** Yayinci payi. Sabit — reklamveren pazarlik edemez (ADR-011). */
export const DEFAULT_REV_SHARE_BPS = 5000

/** Taban teklif: 1.000 gosterim icin en az $0,10. */
export const MIN_BID_CPM: Stroops = 1_000_000n as Stroops

/**
 * Satirin toplam uzunlugu.
 *
 * statusLine dar terminallerde kesiliyor; 80 karakteri asan bir reklam
 * kullanicinin gordugu yerde yarim kalir ve alan adi kaybolur — yani
 * reklamveren parasini odedigi seyi alamaz.
 */
export const MAX_LINE_LENGTH = 80

export class CampaignStore {
  readonly #byId = new Map<string, Campaign>()

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly newId: () => string,
  ) {
    for (const r of this.db.prepare('SELECT * FROM campaigns').all() as any[]) {
      this.#byId.set(String(r.id), {
        id: String(r.id),
        advertiserId: String(r.advertiser_id),
        bidCpm: BigInt(r.bid_cpm) as Stroops,
        revShareBps: Number(r.rev_share_bps),
        creative: { brand: String(r.brand), text: String(r.text), cta: String(r.cta) },
        status: String(r.status) as CampaignStatus,
        frequencyCap: Number(r.frequency_cap),
      })
    }
  }

  all(): readonly Campaign[] { return [...this.#byId.values()] }

  forAdvertiser(advertiserId: string): readonly Campaign[] {
    return this.all().filter((c) => c.advertiserId === advertiserId)
  }

  get(id: string): Campaign | null { return this.#byId.get(id) ?? null }

  create(input: CampaignInput): CampaignResult {
    const dogrulama = validateCreative(input)
    if (!dogrulama.ok) return dogrulama

    if (input.bidCpm < MIN_BID_CPM) {
      return { ok: false, reason: `teklif en az ${MIN_BID_CPM} stroop olmali`, field: 'bidCpm' }
    }

    const campaign: Campaign = {
      id: `c-${this.newId()}`,
      advertiserId: input.advertiserId,
      bidCpm: input.bidCpm,
      revShareBps: DEFAULT_REV_SHARE_BPS,
      creative: { brand: input.brand.trim(), text: input.text.trim(), cta: input.cta.trim().toLowerCase() },
      // Yeni kampanya DURDURULMUS baslar.
      //
      // Reklamveren metnini gozden gecirip kendisi baslatir. Otomatik
      // yayina almak, yazim hatasiyla dolu bir reklamin binlerce kisiye
      // gosterilmesi demek — ve gosterim geri alinamaz, parasi odenmistir.
      status: 'paused',
      frequencyCap: 1,
    }

    this.#write(campaign)
    this.#byId.set(campaign.id, campaign)
    return { ok: true, campaign }
  }

  /** Durum degistirir. Baskasinin kampanyasina dokunulamaz. */
  setStatus(id: string, advertiserId: string, status: CampaignStatus): CampaignResult {
    const c = this.#byId.get(id)
    if (!c) return { ok: false, reason: 'kampanya bulunamadi' }
    // Sahiplik kontrolu BURADA, HTTP katmaninda degil: yetki kontrolunu
    // uc noktaya birakmak, yeni bir uc eklendiginde unutulmasi demek.
    if (c.advertiserId !== advertiserId) return { ok: false, reason: 'kampanya bulunamadi' }

    const yeni = { ...c, status }
    this.#write(yeni)
    this.#byId.set(id, yeni)
    return { ok: true, campaign: yeni }
  }

  #write(c: Campaign): void {
    this.db.prepare(`
      INSERT INTO campaigns
        (id, advertiser_id, bid_cpm, rev_share_bps, brand, text, cta, status, frequency_cap, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        bid_cpm = excluded.bid_cpm, brand = excluded.brand, text = excluded.text,
        cta = excluded.cta, status = excluded.status
    `).run(
      c.id, c.advertiserId, c.bidCpm.toString(), c.revShareBps,
      c.creative.brand, c.creative.text, c.creative.cta ?? '', c.status, c.frequencyCap,
      this.clock.now(),
    )
  }
}

/**
 * Reklam metni kontrolu — ADR-024.
 *
 * Icerik yargilanmıyor. Yalnizca su sorular:
 *   • terminali bozar mi?          (kacis dizisi, kontrol karakteri)
 *   • satira sigar mi?             (80 karakter)
 *   • gosterdigi yere mi gidiyor?  (alan adi butunlugu)
 */
export function validateCreative(input: {
  brand: string; text: string; cta: string
}): { ok: true } | CampaignError {
  const brand = input.brand.trim()
  const text = input.text.trim()
  const cta = input.cta.trim().toLowerCase()

  if (!brand) return { ok: false, reason: 'marka adi bos olamaz', field: 'brand' }
  if (!text) return { ok: false, reason: 'metin bos olamaz', field: 'text' }
  if (!cta) return { ok: false, reason: 'alan adi bos olamaz', field: 'cta' }

  // §7 — kacis dizisi ve kontrol karakteri REDDEDILIR, temizlenmez.
  // Temizlemek "ne demek istedigini tahmin etmek"tir; reddetmek durustur.
  try {
    assertClean({ brand, text, cta })
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : 'gecersiz karakter' }
  }

  // Gorunecek satirin tamami: "✶ Marka — metin · alan.com"
  const satir = `✶ ${brand} — ${text} · ${cta}`
  if (satir.length > MAX_LINE_LENGTH) {
    return {
      ok: false,
      reason: `satir ${satir.length} karakter, en fazla ${MAX_LINE_LENGTH} olabilir`,
      field: 'text',
    }
  }

  // Alan adi biciminde mi? Tam URL degil, yalnizca alan adi istiyoruz:
  // kullanici satirda ne goruyorsa tiklayinca oraya gitmeli.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(cta)) {
    return {
      ok: false,
      reason: 'alan adi gecersiz — yalnizca alan adi yaz (ornek: firecrawl.dev)',
      field: 'cta',
    }
  }

  return { ok: true }
}
