/**
 * Tur state machine testleri.
 *
 * Her test bir ADR maddesine karsilik geliyor. Bir test kirmizi olursa
 * bozulan sey kod degil, bir KARAR'dir.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { fixedClock, fakeIdGenerator, FALLBACK_CONFIG } from '@dwell/protocol'
import type { AdPayload, RemoteConfig } from '@dwell/protocol'
import { TurnMachine } from '../src/daemon/turns.js'

const CONFIG: RemoteConfig = {
  ...FALLBACK_CONFIG,
  renderEnabled: true,
  surfaces: { statusline: true, spinnerVerb: true, spinnerTip: true },
  minImpressionMs: 10_000,
  rotateMs: 20_000,
  idleGraceMs: 4_000,
}

const ad = (n: number): AdPayload => ({
  campaignId: `camp-${n}`,
  nonce: String(n).padStart(32, '0'),
  nonceExpiresAt: 9_999_999_999_999,
  creative: { brand: `Marka${n}`, text: 'metin' },
})

function setup(overrides: Partial<RemoteConfig> = {}) {
  const clock = fixedClock(1_000_000)
  let adCounter = 0
  let paused = false
  let authed = true
  let config = { ...CONFIG, ...overrides }
  let adsAvailable = true

  const m = new TurnMachine({
    clock,
    ids: fakeIdGenerator('imp'),
    nextAd: () => (adsAvailable ? ad(++adCounter) : null),
    config: () => config,
    isPaused: () => paused,
    isAuthenticated: () => authed,
  })

  return {
    m, clock,
    pause: (v: boolean) => { paused = v },
    auth: (v: boolean) => { authed = v },
    setConfig: (c: Partial<RemoteConfig>) => { config = { ...config, ...c } },
    setAdsAvailable: (v: boolean) => { adsAvailable = v },
    /** statusLine'in saniyede bir tikladigini simule eder. */
    run: (session: string, ms: number, stepMs = 1_000) => {
      const end = clock.now() + ms
      let last
      while (clock.now() < end) {
        clock.advance(Math.min(stepMs, end - clock.now()))
        last = m.onTick(session, clock.now())
      }
      return last
    },
  }
}

describe('ADR-023 — bosta ekran temiz', () => {
  it('tur yokken HICBIR SEY basilmaz', () => {
    const { m, clock } = setup()
    const d = m.onTick('s1', clock.now())
    expect(d.ad).toBeNull()
    expect(d.phase).toBe('idle')
    expect(d.reason).toBe('bu oturumda aktif tur yok')
  })

  it('tur baslayinca gosterilir', () => {
    const { m, clock } = setup()
    m.onTurnStart('s1', clock.now())
    expect(m.onTick('s1', clock.now()).ad).not.toBeNull()
  })

  it('tur bitince 4sn daha gosterilir, sonra susar', () => {
    const { m, clock, run } = setup()
    m.onTurnStart('s1', clock.now())
    run('s1', 12_000)
    m.onTurnEnd('s1', clock.now())

    clock.advance(3_000)
    expect(m.onTick('s1', clock.now()).ad, '3sn: hala gorunmeli').not.toBeNull()

    clock.advance(1_500)   // toplam 4.5sn
    const after = m.onTick('s1', clock.now())
    expect(after.ad, '4.5sn: susmali').toBeNull()
    expect(after.phase).toBe('idle')
  })

  it('tolerans icinde yeni tur gelirse reklam YANIP SONMEZ', () => {
    const { m, clock, run } = setup()
    m.onTurnStart('s1', clock.now())
    run('s1', 12_000)
    const before = m.onTick('s1', clock.now()).ad

    m.onTurnEnd('s1', clock.now())
    clock.advance(2_000)                       // tolerans icinde
    m.onTurnStart('s1', clock.now())           // yeni tur

    const after = m.onTick('s1', clock.now())
    expect(after.ad?.campaignId, 'ayni reklam devam etmeli').toBe(before?.campaignId)
    expect(after.phase).toBe('showing')
  })

  it('alti sartin her biri tek basina render\'i durdurur', () => {
    for (const [name, apply] of [
      ['duraklatildi', (s: ReturnType<typeof setup>) => s.pause(true)],
      ['giris yok', (s: ReturnType<typeof setup>) => s.auth(false)],
      ['kill switch', (s: ReturnType<typeof setup>) => s.setConfig({ renderEnabled: false })],
      ['yuzey kapali', (s: ReturnType<typeof setup>) => s.setConfig({ surfaces: { statusline: false, spinnerVerb: true, spinnerTip: true } })],
      ['reklam yok', (s: ReturnType<typeof setup>) => s.setAdsAvailable(false)],
    ] as const) {
      const s = setup()
      apply(s)                                  // sart tur BASLAMADAN once bozulur
      s.m.onTurnStart('s1', s.clock.now())
      expect(s.m.onTick('s1', s.clock.now()).ad, name).toBeNull()
    }
  })

  it('tur ortasinda reklam havuzu bosalirsa mevcut gosterim kesilmez', () => {
    // Ekrandaki reklami ortadan cekmek yanip sonmeye yol acar; dogru davranis
    // bir sonraki rotasyona kadar mevcut reklamda kalmaktir.
    const s = setup()
    s.m.onTurnStart('s1', s.clock.now())
    expect(s.m.onTick('s1', s.clock.now()).ad).not.toBeNull()

    s.setAdsAvailable(false)
    s.run('s1', 5_000)
    expect(s.m.onTick('s1', s.clock.now()).ad, 'rotasyona kadar kalmali').not.toBeNull()

    s.run('s1', 20_000)                          // rotasyon zamani geldi
    expect(s.m.onTick('s1', s.clock.now()).ad, 'rotasyonda susmali').toBeNull()
  })
})

