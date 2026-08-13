import { describe, it, expect } from 'vitest'
import {
  fixedClock, cryptoIdGenerator, fakeIdGenerator, isUlid, ULID_LENGTH,
  idempotencyKey,
} from '../src/clock.js'

describe('Clock', () => {
  it('fixedClock elle ilerletilir — zamana bagli her davranis test edilebilir', () => {
    const c = fixedClock(1_000)
    expect(c.now()).toBe(1_000)
    c.advance(10_000)
    expect(c.now()).toBe(11_000)   // 10sn gosterim kurali boyle test edilir
    c.set(0)
    expect(c.now()).toBe(0)
  })
})

describe('ULID', () => {
  const gen = cryptoIdGenerator()

  it('dogru uzunluk ve alfabe', () => {
    const id = gen.impressionId()
    expect(id).toHaveLength(ULID_LENGTH)
    expect(isUlid(id)).toBe(true)
    expect(id).not.toMatch(/[ILOU]/)     // Crockford base32 bunlari kullanmaz
  })

  it('zaman sirali — sonraki kimlik leksikografik olarak buyuk', () => {
    const clock = fixedClock(1_700_000_000_000)
    const g = cryptoIdGenerator(clock)
    const ids: string[] = []
    for (let i = 0; i < 50; i++) { ids.push(g.impressionId()); clock.advance(1) }
    expect([...ids].sort()).toEqual(ids)
  })

  it('ayni milisaniyede bile monotonik — kuyrukta sira bozulmaz', () => {
    const g = cryptoIdGenerator(fixedClock(1_700_000_000_000))
    const ids = Array.from({ length: 200 }, () => g.impressionId())
    expect(new Set(ids).size).toBe(200)
    expect([...ids].sort()).toEqual(ids)
  })

  it('farkli uretecler cakismaz', () => {
    const a = Array.from({ length: 500 }, () => cryptoIdGenerator().impressionId())
    expect(new Set(a).size).toBe(500)
  })

  it('randomHex istenen uzunlukta', () => {
    expect(gen.randomHex(16)).toMatch(/^[0-9a-f]{32}$/)
  })

  it('fakeIdGenerator sirali ve tahmin edilebilir', () => {
    const f = fakeIdGenerator()
    expect(f.impressionId()).toBe('test-000001')
    expect(f.impressionId()).toBe('test-000002')
  })
})

describe('idempotencyKey', () => {
  it('sabit format', () => {
    expect(idempotencyKey('impression', '01H', 'publisher')).toBe('impression:01H:publisher')
  })

  it('ayni girdi ayni anahtari verir', () => {
    expect(idempotencyKey('a', 'b', 'c')).toBe(idempotencyKey('a', 'b', 'c'))
  })

  it('ayirici karakter iceren parcalari reddeder — cakisma uretirdi', () => {
    expect(() => idempotencyKey('a:b', 'c', 'd')).toThrow()
    expect(() => idempotencyKey('a', '', 'd')).toThrow()
  })
})
