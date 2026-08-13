/**
 * Uctan uca sunucu: reklam servisi → gosterim → dogrulama → defter.
 *
 * §12 M3'un bitti kriteri burada: "gosterim → pending → dogrulama job'i →
 * uc satirlik ledger kaydi (advertiser/publisher/platform, toplam sifir)".
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { fixedClock, fakeIdGenerator, stroops, sum } from '@dwell/protocol'
import type { ImpressionEvent } from '@dwell/protocol'
import { Pipeline } from '../src/pipeline.js'
import { Ledger } from '../src/ledger/ledger.js'
import { MemoryLedgerStore } from '../src/ledger/memory-store.js'
import { accountId, PLATFORM_REVENUE } from '../src/ledger/accounts.js'
import type { Campaign } from '../src/ads/selector.js'

const PUB = 'pub-1'
const ADV = 'adv-1'
const PENDING_MS = 24 * 3600_000

let clock: ReturnType<typeof fixedClock>
let ledger: Ledger
let pipe: Pipeline
let campaigns: Campaign[]
let ulidSeq = 0

const nextUlid = () => `01HQRS7X8N9P2K3M4V5W6Y7${String(ulidSeq++).padStart(3, '0')}`.slice(0, 26).toUpperCase()

beforeEach(() => {
  clock = fixedClock(1_700_000_000_000)
  ulidSeq = 0
  const ids = fakeIdGenerator('x')
  const realIds = { impressionId: () => `e${ulidSeq++}`, randomHex: (n: number) => Math.random().toString(16).slice(2).padEnd(n * 2, '0').slice(0, n * 2) }
  ledger = new Ledger(new MemoryLedgerStore(clock, () => `led-${ulidSeq++}`), clock, () => `led-${ulidSeq++}`)
  campaigns = [{
    id: 'c1', advertiserId: ADV,
    bidCpm: stroops(300_000_000n),          // $30 CPM → gosterim basina 300.000 stroop
    revShareBps: 5000,
    creative: { brand: 'Firecrawl', text: 'docs to LLM-ready markdown' },
    status: 'active', frequencyCap: 1,
  }]
  pipe = new Pipeline({
    clock, ids: realIds, ledger,
    campaigns: () => campaigns,
    minImpressionMs: 10_000,
    minClientVersion: '1.0.0',
    pendingMs: PENDING_MS,
    dailyCap: 400,
  })
})

/** Bir gosterim uretir: reklam al → raporla. */
function impress(over: Partial<ImpressionEvent> = {}, publisherId = PUB): string | null {
  const sel = pipe.serveAd(publisherId)
  if (!sel) return null
  const id = nextUlid()
  pipe.ingest.ingest(publisherId, [{
    id, campaignId: sel.campaign.id, nonce: sel.nonce, sessionId: 's1',
    surface: 'statusline', durationMs: 15_000, clientTs: clock.now(),
    projectKey: 'f'.repeat(64), clientVersion: '1.0.0', os: 'darwin', arch: 'arm64',
    ...over,
  }])
  return id
}

describe('M3 bitti kriteri — uctan uca', () => {
  beforeEach(() => ledger.deposit({ advertiserId: ADV, amount: stroops(100_000_000n), topupId: 't1' }))

  it('gosterim → pending → dogrulama → uc satirlik ledger kaydi', () => {
    const id = impress()!
    expect(pipe.impressions()[0]!.state).toBe('pending')

    // Bekleme dolmadan hicbir sey yazilmaz
    expect(pipe.runVerification()).toMatchObject({ verified: 0, stillPending: 1 })
    expect(ledger.balance(accountId('publisher', PUB))).toBe(0n)

    clock.advance(PENDING_MS + 1)
    expect(pipe.runVerification()).toMatchObject({ verified: 1, rejected: 0 })

    const entries = ledger.entriesFor('impression', id)
    expect(entries).toHaveLength(3)
    expect(sum(entries.map((e) => e.amount)), 'toplam sifir').toBe(0n)
    expect(ledger.balance(accountId('publisher', PUB))).toBe(150_000n)
    expect(ledger.balance(PLATFORM_REVENUE)).toBe(150_000n)
    expect(ledger.balance(accountId('advertiser', ADV))).toBe(100_000_000n - 300_000n)
    expect(ledger.audit()).toEqual([])
  })

  it('reddedilen gosterim ledger\'a HIC girmez', () => {
    impress({ durationMs: 500 })            // esigin altinda
    clock.advance(PENDING_MS + 1)
    pipe.runVerification()

    expect(pipe.impressions()[0]!.state).toBe('rejected')
    expect(ledger.balance(accountId('publisher', PUB))).toBe(0n)
    expect(ledger.balance(accountId('advertiser', ADV)), 'reklamveren faturalanmadi')
      .toBe(100_000_000n)
  })

  it('dogrulama iki kez calisirsa cift kayit olmaz', () => {
    impress()
    clock.advance(PENDING_MS + 1)
    pipe.runVerification()
    pipe.runVerification()
    expect(ledger.balance(accountId('publisher', PUB))).toBe(150_000n)
  })
})