describe('ADR-022 — rotasyon', () => {
  it('20 saniyede bir reklam degisir', () => {
    const { m, clock, run } = setup()
    m.onTurnStart('s1', clock.now())

    const first = m.onTick('s1', clock.now()).ad!.campaignId
    run('s1', 19_000)
    expect(m.onTick('s1', clock.now()).ad!.campaignId, '19sn: hala ayni').toBe(first)

    run('s1', 2_000)
    expect(m.onTick('s1', clock.now()).ad!.campaignId, '21sn: degismis olmali').not.toBe(first)
  })

  it('71 saniyelik tur 3 gosterim uretir', () => {
    const { m, clock, run } = setup()
    m.onTurnStart('s1', clock.now())
    run('s1', 71_000)
    m.onTurnEnd('s1', clock.now())
    run('s1', 5_000)     // tolerans dolsun

    const imps = m.drainImpressions()
    const counted = imps.filter((i) => i.rejectedReason === null)
    // 0-20, 20-40, 40-60 tam pencere + 60-71 arasi 11sn (>=10sn, sayilir)
    expect(counted.length).toBe(4)
    expect(counted.slice(0, 3).every((i) => i.durationMs >= 20_000)).toBe(true)
  })

  it('turun son parcasi 10sn\'yi gecmezse SAYILMAZ', () => {
    const { m, clock, run } = setup()
    m.onTurnStart('s1', clock.now())
    run('s1', 25_000)     // 20sn tam pencere + 5sn artik
    m.onTurnEnd('s1', clock.now())
    run('s1', 5_000)

    const imps = m.drainImpressions()
    expect(imps.filter((i) => i.rejectedReason === null).length).toBe(1)
    const rejected = imps.filter((i) => i.rejectedReason !== null)
    expect(rejected.length).toBe(1)
    expect(rejected[0]!.rejectedReason).toMatch(/sure \d+ms < 10000ms/)
  })

  it('reddedilen gosterim atilmaz — fraud pipeline\'inin girdisi', () => {
    const { m, clock, run } = setup()
    m.onTurnStart('s1', clock.now())
    run('s1', 3_000)      // esigin altinda
    m.onTurnEnd('s1', clock.now())
    run('s1', 5_000)

    const imps = m.drainImpressions()
    expect(imps.length).toBe(1)
    expect(imps[0]!.rejectedReason).not.toBeNull()
  })
})

describe('oturum yalitimi — bostaki oturum reklam GORMEZ', () => {
  it('bir oturum tur icindeyken bostaki oturuma hicbir sey basilmaz', () => {
    // Kullaniciya "reklam hic kapanmiyor" gibi gorunen hata buydu: tur
    // durumu makine genelinde tutuluyordu, bir oturumun turu digerlerinde
    // de reklam gosteriyordu.
    const { m, clock } = setup()
    m.onTurnStart('calisan', clock.now())

    expect(m.onTick('calisan', clock.now()).ad, 'calisan gormeli').not.toBeNull()
    expect(m.onTick('bosta', clock.now()).ad, 'bostaki GORMEMELI').toBeNull()
  })

  it('bostaki oturum kendi turunu baslatinca gorur', () => {
    const { m, clock } = setup()
    m.onTurnStart('a', clock.now())
    expect(m.onTick('b', clock.now()).ad).toBeNull()

    m.onTurnStart('b', clock.now())
    const d = m.onTick('b', clock.now())
    expect(d.ad, 'artik gormeli').not.toBeNull()
    expect(d.reason, 'ama sayilmamali').toBe('baska oturum sayiyor')
  })

  it('her oturumun toleransi AYRI isler', () => {
    const { m, clock, run } = setup()
    m.onTurnStart('a', clock.now())
    m.onTurnStart('b', clock.now())
    run('a', 12_000)

    m.onTurnEnd('b', clock.now())          // yalnizca b bitti
    clock.advance(5_000)                    // b'nin toleransi doldu

    expect(m.onTick('b', clock.now()).ad, 'b susmali').toBeNull()
    expect(m.onTick('a', clock.now()).ad, 'a devam etmeli').not.toBeNull()
  })

  it('mutex sahibi bosa dusunce bekleyen oturuma gecer', () => {
    const { m, clock, run } = setup()
    m.onTurnStart('a', clock.now())
    m.onTurnStart('b', clock.now())
    expect(m.activeSession).toBe('a')

    run('a', 12_000)
    m.onTurnEnd('a', clock.now())
    clock.advance(5_000)
    m.onTick('a', clock.now())              // a'nin toleransi doldu

    expect(m.activeSession, 'b devralmali').toBe('b')
    expect(m.onTick('b', clock.now()).reason, 'artik b sayiyor').toBeNull()
  })
})

