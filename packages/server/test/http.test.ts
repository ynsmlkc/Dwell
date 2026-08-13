/**
 * HTTP katmani testleri.
 *
 * Hono'nun `app.request()` metodu gercek bir istek kosuyor — sunucu ayaga
 * kaldirmaya gerek yok.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { fixedClock, stroops, FALLBACK_CONFIG, PROTOCOL_HEADER } from '@dwell/protocol'
import type { RemoteConfig, ImpressionEvent } from '@dwell/protocol'
import { createApp } from '../src/http/app.js'
import { TokenStore, hashToken } from '../src/http/auth.js'
import { Pipeline } from '../src/pipeline.js'
import { Ledger } from '../src/ledger/ledger.js'
import { MemoryLedgerStore } from '../src/ledger/memory-store.js'
import { accountId } from '../src/ledger/accounts.js'
import type { Campaign } from '../src/ads/selector.js'

const PUB = 'pub-1'
const ADV = 'adv-1'
const DAEMON_TOKEN = 'dwl_daemon_token_0123456789abcdef'
const WALLET_TOKEN = 'dwl_wallet_token_0123456789abcdef'
const REVOKED_TOKEN = 'dwl_revoked_token_0123456789abcd'

let clock: ReturnType<typeof fixedClock>
let app: ReturnType<typeof createApp>
let pipeline: Pipeline
let ledger: Ledger
let config: RemoteConfig
let seq = 0

beforeEach(() => {
  clock = fixedClock(1_700_000_000_000)
  seq = 0
  const ids = { impressionId: () => `id-${seq++}`, randomHex: (n: number) => String(seq++).padStart(n * 2, 'a') }

  ledger = new Ledger(new MemoryLedgerStore(clock, () => `led-${seq++}`), clock, () => `led-${seq++}`)
  ledger.deposit({ advertiserId: ADV, amount: stroops(100_000_000n), topupId: 't1' })

  const campaigns: Campaign[] = [{
    id: 'c1', advertiserId: ADV, bidCpm: stroops(300_000_000n), revShareBps: 5000,
    creative: { brand: 'Firecrawl', text: 'docs to LLM-ready markdown' },
    status: 'active', frequencyCap: 1,
  }]

  pipeline = new Pipeline({
    clock, ids, ledger, campaigns: () => campaigns,
    minImpressionMs: 10_000, minClientVersion: '1.0.0',
    pendingMs: 24 * 3600_000, dailyCap: 400,
  })

  const tokens = new TokenStore()
  tokens.add({ id: 'tok-daemon', publisherId: PUB, tokenHash: hashToken(DAEMON_TOKEN),
    scopes: ['report:impressions', 'read:balance'], clientVersion: null, revokedAt: null, lastSeenAt: null })
  tokens.add({ id: 'tok-wallet', publisherId: PUB, tokenHash: hashToken(WALLET_TOKEN),
    scopes: ['wallet:write', 'read:balance'], clientVersion: null, revokedAt: null, lastSeenAt: null })
  tokens.add({ id: 'tok-revoked', publisherId: PUB, tokenHash: hashToken(REVOKED_TOKEN),
    scopes: ['report:impressions'], clientVersion: null, revokedAt: clock.now(), lastSeenAt: null })

  config = { ...FALLBACK_CONFIG, renderEnabled: true, minClientVersion: '1.0.0',
    surfaces: { statusline: true, spinnerVerb: true, spinnerTip: true } }

  app = createApp({
    clock, ids, pipeline, ledger, tokens,
    config: () => config,
    ipSalt: 'test-salt',
    payoutThreshold: stroops(10_000_000n),
  })
})

/** Hono'nun Response.json() `unknown` doner; testlerde kisa yol. */
const asJson = async (r: Response): Promise<any> => r.json()

const auth = (token = DAEMON_TOKEN, version = '1.0.0'): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  'x-dwell-client-version': version,
  'content-type': 'application/json',
})

describe('yetki', () => {
  it('token yoksa 401', async () => {
    const r = await app.request('/v1/ads/next', { method: 'POST' })
    expect(r.status).toBe(401)
    expect((await asJson(r)).code).toBe('DWL_2001')
  })

  it('iptal edilmis token 401', async () => {
    const r = await app.request('/v1/ads/next', { method: 'POST', headers: auth(REVOKED_TOKEN) })
    expect(r.status).toBe(401)
    expect((await asJson(r)).code).toBe('DWL_2002')
  })

  it('kapsam yetmiyorsa 403 — daemon token\'i cuzdan degistiremez', async () => {
    // Cuzdan token'i gosterim raporlayamaz ve tersi.
    const r = await app.request('/v1/ads/next', { method: 'POST', headers: auth(WALLET_TOKEN) })
    expect(r.status).toBe(403)
    expect((await asJson(r)).code).toBe('DWL_2003')
  })

  it('bakiyeyi ikisi de okuyabilir', async () => {
    for (const t of [DAEMON_TOKEN, WALLET_TOKEN]) {
      expect((await app.request('/v1/me/balance', { headers: auth(t) })).status).toBe(200)
    }
  })
})

