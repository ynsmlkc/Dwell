/**
 * Siralama ve profil testleri.
 *
 * Asil korunan seyler: listelenmemis yayinci hicbir genel uctan cikmaz,
 * kendi reklamindan kazanilan para sayilmaz, ters kayit kazanci geri alir,
 * odeme kayitlari kazanc sayilmaz.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { fixedClock, stroops, FALLBACK_CONFIG } from '@dwell/protocol'
import { createApp } from '../src/http/app.js'
import { TokenStore, hashToken } from '../src/http/auth.js'
import { Pipeline } from '../src/pipeline.js'
import { Ledger } from '../src/ledger/ledger.js'
import { MemoryLedgerStore } from '../src/ledger/memory-store.js'
import { ProfileStore, validateProfile } from '../src/leaderboard/profiles.js'
import { Leaderboard } from '../src/leaderboard/leaderboard.js'
import { openDb, MEMORY } from '../src/store/db.js'
import { profilePersistence } from '../src/store/persistent.js'

const DAY = 86_400_000
const ADV = 'adv-1'
const ALICE = 'pub-alice'
const BOB = 'pub-bob'
const CAROL = 'pub-carol'
const TOKEN = 'dwl_alice_token_0123456789abcdef'

/** Kampanya → reklamveren. `c-self` Carol'un kendi kampanyasi. */
const ADVERTISER: Record<string, string> = { c1: ADV, 'c-self': CAROL }

let clock: ReturnType<typeof fixedClock>
let ledger: Ledger
let profiles: ProfileStore
let board: Leaderboard
let seq = 0

/** Gosterim basina 0.01 USDC, %50 pay → yayinciya 50_000 stroop. */
const show = (publisherId: string, campaignId = 'c1') => {
  const id = `imp-${seq++}`
  ledger.postImpression({
    impressionId: id, advertiserId: ADVERTISER[campaignId]!, publisherId, campaignId,
    rate: stroops(100_000n), revShareBps: 5000,
  })
  return id
}

const list = (publisherId: string, nickname: string, country: string | null, listed = true) =>
  profiles.set(publisherId, { nickname, country, listed }, clock.now())

beforeEach(() => {
  clock = fixedClock(100 * DAY)
  seq = 0
  ledger = new Ledger(new MemoryLedgerStore(clock, () => `led-${seq++}`), clock, () => `led-${seq++}`)
  ledger.deposit({ advertiserId: ADV, amount: stroops(100_000_000n), topupId: 't1' })
  ledger.deposit({ advertiserId: CAROL, amount: stroops(100_000_000n), topupId: 't2' })
  profiles = new ProfileStore()
  board = new Leaderboard({
    entries: () => ledger.entries(), profiles,
    advertiserOf: (id) => ADVERTISER[id] ?? null,
    now: () => clock.now(), cacheMs: 0,
  })
})

describe('validateProfile', () => {
  it('gecerli profili kabul eder, ulkeyi buyuk harfe cevirir', () => {
    expect(validateProfile({ nickname: 'ada_l', country: 'tr', listed: true }))
      .toEqual({ ok: true, value: { nickname: 'ada_l', country: 'TR', listed: true } })
  })

  it('ulke istege bagli', () => {
    const r = validateProfile({ nickname: 'ada', country: null, listed: false })
    expect(r.ok && r.value.country).toBe(null)
  })

  it.each([
    ['cok kisa', { nickname: 'ab', listed: true }],
    ['cok uzun', { nickname: 'a'.repeat(21), listed: true }],
    ['bosluk', { nickname: 'ada lovelace', listed: true }],
    ['unicode benzer harf', { nickname: 'раypal', listed: true }],
    ['bidi override', { nickname: 'ada‮evil', listed: true }],
    ['bilinmeyen ulke', { nickname: 'ada', country: 'XX', listed: true }],
    ['listed eksik', { nickname: 'ada' }],
    ['govde yok', null],
  ])('reddeder: %s', (_, body) => {
    expect(validateProfile(body).ok).toBe(false)
  })
})

describe('ProfileStore', () => {
  it('takma ad buyuk/kucuk harf farketmeksizin tekil', () => {
    expect(list(ALICE, 'Ada', 'TR').ok).toBe(true)
    expect(list(BOB, 'ada', 'US')).toEqual({ ok: false, reason: 'nickname is taken' })
  })

  it('kendi takma adini guncelleyebilir, eski ad serbest kalir', () => {
    list(ALICE, 'ada', 'TR')
    expect(list(ALICE, 'ADA', 'TR').ok).toBe(true)
    list(ALICE, 'lovelace', 'TR')
    expect(list(BOB, 'ada', 'US').ok).toBe(true)
  })

  it('SQLite\'a yazar ve yeniden acilista geri yukler', () => {
    const db = openDb(MEMORY)
    new ProfileStore(profilePersistence(db)).set(ALICE, { nickname: 'ada', country: 'TR', listed: true }, 5)
    const reopened = new ProfileStore(profilePersistence(db))
    expect(reopened.byNickname('ADA')).toEqual({ publisherId: ALICE, nickname: 'ada', country: 'TR', listed: true, updatedAt: 5 })
  })
})

