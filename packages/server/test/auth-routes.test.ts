/**
 * `/v1/auth/*` uclarinin hiz siniri.
 *
 * Sinir yokken biri baskasinin adresine surekli challenge isteyebiliyor ya
 * da rastgele adreslerle bellegi doldurabiliyordu.
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

let clock: ReturnType<typeof fixedClock>
let app: ReturnType<typeof createApp>

beforeEach(() => {
  clock = fixedClock(1_700_000_000_000)
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
  app = createApp({
    clock, ids, pipeline, ledger, tokens: new TokenStore(),
    config: () => FALLBACK_CONFIG, ipSalt: 's', payoutThreshold: stroops(1n), walletAuth,
  })
})

const challenge = (ip: string) => app.request('/v1/auth/challenge', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
  body: JSON.stringify({ address: Keypair.random().publicKey() }),
})

describe('/v1/auth hiz siniri', () => {
  it('ayni IP 5 challenge\'tan sonra 429 alir', async () => {
    for (let i = 0; i < 5; i++) expect((await challenge('203.0.113.9')).status).toBe(200)
    const r = await challenge('203.0.113.9')
    expect(r.status).toBe(429)
    expect(r.headers.get('retry-after')).toBeTruthy()
  })

  it('baska bir IP etkilenmez', async () => {
    for (let i = 0; i < 6; i++) await challenge('203.0.113.9')
    expect((await challenge('198.51.100.7')).status).toBe(200)
  })

  /** Ilk degeri istemci yazar; her istekte degistirmek siniri ATLATAMAZ. */
  it('sahte x-forwarded-for ile sinir atlatilamaz', async () => {
    for (let i = 0; i < 5; i++) await challenge(`10.0.0.${i}, 203.0.113.9`)
    expect((await challenge('10.0.0.99, 203.0.113.9')).status).toBe(429)
  })

  it('kova zamanla dolar', async () => {
    for (let i = 0; i < 6; i++) await challenge('203.0.113.9')
    clock.advance(30_000)
    expect((await challenge('203.0.113.9')).status).toBe(200)
  })
})