describe('ADR-016 — surum kapisi', () => {
  it('eski istemci 426 alir', async () => {
    config = { ...config, minClientVersion: '2.0.0' }
    const r = await app.request('/v1/ads/next', { method: 'POST', headers: auth(DAEMON_TOKEN, '1.5.0') })
    expect(r.status).toBe(426)
    expect((await asJson(r)).code).toBe('DWL_1005')
  })

  it('yeni istemci gecer', async () => {
    config = { ...config, minClientVersion: '2.0.0' }
    const r = await app.request('/v1/ads/next', { method: 'POST', headers: auth(DAEMON_TOKEN, '2.0.0') })
    expect(r.status).toBe(200)
  })
})

describe('ADR-008 — kill switch', () => {
  it('render kapaliysa reklam servis edilmez', async () => {
    config = { ...config, renderEnabled: false }
    const r = await app.request('/v1/ads/next', { method: 'POST', headers: auth() })
    expect(r.status).toBe(503)
    expect((await asJson(r)).code).toBe('DWL_3005')
  })

  it('config ucu YETKI ISTEMEZ — kill switch her istemciye ulasmali', async () => {
    const r = await app.request('/v1/config')
    expect(r.status).toBe(200)
    expect((await asJson(r)).renderEnabled).toBe(true)
  })
})

describe('POST /v1/ads/next', () => {
  it('reklam ve nonce doner', async () => {
    const r = await app.request('/v1/ads/next', { method: 'POST', headers: auth() })
    const body = await asJson(r)
    expect(body.campaignId).toBe('c1')
    expect(body.nonce).toHaveLength(32)
    expect(body.creative.brand).toBe('Firecrawl')
  })

  it('FIYAT GONDERILMEZ — ADR-011', () => {
    // Fiyat sunucu tarafinda dondurulur. Istemciye gondermek gereksiz ve
    // manipulasyon yuzeyi.
    return Promise.resolve(app.request('/v1/ads/next', { method: 'POST', headers: auth() }))
      .then(asJson)
      .then((b: any) => {
        expect(b).not.toHaveProperty('rate')
        expect(b).not.toHaveProperty('rateStroops')
        expect(JSON.stringify(b)).not.toMatch(/rate/i)
      })
  })

  it('gosterecek kampanya yoksa 204 — hata degil', async () => {
    // Butce 100.000.000 stroop, gosterim basina 300.000 → 333 teslimat.
    // Teslimat rezerve tuttugu icin bu dongu SONLU; tutmasaydi sonsuz olurdu.
    let served = 0
    for (let i = 0; i < 500; i++) {
      const r = await app.request('/v1/ads/next', { method: 'POST', headers: auth() })
      if (r.status === 204) break
      served++
    }
    expect(served, 'butce kadar teslimat, fazlasi degil').toBe(333)
    const r = await app.request('/v1/ads/next', { method: 'POST', headers: auth() })
    expect(r.status).toBe(204)
  })

  it('teslimat butceyi ASAMAZ — raporlamadan once bile rezerve', async () => {
    // Teslimat rezerve etmeseydi istemci sinirsiz reklam cekip hepsini
    // raporlayarak butceyi asabilirdi.
    const before = pipeline.spendable(ADV)
    await app.request('/v1/ads/next', { method: 'POST', headers: auth() })
    expect(pipeline.spendable(ADV), 'hemen dusmeli').toBe(before - 300_000n)
  })
})

