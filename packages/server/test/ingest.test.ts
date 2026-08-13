import { describe, it, expect, beforeEach } from 'vitest'
import { fixedClock, stroops } from '@dwell/protocol'
import type { ImpressionEvent } from '@dwell/protocol'
import { ImpressionIngest, compareVersions, type DeliveredAd, type StoredImpression } from '../src/impressions/ingest.js'

const PUB = 'pub-1'
const NONCE = 'a'.repeat(32)

let clock: ReturnType<typeof fixedClock>
let deliveries: Map<string, DeliveredAd>
let saved: StoredImpression[]
let ingest: ImpressionIngest

beforeEach(() => {
  clock = fixedClock(1_700_000_000_000)
  saved = []
  deliveries = new Map([[NONCE, {
    nonce: NONCE, publisherId: PUB, campaignId: 'c1', advertiserId: 'adv-1',
    rate: stroops(300_000n), revShareBps: 5000,
    expiresAt: clock.now() + 300_000, consumed: false,
  }]])

  ingest = new ImpressionIngest({
    clock,
    findDelivery: (n) => deliveries.get(n) ?? null,
    seen: (p, id) => saved.find((s) => s.publisherId === p && s.id === id) ?? null,
    save: (i) => { saved.push(i) },
    minImpressionMs: 10_000,
    minClientVersion: '1.0.0',
  })
})

const ev = (over: Partial<ImpressionEvent> = {}): ImpressionEvent => ({
  id: '01HQRS7X8N9P2K3M4V5W6Y7Z8A',
  campaignId: 'c1', nonce: NONCE, sessionId: 's1',
  surface: 'statusline', durationMs: 15_000,
  clientTs: clock.now(), projectKey: 'f'.repeat(64),
  clientVersion: '1.0.0', os: 'darwin', arch: 'arm64',
  ...over,
})

describe('kabul', () => {
  it('gecerli gosterim pending olarak kaydedilir', () => {
    const r = ingest.ingest(PUB, [ev()])
    expect(r.accepted).toHaveLength(1)
    expect(saved[0]!.state).toBe('pending')
  })

  it('fiyat TESLIMATTAN alinir, istemciden degil', () => {
    // ADR-011: istemci fiyat gonderemez, gonderemez de. Sema'da alan yok.
    ingest.ingest(PUB, [ev()])
    expect(saved[0]!.rateStroops).toBe(300_000n)
    expect(saved[0]!.revShareBps).toBe(5000)
  })
})

describe('idempotency — ADR-004', () => {
  it('ayni gosterim iki kez kaydedilmez', () => {
    ingest.ingest(PUB, [ev()])
    const r = ingest.ingest(PUB, [ev()])
    expect(r.duplicates).toHaveLength(1)
    expect(r.accepted).toHaveLength(0)
    expect(saved).toHaveLength(1)
  })

  it('tekillik (publisher, id) uzerinde — global DEGIL', () => {
    // Kotu niyetli bir istemci baskasinin ULID'ini gonderip onun kaydini
    // "zaten var" durumuna dusuremez.
    ingest.ingest(PUB, [ev()])
    deliveries.set('b'.repeat(32), {
      nonce: 'b'.repeat(32), publisherId: 'pub-2', campaignId: 'c1',
      advertiserId: 'adv-1', rate: stroops(300_000n), revShareBps: 5000,
      expiresAt: clock.now() + 300_000, consumed: false,
    })
    const r = ingest.ingest('pub-2', [ev({ nonce: 'b'.repeat(32) })])
    expect(r.accepted, 'ayni ULID, farkli publisher → kabul').toHaveLength(1)
  })
})

