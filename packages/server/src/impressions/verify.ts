/**
 * Dogrulama boru hatti — §9.
 *
 * `pending` → `verified` | `rejected`. Ledger kaydi YALNIZCA `verified`
 * icin yazilir; `rejected` gosterim reklamvereni faturalandirmaz.
 *
 * Neden bekleme suresi zorunlu (§9 katman 2): zincir ustu odeme geri
 * alinamaz. Anomali tespitinin para cikmadan ONCE calismasi sart — bu
 * opsiyonel bir gecikme degil, mimarinin gereği.
 */

import { type Stroops, stroops, add, ZERO } from '@dwell/protocol'
import type { Clock } from '@dwell/protocol'
import type { StoredImpression } from './ingest.js'

export interface VerifyDeps {
  readonly clock: Clock
  /** Bekleme suresi. Bu sure dolmadan hicbir gosterim dogrulanmaz. */
  readonly pendingMs: number
  /** Hesap basina gunluk gosterim tavani. */
  readonly dailyCap: number
  /** Ayni gun icinde bu publisher'in kac dogrulanmis gosterimi var? */
  readonly countToday: (publisherId: string, at: number) => number
  /** IP datacenter araliginda mi? */
  readonly isDatacenterIp: (ipHash: string | null) => boolean
}

export type VerifyOutcome =
  | { readonly state: 'verified'; readonly impression: StoredImpression }
  | { readonly state: 'rejected'; readonly impression: StoredImpression; readonly reason: string }
  | { readonly state: 'pending'; readonly impression: StoredImpression; readonly readyAt: number }

export class Verifier {
  constructor(private readonly deps: VerifyDeps) {}

  /** Tek bir gosterimi degerlendirir. Yan etkisi yok — karar dondurur. */
  evaluate(imp: StoredImpression, siblings: readonly StoredImpression[]): VerifyOutcome {
    if (imp.state !== 'pending') {
      return imp.state === 'verified'
        ? { state: 'verified', impression: imp }
        : { state: 'rejected', impression: imp, reason: imp.rejectReason ?? 'zaten reddedilmis' }
    }

    const readyAt = imp.serverTs + this.deps.pendingMs
    if (this.deps.clock.now() < readyAt) {
      return { state: 'pending', impression: imp, readyAt }
    }

    const reason = this.#anomaly(imp, siblings)
    return reason
      ? { state: 'rejected', impression: imp, reason }
      : { state: 'verified', impression: imp }
  }

  /**
   * MVP'de uc kural. ML motoru YAZILMAYACAK — bu asamada uc SQL kurali
   * yeterli ve ML'in yakalayacagi seyler icin henuz veri yok.
   */
  #anomaly(imp: StoredImpression, siblings: readonly StoredImpression[]): string | null {
    // 1. Gunluk tavan (§9 katman 3). VM olcekleme ekonomisini bozar.
    if (this.deps.countToday(imp.publisherId, imp.serverTs) >= this.deps.dailyCap) {
      return `gunluk tavan asildi (${this.deps.dailyCap})`
    }

    // 2. Datacenter IP (§9 katman 4). Duvar degil, hiz kasisi.
    if (this.deps.isDatacenterIp(imp.ipHash)) {
      return 'datacenter IP'
    }

    // 3. Insanustu duzenli aralik (§9 katman 5).
    //
    // Gercek bir oturumun kaotik bir ritmi vardir: model bazen 8 saniye
    // bazen 90 saniye dusunur. Sentetik trafik duzenlidir. Ayni oturumdaki
    // ardisik gosterimlerin araligi neredeyse sabitse bu bir bot isaretidir.
    const sameSession = siblings
      .filter((s) => s.sessionId === imp.sessionId && s.id !== imp.id)
      .map((s) => s.serverTs)
      .concat(imp.serverTs)
      .sort((a, b) => a - b)

    if (sameSession.length >= 6) {
      const gaps = sameSession.slice(1).map((t, i) => t - sameSession[i]!)
      const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length
      if (mean > 0) {
        const variance = gaps.reduce((s, g) => s + (g - mean) ** 2, 0) / gaps.length
        const cv = Math.sqrt(variance) / mean          // degisim katsayisi
        if (cv < 0.05) return `insanustu duzenli aralik (cv=${cv.toFixed(3)})`
      }
    }

    return null
  }
}

/** Dogrulanmis gosterimlerin toplam degeri — raporlama icin. */
export const totalValue = (imps: readonly StoredImpression[]): Stroops =>
  imps.reduce((t, i) => add(t, stroops(i.rateStroops)), ZERO)