describe('Leaderboard', () => {
  it('kazanca gore siralar, adres disari cikmaz', () => {
    list(ALICE, 'ada', 'TR'); list(BOB, 'bob', 'US')
    show(ALICE); show(BOB); show(BOB)

    const rows = board.top('all', null, 50)
    expect(rows).toEqual([
      { rank: 1, nickname: 'bob', country: 'US', earnedStroops: '100000', impressions: 2 },
      { rank: 2, nickname: 'ada', country: 'TR', earnedStroops: '50000', impressions: 1 },
    ])
    expect(JSON.stringify(rows)).not.toContain('pub-')
  })

  it('listelenmemis yayinci ne siralamada ne ulke dagiliminda gorunur', () => {
    list(ALICE, 'ada', 'TR'); list(BOB, 'bob', 'US', false)
    show(ALICE); show(BOB)

    expect(board.top('all', null, 50).map((r) => r.nickname)).toEqual(['ada'])
    expect(board.countries().map((c) => c.country)).toEqual(['TR'])
    expect(board.profile('bob', 'all')).toBe(null)
  })

  it('profili olmayan yayinci gorunmez', () => {
    show(ALICE)
    expect(board.top('all', null, 50)).toEqual([])
  })

  it('kendi reklamindan kazanilan sayilmaz (PROBLEMS.md #7)', () => {
    list(CAROL, 'carol', 'DE')
    show(CAROL, 'c-self'); show(CAROL, 'c-self'); show(CAROL)

    expect(board.top('all', null, 50)).toEqual([
      { rank: 1, nickname: 'carol', country: 'DE', earnedStroops: '50000', impressions: 1 },
    ])
  })

  it('ters cevrilen gosterim kazanci ve sayiyi geri alir', () => {
    list(ALICE, 'ada', 'TR')
    show(ALICE)
    const bad = show(ALICE)
    ledger.reverse('impression', bad, 'fraud')

    expect(board.top('all', null, 50)[0]).toMatchObject({ earnedStroops: '50000', impressions: 1 })
  })

  it('odeme kayitlari kazanc sayilmaz', () => {
    list(ALICE, 'ada', 'TR')
    show(ALICE); show(ALICE)
    ledger.payoutSubmit({ batchId: 'b1', publisherId: ALICE, amount: stroops(100_000n) })

    expect(board.top('all', null, 50)[0]).toMatchObject({ earnedStroops: '100000', impressions: 2 })
  })

  it('donem filtresi eski kazanci disarida birakir', () => {
    list(ALICE, 'ada', 'TR'); list(BOB, 'bob', 'US')
    show(ALICE); show(ALICE)
    clock.advance(10 * DAY)
    show(BOB)

    expect(board.top('all', null, 50).map((r) => r.nickname)).toEqual(['ada', 'bob'])
    expect(board.top('7d', null, 50).map((r) => r.nickname)).toEqual(['bob'])
    expect(board.top('30d', null, 50).map((r) => r.nickname)).toEqual(['ada', 'bob'])
  })

  it('ulke filtresi ve ulke dagilimi', () => {
    list(ALICE, 'ada', 'TR'); list(BOB, 'bob', 'TR'); list(CAROL, 'carol', null)
    show(ALICE); show(BOB); show(CAROL)

    expect(board.top('all', 'TR', 50).map((r) => r.nickname)).toEqual(['ada', 'bob'])
    expect(board.countries()).toEqual([{ country: 'TR', devs: 2, impressions: 2, earnedStroops: '100000' }])
  })

  it('profil detayi: genel ve ulke sirasi, gunluk gecmis', () => {
    list(ALICE, 'ada', 'TR'); list(BOB, 'bob', 'US'); list(CAROL, 'carol', 'TR')
    show(BOB); show(BOB); show(BOB)
    show(CAROL); show(CAROL)
    clock.advance(DAY)
    show(ALICE)

    const d = board.profile('ADA', 'all')!
    expect(d).toMatchObject({ rank: 3, countryRank: 2, nickname: 'ada', earnedStroops: '50000' })
    expect(d.dailyStroops).toHaveLength(30)
    expect(d.dailyStroops.at(-1)).toBe('50000')
    expect(d.dailyStroops.at(-2)).toBe('0')
  })

  it('onbellek suresince ayni sonucu dondurur', () => {
    const cached = new Leaderboard({
      entries: () => ledger.entries(), profiles,
      advertiserOf: (id) => ADVERTISER[id] ?? null, now: () => clock.now(), cacheMs: 30_000,
    })
    list(ALICE, 'ada', 'TR')
    expect(cached.top('all', null, 50)).toEqual([])
    show(ALICE)
    expect(cached.top('all', null, 50)).toEqual([])
    clock.advance(30_000)
    expect(cached.top('all', null, 50)).toHaveLength(1)
  })

  it('onbellek profil degisikligini geciktirmez: siralamadan cikmak hemen etkili', () => {
    const cached = new Leaderboard({
      entries: () => ledger.entries(), profiles,
      advertiserOf: (id) => ADVERTISER[id] ?? null, now: () => clock.now(), cacheMs: 30_000,
    })
    list(ALICE, 'ada', 'TR')
    show(ALICE)
    expect(cached.top('all', null, 50)).toHaveLength(1)
    expect(cached.countries()).toHaveLength(1)
    expect(cached.profile('ada', 'all')).not.toBe(null)

    list(ALICE, 'ada', 'TR', false)
    expect(cached.top('all', null, 50)).toEqual([])
    expect(cached.countries()).toEqual([])
    expect(cached.profile('ada', 'all')).toBe(null)

    list(ALICE, 'lovelace', 'US')
    expect(cached.top('all', null, 50)[0]).toMatchObject({ nickname: 'lovelace', country: 'US' })
  })

  it('gunluk gecmis defteri her profil icin yeniden taramaz', () => {
    let scans = 0
    const cached = new Leaderboard({
      entries: () => { scans++; return ledger.entries() }, profiles,
      advertiserOf: (id) => ADVERTISER[id] ?? null, now: () => clock.now(), cacheMs: 30_000,
    })
    list(ALICE, 'ada', 'TR'); list(BOB, 'bob', 'US')
    show(ALICE); show(BOB)
    cached.profile('ada', 'all'); cached.profile('bob', 'all'); cached.profile('ada', 'all')
    expect(scans).toBe(2)   // bir kez toplamlar, bir kez gunluk gecmis
    expect(cached.profile('bob', 'all')!.dailyStroops.at(-1)).toBe('50000')
  })
})

