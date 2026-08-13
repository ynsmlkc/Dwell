import { describe, it, expect, beforeEach } from 'vitest'
import { fixedClock, fakeIdGenerator, stroops, type Stroops } from '@dwell/protocol'
import { AdSelector, type Campaign } from '../src/ads/selector.js'

const camp = (id: string, cpmUsdc: number, over: Partial<Campaign> = {}): Campaign => ({
  id, advertiserId: `adv-${id}`,
  bidCpm: stroops(BigInt(Math.round(cpmUsdc * 10_000_000))),
  revShareBps: 5000,
  creative: { brand: id, text: 'metin' },
  status: 'active', frequencyCap: 1,
  ...over,
})

function setup(campaigns: Campaign[], balances: Record<string, bigint> = {}) {
  const clock = fixedClock(1_700_000_000_000)
  const sel = new AdSelector({
    clock, ids: fakeIdGenerator('n'),
    campaigns: () => campaigns,
    spendableBalance: (a) => stroops(balances[a] ?? 1_000_000_000n),
  })
  return { sel, clock }
}

describe('ADR-009 — teklif sirali secim', () => {
  it('en yuksek teklif servis edilir', () => {
    const { sel } = setup([camp('dusuk', 10), camp('yuksek', 30)])
    expect(sel.select('p1')!.campaign.id).toBe('yuksek')
  })

  it('fiyat CPM/1000 — kalan platform lehine atilir', () => {
    const { sel } = setup([camp('a', 30)])           // $30 CPM
    expect(sel.select('p1')!.rate).toBe(300_000n)    // $0.003 = 300.000 stroop
  })

  it('pasif ve askiya alinmis kampanyalar servis edilmez', () => {
    const { sel } = setup([
      camp('a', 30, { status: 'paused' }),
      camp('b', 20, { status: 'suspended' }),
      camp('c', 10),
    ])
    expect(sel.select('p1')!.campaign.id).toBe('c')
  })

  it('gosterim basina orani sifira dusen kampanya elenir', () => {
    // CPM 999 stroop → 999/1000 = 0. Satacak bir sey yok.
    const { sel } = setup([camp('kucuk', 0, { bidCpm: stroops(999n) }), camp('normal', 10)])
    expect(sel.select('p1')!.campaign.id).toBe('normal')
  })

  it('hic uygun kampanya yoksa null — bos reklam gosterilmez', () => {
    const { sel } = setup([])
    expect(sel.select('p1')).toBeNull()
  })
})

describe('ADR-021 — parasi olmayan kampanya servis edilmez', () => {
  it('bakiyesi sifir olan reklamveren atlanir', () => {
    const { sel } = setup([camp('zengin', 10), camp('beles', 30)], { 'adv-beles': 0n })
    expect(sel.select('p1')!.campaign.id, 'yuksek teklifli ama parasiz').toBe('zengin')
  })

  it('kalan bakiye tek bir gosterimi bile karsilamiyorsa servis yok', () => {
    // $30 CPM → gosterim basina 300.000 stroop. Bakiye 100.000.
    const { sel } = setup([camp('a', 30)], { 'adv-a': 100_000n })
    expect(sel.select('p1')).toBeNull()
  })

  it('bakiye tam yeterse servis edilir', () => {
    const { sel } = setup([camp('a', 30)], { 'adv-a': 300_000n })
    expect(sel.select('p1')).not.toBeNull()
  })
})

describe('frekans kurali', () => {
  it('ayni reklam ardisik tekrar etmez', () => {
    const { sel } = setup([camp('a', 30), camp('b', 20)])
    expect(sel.select('p1')!.campaign.id).toBe('a')
    expect(sel.select('p1')!.campaign.id, 'ikinci seferde digeri').toBe('b')
  })

  it('havuz tukenirse kural gevser — reklam gostermemektense tekrar', () => {
    const { sel } = setup([camp('tek', 30)])
    expect(sel.select('p1')!.campaign.id).toBe('tek')
    expect(sel.select('p1')!.campaign.id).toBe('tek')
  })

  it('farkli publisher\'lar birbirini etkilemez', () => {
    const { sel } = setup([camp('a', 30), camp('b', 20)])
    expect(sel.select('p1')!.campaign.id).toBe('a')
    expect(sel.select('p2')!.campaign.id, 'p2 icin de en yuksek').toBe('a')
  })
})

describe('nonce', () => {
  it('her teslimatta yeni nonce uretilir', () => {
    const { sel } = setup([camp('a', 30)])
    const n1 = sel.select('p1')!.nonce
    const n2 = sel.select('p1')!.nonce
    expect(n1).not.toBe(n2)
  })

  it('nonce son kullanma tarihi tasir — replay penceresi dar', () => {
    const { sel, clock } = setup([camp('a', 30)])
    const s = sel.select('p1')!
    expect(s.nonceExpiresAt).toBeGreaterThan(clock.now())
    expect(s.nonceExpiresAt - clock.now()).toBeLessThanOrEqual(5 * 60_000)
  })
})
