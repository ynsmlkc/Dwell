/**
 * IP'den ulke tahmini — CCgather yaklasimi: yalnizca formu onceden doldurur.
 *
 * Korunan: platform basligi once gelir, bilinmeyen kodlar elenir, ilk
 * x-forwarded-for adresi istemcidir, secilmis ulkenin ustune tahmin
 * yazilmaz, veritabani yoksa sessizce kapanir.
 */

import { describe, it, expect } from 'vitest'
import { fixedClock, stroops, FALLBACK_CONFIG } from '@dwell/protocol'
import { countryFromRequest, openCountryDb } from '../src/leaderboard/geo.js'
import { createApp } from '../src/http/app.js'
import { TokenStore, hashToken } from '../src/http/auth.js'
import { Pipeline } from '../src/pipeline.js'
import { Ledger } from '../src/ledger/ledger.js'
import { MemoryLedgerStore } from '../src/ledger/memory-store.js'
import { ProfileStore } from '../src/leaderboard/profiles.js'
import { Leaderboard } from '../src/leaderboard/leaderboard.js'

const headers = (h: Record<string, string>) => (n: string) => h[n]
const fakeDb = (table: Record<string, string>) => (ip: string) => table[ip] ?? null

describe('countryFromRequest', () => {
  it('platform basligini once okur', () => {
    expect(countryFromRequest(headers({ 'cf-ipcountry': 'tr', 'x-forwarded-for': '8.8.8.8' }), fakeDb({ '8.8.8.8': 'US' }))).toBe('TR')
    expect(countryFromRequest(headers({ 'x-vercel-ip-country': 'NG' }), null)).toBe('NG')
  })

  it('bilinmeyen kodlari eler (XX, Tor T1)', () => {
    expect(countryFromRequest(headers({ 'cf-ipcountry': 'XX' }), null)).toBe(null)
    expect(countryFromRequest(headers({ 'cf-ipcountry': 'T1' }), null)).toBe(null)
  })

  it('baslik yoksa yerel veritabanina ilk x-forwarded-for adresiyle bakar', () => {
    const db = fakeDb({ '85.105.0.1': 'TR', '10.0.0.1': 'US' })
    expect(countryFromRequest(headers({ 'x-forwarded-for': '85.105.0.1, 10.0.0.1' }), db)).toBe('TR')
    expect(countryFromRequest(headers({ 'x-real-ip': '85.105.0.1' }), db)).toBe('TR')
  })

  it('veritabani yoksa ya da adres bozuksa susar', () => {
    expect(countryFromRequest(headers({ 'x-forwarded-for': '85.105.0.1' }), null)).toBe(null)
    expect(countryFromRequest(headers({ 'x-forwarded-for': 'not-an-ip' }), () => { throw new Error('bad') })).toBe(null)
    expect(openCountryDb('/nonexistent/geo.mmdb')).toBe(null)
  })
})

describe('GET /v1/me/profile — suggestedCountry', () => {
  const TOKEN = 'dwl_geo_token_0123456789abcdefgh'
  const setup = () => {
    const clock = fixedClock(1_700_000_000_000)
    let seq = 0
    const ids = { impressionId: () => `id-${seq++}`, randomHex: (n: number) => String(seq++).padStart(n * 2, 'a') }
    const ledger = new Ledger(new MemoryLedgerStore(clock, () => `l-${seq++}`), clock, () => `l-${seq++}`)
    const tokens = new TokenStore()
    tokens.add({ id: 't', publisherId: 'G-ME', tokenHash: hashToken(TOKEN), scopes: ['read:balance'], clientVersion: null, revokedAt: null, lastSeenAt: null })
    const profiles = new ProfileStore()
    const app = createApp({
      clock, ids, ledger, tokens, ipSalt: 's', payoutThreshold: stroops(1n),
      config: () => ({ ...FALLBACK_CONFIG, renderEnabled: true }),
      pipeline: new Pipeline({ clock, ids, ledger, campaigns: () => [], minImpressionMs: 1, minClientVersion: '0.0.0', pendingMs: 1, dailyCap: 1 }),
      profiles, leaderboard: new Leaderboard({ entries: () => [], profiles, advertiserOf: () => null, now: () => clock.now() }),
      countryLookup: fakeDb({ '85.105.0.1': 'TR' }),
    })
    const get = async (): Promise<any> =>
      (await app.request('/v1/me/profile', { headers: { authorization: `Bearer ${TOKEN}`, 'x-forwarded-for': '85.105.0.1' } })).json()
    return { profiles, get }
  }

  it('profil yokken baglantidan tahmin eder ama hicbir yere yazmaz', async () => {
    const { profiles, get } = setup()
    expect(await get()).toEqual({ profile: null, suggestedCountry: 'TR' })
    expect(profiles.get('G-ME')).toBe(null)
  })

  it('kullanici ulke sectiyse tahmin etmez — sectiginin ustune yazilmaz', async () => {
    const { profiles, get } = setup()
    profiles.set('G-ME', { nickname: 'ada', country: 'DE', listed: true }, 0)
    expect((await get()).suggestedCountry).toBe(null)
  })

  it('ulke bos birakildiysa yine onerir', async () => {
    const { profiles, get } = setup()
    profiles.set('G-ME', { nickname: 'ada', country: null, listed: false }, 0)
    expect((await get()).suggestedCountry).toBe('TR')
  })
})
