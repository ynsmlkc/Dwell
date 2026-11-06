/**
 * Erisim logu — her istek tek JSON satiri.
 *
 * Log da bir depodur: Railway saklar, bir drain baska bir servise tasir.
 * Gizlilik sayfasi "ham IP hicbir yere yazilmaz" diyor; token, sorgu dizesi
 * ve yol icindeki kodlar (havuz katilim kodu) da yazilmamali.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { Keypair } from '@stellar/stellar-sdk'
import { Sep10, NETWORKS } from '@dwell/payments'
import { fixedClock, cryptoIdGenerator, stroops, FALLBACK_CONFIG } from '@dwell/protocol'
import { createApp } from '../src/http/app.js'
import { TokenStore, hashToken } from '../src/http/auth.js'
import { WalletAuth } from '../src/http/wallet-auth.js'
import { Pipeline } from '../src/pipeline.js'
import { Ledger } from '../src/ledger/ledger.js'
import { MemoryLedgerStore } from '../src/ledger/memory-store.js'
import { CampaignStore } from '../src/ads/campaign-store.js'
import { PoolStore } from '../src/pools/pool-store.js'
import { openDb, MEMORY } from '../src/store/db.js'

let lines: string[]
let app: ReturnType<typeof createApp>

const kur = (accessLog?: (line: string) => void) => {
  const clock = fixedClock(1_700_000_000_000)
  const ids = cryptoIdGenerator(clock)
  const ledger = new Ledger(new MemoryLedgerStore(clock, () => ids.impressionId()), clock, () => ids.impressionId())
  const pipeline = new Pipeline({
    clock, ids, ledger, campaigns: () => [],
    minImpressionMs: 10_000, minClientVersion: '0.0.0', pendingMs: 1000, dailyCap: 400,
  })
  const walletAuth = new WalletAuth({
    clock, ids,
    sep10: new Sep10({
      serverKeypair: Keypair.random(), homeDomain: 'dwell.test', webAuthDomain: 'dwell.test',
      networkPassphrase: NETWORKS.testnet,
    }, clock),
    loadSigners: async () => null,
    hashToken,
    issueToken: () => ({ tokenId: 'tok' }),
  })
  // Havuz uclari acik olsun: rota kalibi testi gercek bir `/:code` rotasina vurmali.
  const db = openDb(MEMORY)
  let seq = 0
  return createApp({
    clock, ids, pipeline, ledger, tokens: new TokenStore(),
    config: () => FALLBACK_CONFIG, ipSalt: 'tuz', payoutThreshold: stroops(1n), walletAuth,
    campaigns: new CampaignStore(db, clock, () => `c${seq++}`),
    pools: new PoolStore(db, clock, () => `p${seq++}`, () => 'KOD'),
    ...(accessLog ? { accessLog } : {}),
  })
}

const parse = (i = 0) => JSON.parse(lines[i]!) as Record<string, unknown>

beforeEach(() => {
  lines = []
  app = kur((l) => lines.push(l))
})

describe('erisim logu', () => {
  it('her istek tek JSON satiri: method, rota, durum, sure', async () => {
    await app.request('/health')
    expect(lines).toHaveLength(1)
    const l = parse()
    expect(l).toMatchObject({ m: 'GET', route: '/health', status: 200 })
    expect(typeof l['ms']).toBe('number')
    expect(typeof l['t']).toBe('string')
  })

  it('yol parametresi DEGIL rota kalibi yazilir — havuz kodu loga girmez', async () => {
    await app.request('/v1/pools/HACK-7F3A2C')
    expect(lines.join('\n')).not.toContain('7F3A2C')
    expect(parse()['route']).toBe('/v1/pools/:code')
  })

  it('sorgu dizesi yazilmaz', async () => {
    await app.request('/v1/config?secret=gizli123')
    expect(lines.join('\n')).not.toContain('gizli123')
  })

  it('Authorization basligi yazilmaz', async () => {
    await app.request('/v1/me/balance', { headers: { authorization: 'Bearer dwl_cok_gizli_token_123' } })
    expect(lines.join('\n')).not.toContain('cok_gizli')
    expect(parse()['status']).toBe(401)
  })

  it('ham IP yazilmaz; ayni IP ayni hash, farkli IP farkli hash', async () => {
    const ip = (a: string) => app.request('/health', { headers: { 'x-real-ip': a } })
    await ip('203.0.113.9')
    await ip('203.0.113.9')
    await ip('198.51.100.7')
    expect(lines.join('\n')).not.toContain('203.0.113.9')
    expect(lines.join('\n')).not.toContain('198.51.100.7')
    expect(parse(0)['ip']).toBe(parse(1)['ip'])
    expect(parse(0)['ip']).not.toBe(parse(2)['ip'])
  })

  /** Tarayicilar `/.env`, `/wp-login.php` dener — bilinmeyen yol gorunmeli. */
  it('bilinmeyen yolda gelen yol yazilir, sorgusuz ve kisaltilmis', async () => {
    await app.request('/.env?x=gizli')
    await app.request('/' + 'a'.repeat(500))
    expect(parse(0)).toMatchObject({ status: 404, path: '/.env' })
    expect(lines.join('\n')).not.toContain('gizli')
    expect(String(parse(1)['path']).length).toBeLessThanOrEqual(120)
  })

  it('tarayici imzasi icin User-Agent yazilir, kisaltilmis', async () => {
    await app.request('/health', { headers: { 'user-agent': 'sqlmap/1.7 ' + 'x'.repeat(500) } })
    const ua = String(parse()['ua'])
    expect(ua.startsWith('sqlmap/1.7')).toBe(true)
    expect(ua.length).toBeLessThanOrEqual(120)
  })

  it('verilmezse hicbir sey yazilmaz', async () => {
    const sessiz = kur()
    const r = await sessiz.request('/health')
    expect(r.status).toBe(200)
    expect(lines).toHaveLength(0)
  })
})
