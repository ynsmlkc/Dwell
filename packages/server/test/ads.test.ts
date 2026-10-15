import { describe, it, expect, beforeEach } from 'vitest'
import { fixedClock, fakeIdGenerator, cryptoIdGenerator, stroops, type Stroops } from '@dwell/protocol'
import { AdSelector, type Campaign } from '../src/ads/selector.js'

const camp = (id: string, cpmUsdc: number, over: Partial<Campaign> = {}): Campaign => ({
  id, advertiserId: `adv-${id}`,
  bidCpm: stroops(BigInt(Math.round(cpmUsdc * 10_000_000))),
  revShareBps: 5000,
  creative: { brand: id, text: 'metin' },
  status: 'active', frequencyCap: 0,
  ...over,
})

function setup(
  campaigns: Campaign[],
  balances: Record<string, bigint> = {},
  spentToday: Record<string, bigint> = {},
) {
  const clock = fixedClock(1_700_000_000_000)
  const sel = new AdSelector({
    clock, ids: fakeIdGenerator('n'),
    campaigns: () => campaigns,
    spendableBalance: (a) => stroops(balances[a] ?? 1_000_000_000n),
    spentToday: (id) => stroops(spentToday[id] ?? 0n),
  })
  return { sel, clock }
}

describe('ADR-009 — teklif sirali secim', () => {
  it('en yuksek teklif servis edilir', () => {
    const { sel } = setup([camp('dusuk', 10), camp('yuksek', 30)])
    expect(sel.select('p1')!.campaign.id).toBe('yuksek')
  })

  it('fiyat CPM/1000 — kalan platform lehine atilir', () => {
    // Rakip $2.001 → kazanan $2.011/blok oder → 20_110 stroop/gosterim (kesirsiz).
    const { sel } = setup([
      camp('a', 0, { bidCpm: stroops(30_000_000n) }),
      camp('b', 0, { bidCpm: stroops(20_010_000n) }),
    ])
    expect(sel.select('p1')!.rate).toBe(20_110n)
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

describe('PROBLEMS.md #8c — gunluk harcama tavani', () => {
  it('tavan yoksa (null/undefined) hicbir sey elenmez', () => {
    const { sel } = setup([camp('a', 30)], {}, { a: 999_999_999_999n })
    expect(sel.select('p1')).not.toBeNull()
  })

  it('bir sonraki gosterim tavani asacaksa kampanya o gun icin elenir', () => {
    // $30 CPM -> gosterim basina 300.000 stroop. Tavan 400.000: bir
    // gosterimden sonra ikincisi tavani asar (400.000+300.000 > 400.000... hayir),
    // net senaryo: bugun zaten 200.000 harcanmis, bu gosterim 300.000 daha
    // ekler -> 500.000 > tavan 400.000 -> elenir.
    const { sel } = setup(
      [camp('pahali', 30, { dailyBudgetStroops: stroops(400_000n) }), camp('yedek', 5)],
      {}, { pahali: 200_000n },
    )
    expect(sel.select('p1')!.campaign.id, 'tavana carpan degil, digeri servis edilir').toBe('yedek')
  })

  it('tam tavana kadar hala servis edilir — bir stroop fazlasi degil', () => {
    const { sel } = setup(
      [camp('a', 30, { dailyBudgetStroops: stroops(300_000n) })],
      {}, { a: 0n },
    )
    expect(sel.select('p1')!.campaign.id, 'ilk gosterim tam tavani doldurur').toBe('a')
  })

  it('tum kampanyalar tavana carparsa null doner — bos reklam gosterilmez', () => {
    const { sel } = setup(
      [camp('a', 30, { dailyBudgetStroops: stroops(100_000n) })],
      {}, { a: 100_000n },
    )
    expect(sel.select('p1')).toBeNull()
  })
})

describe('frekans kurali', () => {
  it('ayni reklam ardisik tekrar etmez (frequencyCap: 1)', () => {
    const { sel } = setup([camp('a', 30, { frequencyCap: 1 }), camp('b', 20, { frequencyCap: 1 })])
    expect(sel.select('p1')!.campaign.id).toBe('a')
    expect(sel.select('p1')!.campaign.id, 'ikinci seferde digeri').toBe('b')
  })

  it('havuz tukenirse kural gevser — reklam gostermemektense tekrar', () => {
    const { sel } = setup([camp('tek', 30, { frequencyCap: 1 })])
    expect(sel.select('p1')!.campaign.id).toBe('tek')
    expect(sel.select('p1')!.campaign.id).toBe('tek')
  })

  it('farkli publisher\'lar birbirini etkilemez', () => {
    const { sel } = setup([camp('a', 30), camp('b', 20)])
    expect(sel.select('p1')!.campaign.id).toBe('a')
    expect(sel.select('p2')!.campaign.id, 'p2 icin de en yuksek').toBe('a')
  })
})

describe('ADR-009 (ikinci revizyon) — fiyat sirali kuyruk + ikinci fiyat', () => {
  const usd = (x: number): Stroops => stroops(BigInt(Math.round(x * 10_000_000)))
  const c = (id: string, blockUsd: number, over: Partial<Campaign> = {}) =>
    camp(id, 0, { bidCpm: usd(blockUsd), ...over })

  it('en yuksek teklif kazanir, bir sonraki teklif + 1 kurus oder (NEXT.md ornegi)', () => {
    const { sel } = setup([c('a', 3), c('b', 2), c('c', 0.5)])
    const s1 = sel.select('p1')!
    expect(s1.campaign.id).toBe('a')
    expect(s1.clearingCpm).toBe(usd(2.01))
    expect(s1.rate).toBe(20_100n)                        // gosterim basina $0.00201
  })

  it('rakipsiz kazanan taban fiyati oder', () => {
    const { sel } = setup([c('tek', 40)])
    expect(sel.select('p1')!.clearingCpm).toBe(usd(0.1))
  })

  it('asla kendi teklifinden fazla odemez — esit teklifte teklif kadar', () => {
    const { sel } = setup([c('a', 3), c('b', 3)])
    expect(sel.select('p1')!.clearingCpm).toBe(usd(3))
  })

  it('ayni reklamverenin diger kampanyasi rakip sayilmaz', () => {
    const { sel } = setup([
      c('a', 3, { advertiserId: 'adv-1' }),
      c('a2', 2, { advertiserId: 'adv-1' }),
      c('baska', 0.5, { advertiserId: 'adv-2' }),
    ])
    const s1 = sel.select('p1')!
    expect(s1.campaign.id).toBe('a')
    expect(s1.clearingCpm).toBe(usd(0.51))
  })

  it('taban fiyat ayarlanabilir; teklifin ustundeyse fiyat teklife esitlenir', () => {
    const kur = (reserve: number, bid: number) => new AdSelector({
      clock: fixedClock(1), ids: fakeIdGenerator('n'), campaigns: () => [c('a', bid)],
      spendableBalance: () => stroops(10n ** 15n), spentToday: () => stroops(0n), reserveCpm: usd(reserve),
    })
    expect(kur(1, 3).select('p1')!.clearingCpm).toBe(usd(1))
    expect(kur(5, 3).select('p1')!.clearingCpm).toBe(usd(3))
  })

  it('havuz kampanyasi havuzun sabit fiyatini oder', () => {
    const sel = new AdSelector({
      clock: fixedClock(1), ids: fakeIdGenerator('n'),
      campaigns: () => [c('p1', 5, { poolId: 'pool', advertiserId: 'sponsor' }), c('p2', 5, { poolId: 'pool', advertiserId: 'sponsor' })],
      spendableBalance: () => stroops(10n ** 15n), spentToday: () => stroops(0n), poolOf: () => 'pool',
    })
    expect(sel.select('u')!.clearingCpm).toBe(usd(5))
  })

  it('yumusak siklik siniri: saatte 3 kez sonra sira digerine gecer, herkes sinirdaysa en yuksek doner', () => {
    const { sel } = setup([c('a', 3), c('b', 2)])
    const sira = Array.from({ length: 8 }, () => sel.select('p1')!.campaign.id)
    expect(sira).toEqual(['a', 'a', 'a', 'b', 'b', 'b', 'a', 'a'])
  })

  it('sinirda olan rakip fiyati belirlemez — B, A sinirdayken taban oder', () => {
    const { sel } = setup([c('a', 3), c('b', 2)])
    for (let i = 0; i < 3; i++) sel.select('p1')
    const s4 = sel.select('p1')!
    expect(s4.campaign.id).toBe('b')
    expect(s4.clearingCpm).toBe(usd(0.1))
  })

  it('siklik siniri bir saat sonra sifirlanir ve yayinciya ozeldir', () => {
    const { sel, clock } = setup([c('a', 3), c('b', 2)])
    for (let i = 0; i < 3; i++) sel.select('p1')
    expect(sel.select('p1')!.campaign.id).toBe('b')
    expect(sel.select('p2')!.campaign.id, 'p2 etkilenmez').toBe('a')
    clock.advance(3_600_000)
    expect(sel.select('p1')!.campaign.id, 'saat doldu').toBe('a')
  })

  it('siklik siniri 0 ise kapali: hep en yuksek', () => {
    const sel = new AdSelector({
      clock: fixedClock(1), ids: fakeIdGenerator('n'), campaigns: () => [c('a', 3), c('b', 2)],
      spendableBalance: () => stroops(10n ** 15n), spentToday: () => stroops(0n), hourlyCapPerPublisher: 0,
    })
    expect(Array.from({ length: 6 }, () => sel.select('p1')!.campaign.id)).toEqual(Array(6).fill('a'))
  })

  /**
   * Gercek olayda yakalandi (2026-09-06): esit teklifli iki kampanyada,
   * `AdSelector` (dolayisiyla birikimi) her SUNUCU YENIDEN BASLADIGINDA
   * sifirlaniyor. Eskiden esitlik ID string'ine gore sabit kazaniyordu —
   * yani "yeniden baslat, esitlik olustur, hep ayni ID kazansin" dongusu
   * ayni reklamin surekli kazanmasina yol aciyordu, cunku canli sistemde
   * deploy'lar arka arkaya geldiginde birikim hic olgunlasmiyordu.
   */
  it('esit teklifte tekrarlanan "yeniden baslama" ayni kazanani kilitlemez', () => {
    const campaigns = [camp('a', 40), camp('b', 40)]
    const kazananlar = new Set<string>()
    // Her biri TAZE bir AdSelector — sunucunun her deploy'da birikimi
    // sifirlayip yeniden baslamasinin birebir benzetimi. `cryptoIdGenerator`
    // BILEREK kullaniliyor: `fakeIdGenerator` deterministik oldugu icin
    // rastgele-dusme dalini test edemez, ilk secimde hep ayni yani secerdi.
    for (let i = 0; i < 30; i++) {
      const clock = fixedClock(1_700_000_000_000)
      const sel = new AdSelector({
        clock, ids: cryptoIdGenerator(clock),
        campaigns: () => campaigns,
        spendableBalance: () => stroops(1_000_000_000n),
        spentToday: () => stroops(0n),
      })
      kazananlar.add(sel.select('p1')!.campaign.id)
    }
    // Ikisi de en az bir kez kazanmis olmali — tek bir ID'ye kilitlenmemeli.
    // (Adil yazi-tura ile 30 denemede ikisinin de cikmama ihtimali ~2e-9.)
    expect(kazananlar.size).toBe(2)
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

describe('blok satin alma — 1 blok = 1.000 gosterim', () => {
  const kur = (campaigns: Campaign[], committed: Record<string, number>) => new AdSelector({
    clock: fixedClock(1_700_000_000_000), ids: fakeIdGenerator('n'),
    campaigns: () => campaigns,
    spendableBalance: () => stroops(10n ** 15n),
    spentToday: () => stroops(0n),
    committedImpressions: (id) => committed[id] ?? 0,
  })

  it('bloklar dolana kadar sunulur, dolunca biter', () => {
    expect(kur([camp('a', 30, { blocks: 2 })], { a: 1_999 }).select('p1')?.campaign.id).toBe('a')
    expect(kur([camp('a', 30, { blocks: 2 })], { a: 2_000 }).select('p1')).toBeNull()
  })

  it('biten kampanya digerlerinin onunu tikamaz', () => {
    const sel = kur([camp('bitti', 50, { blocks: 1 }), camp('devam', 10)], { bitti: 1_000 })
    expect(sel.select('p1')?.campaign.id).toBe('devam')
  })

  it('blok verilmemisse sinirsiz', () => {
    expect(kur([camp('a', 30)], { a: 10_000_000 }).select('p1')?.campaign.id).toBe('a')
  })
})