describe('POST /v1/impressions', () => {
  const ev = (nonce: string, over: Partial<ImpressionEvent> = {}): ImpressionEvent => ({
    id: '01HQRS7X8N9P2K3M4V5W6Y7Z8A', campaignId: 'c1', nonce, sessionId: 's1',
    surface: 'statusline', durationMs: 15_000, clientTs: clock.now(),
    projectKey: 'f'.repeat(64), clientVersion: '1.0.0', os: 'darwin', arch: 'arm64',
    ...over,
  })

  const post = (events: ImpressionEvent[], headers = auth()) =>
    app.request('/v1/impressions', { method: 'POST', headers, body: JSON.stringify({ events }) })

  it('gecerli gosterim kabul edilir', async () => {
    const { nonce } = await asJson(await app.request('/v1/ads/next', { method: 'POST', headers: auth() }))
    const body = await asJson(await post([ev(nonce)]))
    expect(body.accepted).toHaveLength(1)
  })

  it('kismi basari — iyi kayitlar kabul, kotuler reddedilir', async () => {
    // Toptan hata donmek istemciyi iyi kayitlari da yeniden gondermeye zorlardi.
    const a = await asJson(await app.request('/v1/ads/next', { method: 'POST', headers: auth() }))
    const b = await asJson(await app.request('/v1/ads/next', { method: 'POST', headers: auth() }))
    const body = await asJson(await post([
      ev(a.nonce, { id: '01HQRS7X8N9P2K3M4V5W6Y7Z81' }),
      ev(b.nonce, { id: '01HQRS7X8N9P2K3M4V5W6Y7Z82', durationMs: 100 }),
    ]))

    expect(body.accepted).toHaveLength(1)
    expect(body.rejected).toHaveLength(1)
    expect(body.rejected[0].reason).toMatch(/sure/)
  })

  it('bozuk govde 400', async () => {
    const r = await app.request('/v1/impressions', {
      method: 'POST', headers: auth(), body: '{"events":[{"id":"kisa"}]}',
    })
    expect(r.status).toBe(400)
  })

  it('§10 — ham IP hicbir yere yazilmaz, yalnizca hash', async () => {
    const { nonce } = await asJson(await app.request('/v1/ads/next', { method: 'POST', headers: auth() }))
    await post([ev(nonce)], { ...auth(), 'x-forwarded-for': '203.0.113.42, 10.0.0.1' })

    const stored = pipeline.impressions()[0]!
    expect(stored.ipHash).not.toContain('203.0.113')
    expect(stored.ipHash).toMatch(/^[0-9a-f]{32}$/)
  })

  it('bilinmeyen alanlar sessizce dusurulur — ileri uyumluluk', async () => {
    const { nonce } = await asJson(await app.request('/v1/ads/next', { method: 'POST', headers: auth() }))
    const r = await app.request('/v1/impressions', {
      method: 'POST', headers: auth(),
      body: JSON.stringify({ events: [{ ...ev(nonce), gelecekteAlan: 'x' }] }),
    })
    expect((await asJson(r)).accepted).toHaveLength(1)
  })
})

describe('GET /v1/me/balance', () => {
  it('bekleyen ve odenebilir ayri gosterilir', async () => {
    const { nonce } = await asJson(await app.request('/v1/ads/next', { method: 'POST', headers: auth() }))
    await app.request('/v1/impressions', {
      method: 'POST', headers: auth(),
      body: JSON.stringify({ events: [{
        id: '01HQRS7X8N9P2K3M4V5W6Y7Z8A', campaignId: 'c1', nonce, sessionId: 's1',
        surface: 'statusline', durationMs: 15_000, clientTs: clock.now(),
        projectKey: 'f'.repeat(64), clientVersion: '1.0.0', os: 'darwin', arch: 'arm64',
      }] }),
    })

    const b = await asJson(await app.request('/v1/me/balance', { headers: auth() }))
    expect(b.pendingStroops, 'dogrulanmadi, henuz para degil').toBe('150000')
    expect(b.payableStroops).toBe('0')
  })

  it('odeme bloke ise SEBEBI gosterilir', async () => {
    const b = await asJson(await app.request('/v1/me/balance', { headers: auth() }))
    expect(b.blockedReason).toMatch(/esik/)
  })

  it('esik gecilince sebep null olur', async () => {
    ledger.postImpression({
      impressionId: 'big', advertiserId: ADV, publisherId: PUB, campaignId: 'c1',
      rate: stroops(40_000_000n), revShareBps: 5000,
    })
    const b = await asJson(await app.request('/v1/me/balance', { headers: auth() }))
    expect(b.payableStroops).toBe('20000000')
    expect(b.blockedReason).toBeNull()
  })
})

describe('protokol ve hatalar', () => {
  it('her cevap protokol surumu tasir', async () => {
    const r = await app.request('/v1/config')
    expect(r.headers.get(PROTOCOL_HEADER)).toBe('v1')
  })

  it('bilinmeyen uc 404 + hata zarfi', async () => {
    const r = await app.request('/v1/yok')
    expect(r.status).toBe(404)
    expect((await asJson(r)).code).toBe('DWL_9001')
  })

  it('hata cevabi stack trace ICERMEZ', async () => {
    const r = await app.request('/v1/yok')
    const text = JSON.stringify(await asJson(r))
    expect(text).not.toMatch(/at \w+|\.ts:|node_modules/)
  })
})
