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

describe('ADR-009 (revize) — SWRR ile teklife orantili pay', () => {
  function shareOf(sel: AdSelector, publisherId: string, ticks: number): Record<string, number> {
    const counts: Record<string, number> = {}
    for (let i = 0; i < ticks; i++) {
      const id = sel.select(publisherId)!.campaign.id
      counts[id] = (counts[id] ?? 0) + 1
    }
    for (const id of Object.keys(counts)) counts[id] = counts[id]! / ticks
    return counts
  }

  it('2 kampanya, 5:1 teklif orani — kisitlama yoksa pay da ~5:1 olur (PROBLEMS.md #8)', () => {
    const { sel } = setup([camp('pahali', 50), camp('ucuz', 10)])
    const share = shareOf(sel, 'p1', 3000)
    // Beklenen: 50/60 ~ 0.833 ve 10/60 ~ 0.167.
    expect(share['pahali']!).toBeGreaterThan(0.78)
    expect(share['pahali']!).toBeLessThan(0.89)
    expect(share['ucuz']!).toBeGreaterThan(0.11)
    expect(share['ucuz']!).toBeLessThan(0.22)
  })

  it('eskiden hep ayni kampanya kazanirdi — artik ikinci de payini aliyor', () => {
    const { sel } = setup([camp('pahali', 50), camp('ucuz', 10)])
    const share = shareOf(sel, 'p1', 3000)
    expect(share['ucuz']).toBeGreaterThan(0)
  })

  it('3 kampanya — pay agirlik oranina yakinsar (dokumandaki A/B/C senaryosu)', () => {
    const { sel } = setup([camp('a', 30), camp('b', 15), camp('c', 15)])
    const share = shareOf(sel, 'p1', 6000)
    // toplam agirlik 60: a=%50, b=%25, c=%25.
    expect(share['a']!).toBeGreaterThan(0.44)
    expect(share['a']!).toBeLessThan(0.56)
    expect(share['b']!).toBeGreaterThan(0.19)
    expect(share['b']!).toBeLessThan(0.31)
    expect(share['c']!).toBeGreaterThan(0.19)
    expect(share['c']!).toBeLessThan(0.31)
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

  it('frequencyCap > 0 hala payi 1/(N+1) ile kilitler — bilinen gerilim (PROBLEMS.md #8a)', () => {
    // Ayni 5:1 teklif orani, ama "ardisik tekrar yok" (cap 1) acikca istendi.
    const { sel } = setup([
      camp('pahali', 50, { frequencyCap: 1 }),
      camp('ucuz', 10, { frequencyCap: 1 }),
    ])
    const share = shareOf(sel, 'p1', 200)
    expect(share['pahali']).toBeCloseTo(0.5, 1)
    expect(share['ucuz']).toBeCloseTo(0.5, 1)
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
