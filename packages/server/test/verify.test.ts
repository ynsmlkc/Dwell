import { describe, it, expect, beforeEach } from 'vitest'
import { fixedClock, stroops } from '@dwell/protocol'
import { Verifier } from '../src/impressions/verify.js'
import type { StoredImpression } from '../src/impressions/ingest.js'

const PENDING_MS = 24 * 3600_000

let clock: ReturnType<typeof fixedClock>
let todayCount = 0
let datacenter = false
let v: Verifier

beforeEach(() => {
  clock = fixedClock(1_700_000_000_000)
  todayCount = 0
  datacenter = false
  v = new Verifier({
    clock, pendingMs: PENDING_MS, dailyCap: 400,
    countToday: () => todayCount,
    isDatacenterIp: () => datacenter,
  })
})

const imp = (over: Partial<StoredImpression> = {}): StoredImpression => ({
  id: 'i1', publisherId: 'p1', campaignId: 'c1', advertiserId: 'a1',
  sessionId: 's1', nonce: 'n'.repeat(32), durationMs: 15_000,
  rateStroops: stroops(300_000n), revShareBps: 5000,
  clientTs: clock.now(), serverTs: clock.now(),
  projectKey: 'f'.repeat(64), clientVersion: '1.0.0', ipHash: 'hash',
  state: 'pending', rejectReason: null,
  ...over,
})

describe('§9 katman 2 — bekleme suresi zorunlu', () => {
  it('sure dolmadan dogrulanmaz', () => {
    const r = v.evaluate(imp(), [])
    expect(r.state).toBe('pending')
    if (r.state === 'pending') expect(r.readyAt).toBe(clock.now() + PENDING_MS)
  })

  it('sure dolunca dogrulanir', () => {
    const i = imp()
    clock.advance(PENDING_MS + 1)
    expect(v.evaluate(i, []).state).toBe('verified')
  })

  it('bir milisaniye eksikse hala bekliyor', () => {
    const i = imp()
    clock.advance(PENDING_MS - 1)
    expect(v.evaluate(i, []).state).toBe('pending')
  })
})

describe('§9 katman 3 — gunluk tavan', () => {
  it('tavan asilmissa reddedilir', () => {
    const i = imp()
    clock.advance(PENDING_MS + 1)
    todayCount = 400
    const r = v.evaluate(i, [])
    expect(r.state).toBe('rejected')
    if (r.state === 'rejected') expect(r.reason).toMatch(/gunluk tavan/)
  })

  it('tavanin altinda gecer', () => {
    const i = imp()
    clock.advance(PENDING_MS + 1)
    todayCount = 399
    expect(v.evaluate(i, []).state).toBe('verified')
  })
})

describe('§9 katman 4 — datacenter IP', () => {
  it('datacenter IP reddedilir', () => {
    const i = imp()
    clock.advance(PENDING_MS + 1)
    datacenter = true
    const r = v.evaluate(i, [])
    expect(r.state).toBe('rejected')
    if (r.state === 'rejected') expect(r.reason).toBe('datacenter IP')
  })
})

describe('§9 katman 5 — insanustu duzenli aralik', () => {
  const series = (gaps: number[]): StoredImpression[] => {
    let t = clock.now()
    return gaps.map((g, k) => {
      t += g
      return imp({ id: `s${k}`, serverTs: t })
    })
  }

  it('metronom gibi duzenli trafik reddedilir', () => {
    // Her 20 saniyede bir, milisaniye sapmasiz. Insan boyle calismaz.
    const sib = series([20_000, 20_000, 20_000, 20_000, 20_000, 20_000])
    const target = sib.at(-1)!
    clock.advance(PENDING_MS + 200_000)
    const r = v.evaluate(target, sib)
    expect(r.state).toBe('rejected')
    if (r.state === 'rejected') expect(r.reason).toMatch(/insanustu duzenli/)
  })

  it('gercek oturumun kaotik ritmi gecer', () => {
    // Ölçümden gelen gercek dagilima benzer: 8sn, 51sn, 12sn, 113sn...
    const sib = series([8_000, 51_000, 12_000, 113_000, 7_000, 34_000])
    const target = sib.at(-1)!
    clock.advance(PENDING_MS + 300_000)
    expect(v.evaluate(target, sib).state).toBe('verified')
  })

  it('az veri varken kural calismaz — yanlis pozitif uretmesin', () => {
    const sib = series([20_000, 20_000])
    const target = sib.at(-1)!
    clock.advance(PENDING_MS + 100_000)
    expect(v.evaluate(target, sib).state).toBe('verified')
  })

  it('farkli oturumlar birbirine karismaz', () => {
    const sib = series([20_000, 20_000, 20_000, 20_000, 20_000, 20_000])
      .map((s, k) => ({ ...s, sessionId: `oturum-${k}` }))
    const target = imp({ serverTs: clock.now() + 200_000 })
    clock.advance(PENDING_MS + 300_000)
    expect(v.evaluate(target, sib).state).toBe('verified')
  })
})

describe('durum degismezligi', () => {
  it('zaten dogrulanmis kayit yeniden degerlendirilmez', () => {
    expect(v.evaluate(imp({ state: 'verified' }), []).state).toBe('verified')
  })

  it('zaten reddedilmis kayit sebebini korur', () => {
    const r = v.evaluate(imp({ state: 'rejected', rejectReason: 'nonce bilinmiyor' }), [])
    expect(r.state).toBe('rejected')
    if (r.state === 'rejected') expect(r.reason).toBe('nonce bilinmiyor')
  })
})