describe('ADR-021 — butce rezervasyonu', () => {
  it('pending gosterimler harcanabilir bakiyeden DUSULUR', () => {
    // Rezervasyon olmadan 24 saatlik pending penceresi kadar butce asimi
    // garantidir: borc 24 saat sonra yaziliyor ama reklam servis edilmeye
    // devam ediyor.
    ledger.deposit({ advertiserId: ADV, amount: stroops(900_000n), topupId: 't1' })
    expect(pipe.spendable(ADV)).toBe(900_000n)

    impress()                                // 300.000 rezerve
    expect(pipe.spendable(ADV), 'ledger degismedi ama rezerve arttı').toBe(600_000n)

    impress(); impress()
    expect(pipe.spendable(ADV)).toBe(0n)
  })

  it('butce bitince reklam SERVIS EDILMEZ', () => {
    ledger.deposit({ advertiserId: ADV, amount: stroops(600_000n), topupId: 't1' })
    expect(impress()).not.toBeNull()
    expect(impress()).not.toBeNull()
    expect(pipe.serveAd(PUB), 'butce bitti').toBeNull()
  })

  it('dogrulama sonrasi rezerve serbest kalir, ledger\'a gecer', () => {
    ledger.deposit({ advertiserId: ADV, amount: stroops(900_000n), topupId: 't1' })
    impress()
    expect(pipe.spendable(ADV)).toBe(600_000n)

    clock.advance(PENDING_MS + 1)
    pipe.runVerification()

    // Artik rezerve degil, gercekten harcanmis
    expect(ledger.balance(accountId('advertiser', ADV))).toBe(600_000n)
    expect(pipe.spendable(ADV)).toBe(600_000n)
  })

  it('reddedilen gosterimin rezervesi geri doner', () => {
    ledger.deposit({ advertiserId: ADV, amount: stroops(900_000n), topupId: 't1' })
    impress({ durationMs: 100 })
    clock.advance(PENDING_MS + 1)
    pipe.runVerification()
    expect(pipe.spendable(ADV), 'para harcanmadi').toBe(900_000n)
  })

  it('parasi hic olmayan reklamveren servis edilmez', () => {
    expect(pipe.serveAd(PUB)).toBeNull()
    expect(ledger.audit(), 'negatif bakiye olusmadi').toEqual([])
  })
})

describe('gunluk tavan boru hattinda', () => {
  it('tavan asilinca sonraki gosterimler reddedilir', () => {
    ledger.deposit({ advertiserId: ADV, amount: stroops(10_000_000_000n), topupId: 't1' })
    pipe = new Pipeline({
      clock, ids: { impressionId: () => `e${ulidSeq++}`, randomHex: (n) => 'a'.repeat(n * 2) + ulidSeq++ },
      ledger, campaigns: () => campaigns,
      minImpressionMs: 10_000, minClientVersion: '1.0.0',
      pendingMs: PENDING_MS, dailyCap: 3,
    })

    for (let i = 0; i < 5; i++) { impress(); clock.advance(1000) }
    clock.advance(PENDING_MS + 1)
    const r = pipe.runVerification()

    expect(r.verified).toBe(3)
    expect(r.rejected).toBe(2)
    expect(ledger.audit()).toEqual([])
  })
})

describe('fiyat dondurma — ADR-011', () => {
  it('kampanya teklifi degisse bile gecmis gosterim eski fiyatla kaydedilir', () => {
    ledger.deposit({ advertiserId: ADV, amount: stroops(100_000_000n), topupId: 't1' })
    const id = impress()!                          // $30 CPM → 300.000

    campaigns[0] = { ...campaigns[0]!, bidCpm: stroops(1_000_000_000n) }   // $100 CPM

    clock.advance(PENDING_MS + 1)
    pipe.runVerification()

    const entries = ledger.entriesFor('impression', id)
    expect(entries[0]!.rateStroops, 'eski fiyat').toBe(300_000n)
    expect(ledger.balance(accountId('publisher', PUB))).toBe(150_000n)
  })
})
