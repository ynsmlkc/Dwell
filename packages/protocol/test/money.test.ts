/**
 * ADR-005 / ADR-011 — para testleri.
 *
 * En kritik iddia: `publisher + platform === rate` HER ZAMAN.
 * Bu invariant kirilirsa ledger'in "ref basina toplam sifir" kurali coker.
 */

import { describe, it, expect } from 'vitest'
import {
  stroops, toAmountString, fromAmountString, splitRevenue, rateFromCpm,
  add, sub, neg, sum, format, MoneyError, ZERO, SCALE, MAX_STROOPS,
  DEFAULT_REV_SHARE_BPS,
} from '../src/money.js'

describe('stroop <-> amount string', () => {
  const CASES: ReadonlyArray<readonly [bigint, string]> = [
    [1n, '0.0000001'],
    [10n, '0.000001'],
    [1_000_000n, '0.1'],
    [1_500_000n, '0.15'],
    [10_000_000n, '1'],
    [12_345_678n, '1.2345678'],
    [100_000_000n, '10'],
    [MAX_STROOPS, '922337203685.4775807'],
  ]

  for (const [s, str] of CASES) {
    it(`${s} → "${str}"`, () => expect(toAmountString(stroops(s))).toBe(str))
  }

  it('round-trip: her deger geri donusunde ayni kalir', () => {
    for (const [s] of CASES) {
      expect(fromAmountString(toAmountString(stroops(s)))).toBe(s)
    }
  })

  it('float\'a dusmez — 2^53 stroop ustunde precision korunur', () => {
    const big = stroops(9_007_199_254_740_993n)   // 2^53 + 1
    expect(fromAmountString(toAmountString(big))).toBe(9_007_199_254_740_993n)
    // ayni degeri float ile hesaplasaydik kaybederdik:
    expect(Number(9_007_199_254_740_993n)).toBe(9_007_199_254_740_992)
  })

  it('sifir ve negatifi reddeder — tek bir sifir tum tx\'i gecersiz kilar', () => {
    expect(() => toAmountString(ZERO)).toThrow(MoneyError)
    expect(() => toAmountString(stroops(-1n))).toThrow(MoneyError)
  })

  it('int64 tasmasini reddeder', () => {
    expect(() => stroops(MAX_STROOPS + 1n)).toThrow(MoneyError)
  })

  it('bozuk amount string\'i reddeder', () => {
    for (const bad of ['', 'abc', '1.23456789', '1,5', '1e7', ' 1', '1 ', '.5']) {
      expect(() => fromAmountString(bad), bad).toThrow(MoneyError)
    }
  })
})

describe('ADR-011 — gelir paylasimi', () => {
  it('publisher + platform her zaman rate\'e esit', () => {
    for (let i = 0; i < 2000; i++) {
      const rate = stroops(BigInt(i) * 7919n + BigInt(i % 13))
      const { publisher, platform } = splitRevenue(rate)
      expect(add(publisher, platform)).toBe(rate)
    }
  })

  it('tek stroop\'ta bile invariant tutar — artik platformda kalir', () => {
    const { publisher, platform } = splitRevenue(stroops(1n))
    expect(publisher).toBe(0n)      // 1 * 5000 / 10000 = 0
    expect(platform).toBe(1n)
    expect(add(publisher, platform)).toBe(1n)
  })

  it('%50 varsayilan', () => {
    expect(splitRevenue(stroops(1000n))).toEqual({ publisher: 1000n / 2n, platform: 500n })
    expect(DEFAULT_REV_SHARE_BPS).toBe(5000)
  })

  it('kampanya bazinda override calisir ve invariant bozulmaz', () => {
    for (const bps of [0, 1, 2500, 7000, 9999, 10_000]) {
      const rate = stroops(123_456_789n)
      const { publisher, platform } = splitRevenue(rate, bps)
      expect(add(publisher, platform)).toBe(rate)
      expect(publisher).toBeLessThanOrEqual(rate)
    }
  })

  it('negatif tutari reddeder — ters kayit yeniden hesaplanmaz (ADR-005)', () => {
    expect(() => splitRevenue(stroops(-100n))).toThrow(MoneyError)
  })

  it('gecersiz bps reddedilir', () => {
    for (const bps of [-1, 10_001, 1.5, NaN]) {
      expect(() => splitRevenue(stroops(100n), bps)).toThrow(MoneyError)
    }
  })
})

describe('ADR-005 — ters kayit negasyonla yazilir', () => {
  it('negasyon toplami sifirlar, yeniden hesaplama yapmaz', () => {
    const rate = stroops(333n)
    const { publisher, platform } = splitRevenue(rate)
    const entries = [neg(rate), publisher, platform]     // advertiser -, digerleri +
    expect(sum(entries)).toBe(0n)

    // ters kayit: hepsini negatifle
    const reversal = entries.map(neg)
    expect(sum(reversal)).toBe(0n)
    expect(sum([...entries, ...reversal])).toBe(0n)
  })

  it('formulu negatif girdiyle yeniden calistirmak YASAK oldugu icin, negasyon tek yol', () => {
    // 333 * 5000 / 10000 = 166 (artik 167 platformda)
    // Eger -333 icin yeniden hesaplasaydik -166 cikardi ve artik -167 olurdu;
    // ayni yone yuvarlamadigi durumlarda toplam sifirlanmazdi. Negasyon bunu
    // yapisal olarak imkansiz kilar.
    const rate = stroops(333n)
    const { publisher } = splitRevenue(rate)
    expect(publisher).toBe(166n)
    expect(neg(publisher)).toBe(-166n)
  })
})

describe('ADR-009 — CPM', () => {
  it('gosterim orani = bid / 1000, kalan platformda', () => {
    expect(rateFromCpm(stroops(300_000_000n))).toBe(300_000n)   // $30 CPM → $0.003
    expect(rateFromCpm(stroops(1999n))).toBe(1n)                // kalan atilir
  })
})

describe('aritmetik sarmalayicilar', () => {
  it('brand korunur ve tasma yakalanir', () => {
    expect(add(stroops(1n), stroops(2n))).toBe(3n)
    expect(sub(stroops(5n), stroops(9n))).toBe(-4n)
    expect(sum([stroops(1n), stroops(2n), stroops(3n)])).toBe(6n)
    expect(() => add(stroops(MAX_STROOPS), stroops(1n))).toThrow(MoneyError)
  })
})

describe('format — sadece gosterim', () => {
  it('sifir ve negatifi kabul eder', () => {
    expect(format(ZERO)).toBe('0 USDC')
    expect(format(stroops(-1_500_000n))).toBe('-0.15 USDC')
    expect(format(stroops(SCALE))).toBe('1 USDC')
  })
})