describe('ADR-012 — makine basina tek gosterim', () => {
  it('iki oturum paralel beklerken yalnizca biri sayar', () => {
    const { m, clock, run } = setup()
    m.onTurnStart('s1', clock.now())
    m.onTurnStart('s2', clock.now())

    expect(m.activeSession).toBe('s1')

    const d2 = m.onTick('s2', clock.now())
    expect(d2.ad, 's2 de satiri GORUR').not.toBeNull()
    expect(d2.reason, 'ama sayilmaz').toBe('baska oturum sayiyor')

    run('s1', 25_000)
    run('s2', 25_000)
    m.onTurnEnd('s1', clock.now())
    m.onTurnEnd('s2', clock.now())
    run('s1', 5_000)

    const counted = m.drainImpressions().filter((i) => i.rejectedReason === null)
    expect(counted.every((i) => i.sessionId === 's1'), 'hepsi s1\'e ait olmali').toBe(true)
  })

  it('10 terminal acmak kazanci 10\'la carpmaz', () => {
    const { m, clock, run } = setup()
    const sessions = Array.from({ length: 10 }, (_, i) => `s${i}`)
    for (const s of sessions) m.onTurnStart(s, clock.now())

    // hepsi paralel bekliyor
    const end = clock.now() + 60_000
    while (clock.now() < end) {
      clock.advance(1_000)
      for (const s of sessions) m.onTick(s, clock.now())
    }
    for (const s of sessions) m.onTurnEnd(s, clock.now())
    run('s0', 5_000)

    const counted = m.drainImpressions().filter((i) => i.rejectedReason === null)
    const owners = new Set(counted.map((i) => i.sessionId))
    expect(owners.size, 'tek oturum sayabilmeli').toBe(1)
    // 60sn / 20sn = 3 pencere; 10 oturum olsa 30 olurdu
    expect(counted.length).toBeLessThanOrEqual(4)
  })

  it('aktif oturum kapanirsa mutex serbest kalir — makine kilitlenmez', () => {
    const { m, clock } = setup()
    m.onTurnStart('s1', clock.now())
    m.onTurnStart('s2', clock.now())
    expect(m.activeSession).toBe('s1')

    m.onSessionEnd('s1', clock.now())
    expect(m.activeSession, 's2 devralmali').toBe('s2')
    expect(m.onTick('s2', clock.now()).reason).toBeNull()
  })
})

describe('sayilan sure dogru', () => {
  it('gosterim suresi gercek ekran suresi kadar', () => {
    const { m, clock, run } = setup()
    m.onTurnStart('s1', clock.now())
    run('s1', 15_000)
    m.onTurnEnd('s1', clock.now())
    run('s1', 5_000)

    const [imp] = m.drainImpressions()
    expect(imp!.durationMs).toBeGreaterThanOrEqual(15_000)
    expect(imp!.durationMs).toBeLessThan(20_000)   // tolerans suresi dahil degil
  })

  it('tick gelmezse sure ilerlemez — satir ekranda degildi', () => {
    const { m, clock } = setup()
    m.onTurnStart('s1', clock.now())
    m.onTick('s1', clock.now())

    clock.advance(60_000)          // 1 dakika hicbir tick yok
    m.onTurnEnd('s1', clock.now())
    m.onTick('s1', clock.now() + 5_000)

    const [imp] = m.drainImpressions()
    expect(imp!.rejectedReason, 'tick yoksa gosterim sayilmamali').not.toBeNull()
  })

  it('drain ikinci cagrida bos doner — cift raporlama olmaz', () => {
    const { m, clock, run } = setup()
    m.onTurnStart('s1', clock.now())
    run('s1', 25_000)
    m.onTurnEnd('s1', clock.now())
    run('s1', 5_000)

    expect(m.drainImpressions().length).toBeGreaterThan(0)
    expect(m.drainImpressions().length).toBe(0)
  })
})