describe('HTTP', () => {
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    const tokens = new TokenStore()
    tokens.add({ id: 'tok', publisherId: ALICE, tokenHash: hashToken(TOKEN),
      scopes: ['report:impressions', 'read:balance', 'withdraw:balance'], clientVersion: null, revokedAt: null, lastSeenAt: null })
    const ids = { impressionId: () => `id-${seq++}`, randomHex: (n: number) => String(seq++).padStart(n * 2, 'a') }
    app = createApp({
      clock, ids, ledger, tokens,
      pipeline: new Pipeline({ clock, ids, ledger, campaigns: () => [], minImpressionMs: 10_000,
        minClientVersion: '1.0.0', pendingMs: DAY, dailyCap: 400 }),
      config: () => ({ ...FALLBACK_CONFIG, renderEnabled: true }),
      ipSalt: 's', payoutThreshold: stroops(10_000_000n),
      profiles, leaderboard: board,
    })
  })

  const put = (body: unknown, token = TOKEN) => app.request('/v1/me/profile', {
    method: 'PUT', body: JSON.stringify(body),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  })

  it('profil yazmak token ister', async () => {
    expect((await put({ nickname: 'ada', listed: true }, 'yanlis')).status).toBe(401)
  })

  it('profil yazar, okur ve genel siralamada gorunur', async () => {
    const w = await put({ nickname: 'ada', country: 'tr', listed: true })
    expect(w.status).toBe(200)
    expect(await w.json()).toEqual({ profile: { nickname: 'ada', country: 'TR', listed: true } })

    const r = await app.request('/v1/me/profile', { headers: { authorization: `Bearer ${TOKEN}` } })
    expect(await r.json()).toEqual({ profile: { nickname: 'ada', country: 'TR', listed: true }, suggestedCountry: null })

    show(ALICE)
    const top = await app.request('/v1/leaderboard?period=7d')
    expect(top.headers.get('cache-control')).toContain('max-age')
    expect((await top.json() as any).rows[0]).toMatchObject({ nickname: 'ada', country: 'TR' })

    const c = await app.request('/v1/leaderboard/countries')
    expect(await c.json()).toEqual({ countries: [{ country: 'TR', devs: 1, impressions: 1, earnedStroops: '50000' }] })

    const d = await app.request('/v1/leaderboard/profile/ada')
    expect(d.status).toBe(200)
  })

  it('gecersiz profil 400, alinmis takma ad 409', async () => {
    expect((await put({ nickname: 'a', listed: true })).status).toBe(400)
    profiles.set(BOB, { nickname: 'ada', country: null, listed: true }, 0)
    expect((await put({ nickname: 'ADA', listed: true })).status).toBe(409)
  })

  it('bilinmeyen ulke kodu bos liste doner, genel siralamaya dusmez', async () => {
    await put({ nickname: 'ada', country: 'TR', listed: true })
    show(ALICE)
    const r = await app.request('/v1/leaderboard?country=zz-junk')
    expect(await r.json()).toEqual({ rows: [] })
  })

  it('profil detayi onbellek basligi tasir', async () => {
    await put({ nickname: 'ada', country: 'TR', listed: true })
    show(ALICE)
    const d = await app.request('/v1/leaderboard/profile/ada')
    expect(d.headers.get('cache-control')).toContain('max-age')
  })

  it('bilinmeyen profil 404', async () => {
    expect((await app.request('/v1/leaderboard/profile/nobody')).status).toBe(404)
  })
})
