/**
 * Reklamveren istatistikleri — panelin "ne aldim" sorusunun cevabi.
 *
 * Kaynak gosterim kayitlari, defter DEGIL: defter kampanya basina gunluk
 * dagilimi tutmuyor ve `pending` gosterimleri hic gormuyor. Bedeli su:
 * gosterimler 90 gun sonra temizleniyor (`vacuumExpired`), bu yuzden
 * buradaki "toplam" son 90 gunun toplami. Panel bunu acikca soyluyor.
 *
 * Harcama yalnizca `verified` gosterimlerden: reklamverenden gercekten
 * dusen para bu. `pending` ayri gosteriliyor, `rejected` hic harcanmadi.
 */

import type { StoredImpression } from '../impressions/ingest.js'

const DAY = 86_400_000

export interface CampaignStats {
  readonly campaignId: string
  readonly verified: number
  readonly pending: number
  readonly rejected: number
  readonly spentStroops: string
  readonly pendingStroops: string
  /** Bu kampanyayi en az bir kez goren farkli yayinci sayisi. */
  readonly reach: number
  readonly lastImpressionAt: number | null
}

export interface DailyPoint {
  /** Gunun baslangici, UTC ms. */
  readonly day: number
  readonly impressions: number
  readonly spentStroops: string
}

export interface AdvertiserStats {
  readonly totals: {
    readonly verified: number
    readonly pending: number
    readonly rejected: number
    readonly spentStroops: string
    readonly pendingStroops: string
    readonly reach: number
  }
  readonly campaigns: readonly CampaignStats[]
  /** Son `days` gun, eskiden yeniye, bos gunler sifirla dolu. */
  readonly daily: readonly DailyPoint[]
  readonly retentionDays: number
}

export function advertiserStats(
  impressions: readonly StoredImpression[],
  advertiserId: string,
  now: number,
  days = 30,
): AdvertiserStats {
  const today = now - (now % DAY)
  const first = today - (days - 1) * DAY

  const per = new Map<string, {
    verified: number; pending: number; rejected: number
    spent: bigint; pendingSpent: bigint; reach: Set<string>; last: number | null
  }>()
  const allReach = new Set<string>()
  const dayImp = new Array<number>(days).fill(0)
  const daySpent = new Array<bigint>(days).fill(0n)

  for (const i of impressions) {
    if (i.advertiserId !== advertiserId) continue
    let s = per.get(i.campaignId)
    if (!s) {
      s = { verified: 0, pending: 0, rejected: 0, spent: 0n, pendingSpent: 0n, reach: new Set(), last: null }
      per.set(i.campaignId, s)
    }
    const rate = BigInt(i.rateStroops)
    if (i.state === 'rejected') { s.rejected++; continue }
    if (i.state === 'verified') { s.verified++; s.spent += rate }
    else { s.pending++; s.pendingSpent += rate }
    s.reach.add(i.publisherId)
    allReach.add(i.publisherId)
    s.last = Math.max(s.last ?? 0, i.serverTs)

    if (i.serverTs >= first) {
      const k = Math.floor((i.serverTs - first) / DAY)
      if (k < days) {
        dayImp[k]!++
        if (i.state === 'verified') daySpent[k]! += rate
      }
    }
  }

  const campaigns = [...per.entries()].map(([campaignId, s]): CampaignStats => ({
    campaignId,
    verified: s.verified, pending: s.pending, rejected: s.rejected,
    spentStroops: s.spent.toString(), pendingStroops: s.pendingSpent.toString(),
    reach: s.reach.size, lastImpressionAt: s.last,
  }))

  const sum = (f: (c: CampaignStats) => number) => campaigns.reduce((a, c) => a + f(c), 0)
  const sumBig = (f: (c: CampaignStats) => string) => campaigns.reduce((a, c) => a + BigInt(f(c)), 0n)

  return {
    totals: {
      verified: sum((c) => c.verified),
      pending: sum((c) => c.pending),
      rejected: sum((c) => c.rejected),
      spentStroops: sumBig((c) => c.spentStroops).toString(),
      pendingStroops: sumBig((c) => c.pendingStroops).toString(),
      reach: allReach.size,
    },
    campaigns,
    daily: dayImp.map((n, k) => ({ day: first + k * DAY, impressions: n, spentStroops: daySpent[k]!.toString() })),
    retentionDays: 90,
  }
}
