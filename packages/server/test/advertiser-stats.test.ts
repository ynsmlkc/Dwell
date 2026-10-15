/**
 * Reklamveren istatistikleri.
 *
 * Korunan seyler: baska reklamverenin gosterimi sayilmaz, reddedilen
 * gosterim harcama ve erisime girmez, harcama yalnizca `verified`ten gelir,
 * gunluk seri dogru gune duser.
 */

import { describe, it, expect } from 'vitest'
import { stroops } from '@dwell/protocol'
import { advertiserStats } from '../src/advertisers/stats.js'
import type { StoredImpression, ImpressionState } from '../src/impressions/ingest.js'

const DAY = 86_400_000
const NOW = 100 * DAY + 5 * 3600_000
let seq = 0

const imp = (o: {
  campaignId?: string; advertiserId?: string; publisherId?: string
  state?: ImpressionState; rate?: bigint; at?: number
}): StoredImpression => ({
  id: `i${seq++}`, publisherId: o.publisherId ?? 'pub-a', campaignId: o.campaignId ?? 'c1',
  advertiserId: o.advertiserId ?? 'adv', sessionId: 's', nonce: `n${seq}`, durationMs: 10_000,
  rateStroops: stroops(o.rate ?? 10_000n), revShareBps: 5000, clientTs: o.at ?? NOW,
  serverTs: o.at ?? NOW, projectKey: 'p', clientVersion: '0.1.14', ipHash: null,
  state: o.state ?? 'verified', rejectReason: o.state === 'rejected' ? 'x' : null,
})

describe('advertiserStats', () => {
  it('yalnizca kendi gosterimlerini sayar', () => {
    const s = advertiserStats([imp({}), imp({ advertiserId: 'baska' })], 'adv', NOW)
    expect(s.totals.verified).toBe(1)
    expect(s.campaigns).toHaveLength(1)
  })

  it('harcama yalnizca verified; pending ayri, rejected hicbir yere girmez', () => {
    const s = advertiserStats([
      imp({ rate: 10_000n }),
      imp({ state: 'pending', rate: 20_000n, publisherId: 'pub-b' }),
      imp({ state: 'rejected', rate: 40_000n, publisherId: 'pub-c' }),
    ], 'adv', NOW)
    expect(s.totals).toEqual({
      verified: 1, pending: 1, rejected: 1,
      spentStroops: '10000', pendingStroops: '20000', reach: 2,
    })
  })

  it('erisim farkli yayinci sayisi; kampanya ve toplam ayri hesaplanir', () => {
    const s = advertiserStats([
      imp({ publisherId: 'a' }), imp({ publisherId: 'a' }), imp({ publisherId: 'b' }),
      imp({ publisherId: 'a', campaignId: 'c2' }),
    ], 'adv', NOW)
    expect(s.campaigns.find((c) => c.campaignId === 'c1')?.reach).toBe(2)
    expect(s.campaigns.find((c) => c.campaignId === 'c2')?.reach).toBe(1)
    expect(s.totals.reach).toBe(2)
  })

  it('gunluk seri: son gun bugun, bos gunler sifir, pencere disi sayilmaz', () => {
    const s = advertiserStats([
      imp({ at: NOW }),
      imp({ at: NOW - DAY, state: 'pending' }),
      imp({ at: NOW - 40 * DAY }),
    ], 'adv', NOW, 7)
    expect(s.daily).toHaveLength(7)
    expect(s.daily[6]).toEqual({ day: 100 * DAY, impressions: 1, spentStroops: '10000' })
    // pending gosterim sayilir ama harcamaya girmez
    expect(s.daily[5]).toEqual({ day: 99 * DAY, impressions: 1, spentStroops: '0' })
    expect(s.daily.slice(0, 5).every((d) => d.impressions === 0)).toBe(true)
    // pencere disi gosterim toplamda var, seride yok
    expect(s.totals.verified).toBe(2)
  })

  it('son gosterim zamani', () => {
    const s = advertiserStats([imp({ at: NOW - DAY }), imp({ at: NOW - 2 * DAY })], 'adv', NOW)
    expect(s.campaigns[0]?.lastImpressionAt).toBe(NOW - DAY)
  })
})