describe('nonce dogrulamasi — ADR-004 replay', () => {
  it('bilinmeyen nonce reddedilir', () => {
    const r = ingest.ingest(PUB, [ev({ nonce: 'z'.repeat(32) })])
    expect(r.rejected[0]!.reason).toBe('nonce bilinmiyor')
  })

  it('ayni nonce iki kez kullanilamaz — replay kesilir', () => {
    ingest.ingest(PUB, [ev()])
    const r = ingest.ingest(PUB, [ev({ id: '01HQRS7X8N9P2K3M4V5W6Y7Z8B' })])
    expect(r.rejected[0]!.reason).toBe('nonce zaten kullanilmis')
  })

  it('suresi dolmus nonce reddedilir', () => {
    clock.advance(400_000)
    const r = ingest.ingest(PUB, [ev({ clientTs: clock.now() })])
    expect(r.rejected[0]!.reason).toBe('nonce suresi dolmus')
  })

  it('baska publisher\'in nonce\'u kullanilamaz', () => {
    const r = ingest.ingest('pub-baska', [ev()])
    expect(r.rejected[0]!.reason).toBe('nonce baska publisher\'a ait')
  })

  it('nonce baska kampanyaya aitse reddedilir', () => {
    const r = ingest.ingest(PUB, [ev({ campaignId: 'c2' })])
    expect(r.rejected[0]!.reason).toBe('nonce baska kampanyaya ait')
  })
})

describe('ADR-016 — surum zorlamasi', () => {
  it('eski istemci reddedilir', () => {
    const r = ingest.ingest(PUB, [ev({ clientVersion: '0.9.9' })])
    expect(r.rejected[0]!.reason).toMatch(/surumu cok eski/)
  })

  it('yeni istemci kabul edilir', () => {
    expect(ingest.ingest(PUB, [ev({ clientVersion: '2.5.1' })]).accepted).toHaveLength(1)
  })

  it('surum karsilastirmasi dogru', () => {
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('1.2.0', '1.10.0')).toBeLessThan(0)   // 2 < 10, string degil
    expect(compareVersions('2.0.0', '1.99.99')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBe(0)     // on-surum etiketi yok sayilir
  })
})

describe('ADR-001 — yalnizca olculebilir yuzey', () => {
  it('spinner\'dan gelen gosterim reddedilir', () => {
    // Spinner bize sinyal uretmez; oradan gelen bir rapor ya bug ya saldiri.
    for (const surface of ['spinner_verb', 'spinner_tip'] as const) {
      saved = []
      deliveries.get(NONCE)!.consumed = false
      const r = ingest.ingest(PUB, [ev({ surface })])
      expect(r.rejected[0]!.reason, surface).toMatch(/olculemez yuzey/)
    }
  })
})

describe('sure ve saat', () => {
  it('esigin altindaki sure reddedilir', () => {
    const r = ingest.ingest(PUB, [ev({ durationMs: 3_000 })])
    expect(r.rejected[0]!.reason).toMatch(/sure 3000ms < 10000ms/)
  })

  it('asiri saat sapmasi reddedilir', () => {
    const r = ingest.ingest(PUB, [ev({ clientTs: clock.now() - 48 * 3600_000 })])
    expect(r.rejected[0]!.reason).toMatch(/saat sapmasi/)
  })
})

describe('reddedilen gosterimler saklanir', () => {
  it('red kaydi diske yazilir — red orani fraud girdisi', () => {
    ingest.ingest(PUB, [ev({ durationMs: 100 })])
    expect(saved).toHaveLength(1)
    expect(saved[0]!.state).toBe('rejected')
    expect(saved[0]!.rejectReason).toMatch(/sure/)
  })

  it('reddedilen gosterim reklamvereni faturalandirmaz', () => {
    // state 'rejected' oldugu icin ledger'a hic gitmez — verify asamasinda
    // yalnizca 'verified' olanlar kayit uretir.
    ingest.ingest(PUB, [ev({ durationMs: 100 })])
    expect(saved[0]!.state).not.toBe('verified')
  })
})

describe('toplu gonderim', () => {
  it('bir kotu kayit digerlerini bozmaz', () => {
    for (const n of ['b', 'c']) {
      deliveries.set(n.repeat(32), {
        nonce: n.repeat(32), publisherId: PUB, campaignId: 'c1', advertiserId: 'adv-1',
        rate: stroops(300_000n), revShareBps: 5000,
        expiresAt: clock.now() + 300_000, consumed: false,
      })
    }
    const r = ingest.ingest(PUB, [
      ev({ id: '01HQRS7X8N9P2K3M4V5W6Y7Z81' }),
      ev({ id: '01HQRS7X8N9P2K3M4V5W6Y7Z82', nonce: 'b'.repeat(32), durationMs: 5 }),
      ev({ id: '01HQRS7X8N9P2K3M4V5W6Y7Z83', nonce: 'c'.repeat(32) }),
    ])
    expect(r.accepted).toHaveLength(2)
    expect(r.rejected).toHaveLength(1)
  })
})
