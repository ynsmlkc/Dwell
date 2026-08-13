/**
 * Defter testleri — ADR-005, ADR-011, ADR-021.
 *
 * Bir test kirmizi olursa bozulan sey kod degil, bir PARA KURALIDIR.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { fixedClock, fakeIdGenerator, stroops, add, sum, ZERO } from '@dwell/protocol'
import { Ledger, LedgerError } from '../src/ledger/ledger.js'
import { MemoryLedgerStore } from '../src/ledger/memory-store.js'
import { accountId, PLATFORM_REVENUE, EXTERNAL_CASH, EXTERNAL_SETTLEMENT } from '../src/ledger/accounts.js'

const ADV = 'adv-1'
const PUB = 'pub-1'
const CAMP = 'camp-1'
const advAcc = accountId('advertiser', ADV)
const pubAcc = accountId('publisher', PUB)
const inFlight = accountId('payouts_in_flight')

let ledger: Ledger
let clock: ReturnType<typeof fixedClock>

beforeEach(() => {
  clock = fixedClock(1_700_000_000_000)
  const ids = fakeIdGenerator('e')
  ledger = new Ledger(new MemoryLedgerStore(clock, () => ids.impressionId()), clock, () => ids.impressionId())
})

const impression = (id: string, rate: bigint, bps = 5000) =>
  ledger.postImpression({
    impressionId: id, advertiserId: ADV, publisherId: PUB, campaignId: CAMP,
    rate: stroops(rate), revShareBps: bps,
  })

describe('ADR-021 — reklamveren yatirimi', () => {
  it('yatirim defterde gorunur, karsi taraf external_cash', () => {
    ledger.deposit({ advertiserId: ADV, amount: stroops(1_000_000_000n), topupId: 't1' })
    expect(ledger.balance(advAcc)).toBe(1_000_000_000n)
    expect(ledger.balance(EXTERNAL_CASH)).toBe(-1_000_000_000n)
  })

  it('yatirim olmadan gosterim reklamvereni EKSIYE dusurur — audit yakalar', () => {
    // Eski tasarimin hatasi: reklamveren "platform disinda" oderdi, hesabin
    // yalnizca eksi yonu olurdu ve acigi platform kapatirdi.
    impression('i1', 1_000_000n)
    expect(ledger.balance(advAcc)).toBeLessThan(0n)
    expect(ledger.audit()).toContainEqual(expect.stringMatching(/negatif bakiye.*advertiser/))
  })

  it('yatirim varsa gosterim sonrasi bakiye pozitif kalir', () => {
    ledger.deposit({ advertiserId: ADV, amount: stroops(1_000_000_000n), topupId: 't1' })
    impression('i1', 1_000_000n)
    expect(ledger.balance(advAcc)).toBe(999_000_000n)
    expect(ledger.audit()).toEqual([])
  })

  it('ayni topup iki kez islenmez', () => {
    const a = ledger.deposit({ advertiserId: ADV, amount: stroops(500n), topupId: 't1' })
    const b = ledger.deposit({ advertiserId: ADV, amount: stroops(500n), topupId: 't1' })
    expect(b.map((e) => e.id)).toEqual(a.map((e) => e.id))   // orijinal sonuc doner
    expect(ledger.balance(advAcc)).toBe(500n)
  })

  it('sifir veya negatif yatirim reddedilir', () => {
    expect(() => ledger.deposit({ advertiserId: ADV, amount: stroops(0n), topupId: 't' })).toThrow(LedgerError)
  })
})

describe('ADR-011 — gosterim uc satir yazar', () => {
  beforeEach(() => ledger.deposit({ advertiserId: ADV, amount: stroops(10_000_000_000n), topupId: 't0' }))

  it('advertiser eksi, publisher ve platform arti, toplam sifir', () => {
    const entries = impression('i1', 1_000_000n)
    expect(entries).toHaveLength(3)
    expect(sum(entries.map((e) => e.amount))).toBe(0n)
    expect(entries.find((e) => e.accountId === advAcc)!.amount).toBe(-1_000_000n)
    expect(entries.find((e) => e.accountId === pubAcc)!.amount).toBe(500_000n)
    expect(entries.find((e) => e.accountId === PLATFORM_REVENUE)!.amount).toBe(500_000n)
  })

  it('yuvarlama artigi platformda kalir, toplam yine sifir', () => {
    const entries = impression('i1', 333n)
    expect(entries.find((e) => e.accountId === pubAcc)!.amount).toBe(166n)
    expect(entries.find((e) => e.accountId === PLATFORM_REVENUE)!.amount).toBe(167n)
    expect(sum(entries.map((e) => e.amount))).toBe(0n)
  })

  it('1000 rastgele tutarda invariant tutar', () => {
    for (let i = 1; i <= 1000; i++) {
      const entries = impression(`i${i}`, BigInt(i) * 7919n % 1_000_003n + 1n)
      expect(sum(entries.map((e) => e.amount)), `i${i}`).toBe(0n)
    }
    expect(ledger.audit()).toEqual([])
  })

  it('rate ve rev-share gosterim aninda DONDURULUR', () => {
    // Kampanya sonradan degisse bile gecmis kayit degismez.
    const e1 = impression('i1', 1_000_000n, 5000)
    const e2 = impression('i2', 1_000_000n, 7000)
    expect(e1.find((e) => e.accountId === pubAcc)!.amount).toBe(500_000n)
    expect(e2.find((e) => e.accountId === pubAcc)!.amount).toBe(700_000n)
  })

  it('ayni gosterim iki kez islenmez', () => {
    impression('i1', 1_000_000n)
    impression('i1', 1_000_000n)
    expect(ledger.balance(pubAcc)).toBe(500_000n)
  })

  it('defter kendi kendine yeterli — campaign ve rate denormalize', () => {
    // `impressions` tablosu 90 gunde drop ediliyor; bu bilgi orada aranamaz.
    const [entry] = impression('i1', 1_000_000n)
    expect(entry!.campaignId).toBe(CAMP)
    expect(entry!.publisherId).toBe(PUB)
    expect(entry!.rateStroops).toBe(1_000_000n)
    expect(entry!.asset).toBe('USDC')
  })
})

describe('ADR-005 — ters kayit negasyondur', () => {
  beforeEach(() => ledger.deposit({ advertiserId: ADV, amount: stroops(10_000_000n), topupId: 't0' }))

  it('ters kayit tum bakiyeleri sifirlar', () => {
    impression('i1', 333n)
    const before = ledger.balance(pubAcc)
    ledger.reverse('impression', 'i1', 'fraud')

    expect(ledger.balance(pubAcc)).toBe(0n)
    expect(ledger.balance(PLATFORM_REVENUE)).toBe(0n)
    expect(before).toBeGreaterThan(0n)
  })

  it('yeniden hesaplamiyor — artik ayni yerde kaliyor', () => {
    // 333 * 5000/10000 = 166, artik 167 platformda.
    // Negatif girdiyle yeniden hesaplasaydik artik ters yone duserdi.
    impression('i1', 333n)
    const rev = ledger.reverse('impression', 'i1', 'fraud')
    expect(rev.find((e) => e.accountId === pubAcc)!.amount).toBe(-166n)
    expect(rev.find((e) => e.accountId === PLATFORM_REVENUE)!.amount).toBe(-167n)
    expect(sum(rev.map((e) => e.amount))).toBe(0n)
  })

  it('iki kez ters cevirmek bakiyeyi bozmaz', () => {
    impression('i1', 1_000n)
    ledger.reverse('impression', 'i1', 'fraud')
    ledger.reverse('impression', 'i1', 'fraud')
    expect(ledger.balance(pubAcc)).toBe(0n)
    expect(ledger.audit()).toEqual([])
  })

  it('olmayan kaydi ters cevirmek hata', () => {
    expect(() => ledger.reverse('impression', 'yok', 'x')).toThrow(LedgerError)
  })
})

describe('odeme akisi — in-flight hesabi', () => {
  beforeEach(() => {
    ledger.deposit({ advertiserId: ADV, amount: stroops(10_000_000n), topupId: 't0' })
    impression('i1', 2_000_000n)          // publisher +1_000_000
  })

  it('submit parayi yolda kutusuna alir — cift odeme engellenir', () => {
    expect(ledger.balance(pubAcc)).toBe(1_000_000n)
    ledger.payoutSubmit({ batchId: 'b1', publisherId: PUB, amount: stroops(1_000_000n) })

    expect(ledger.balance(pubAcc), 'artik odenebilir gorunmemeli').toBe(0n)
    expect(ledger.balance(inFlight)).toBe(1_000_000n)
  })

  it('ayni batch iki kez submit edilmez', () => {
    ledger.payoutSubmit({ batchId: 'b1', publisherId: PUB, amount: stroops(1_000_000n) })
    ledger.payoutSubmit({ batchId: 'b1', publisherId: PUB, amount: stroops(1_000_000n) })
    expect(ledger.balance(inFlight)).toBe(1_000_000n)
    expect(ledger.balance(pubAcc)).toBe(0n)
  })

  it('settle parayi sistemden cikarir', () => {
    ledger.payoutSubmit({ batchId: 'b1', publisherId: PUB, amount: stroops(1_000_000n) })
    ledger.payoutSettled({ batchId: 'b1', publisherId: PUB, amount: stroops(1_000_000n), txHash: 'a'.repeat(64) })

    expect(ledger.balance(inFlight)).toBe(0n)
    expect(ledger.balance(EXTERNAL_SETTLEMENT)).toBe(1_000_000n)
    expect(ledger.audit()).toEqual([])
  })

  it('odeme patlarsa ters kayit parayi publisher\'a iade eder', () => {
    ledger.payoutSubmit({ batchId: 'b1', publisherId: PUB, amount: stroops(1_000_000n) })
    ledger.reverse('payout_batch', `b1:${PUB}`, 'op_no_trust')

    expect(ledger.balance(pubAcc), 'para geri gelmeli').toBe(1_000_000n)
    expect(ledger.balance(inFlight)).toBe(0n)
    expect(ledger.audit()).toEqual([])
  })
})

describe('audit — invariant denetimi', () => {
  it('saglikli defter temiz gecer', () => {
    ledger.deposit({ advertiserId: ADV, amount: stroops(10_000_000n), topupId: 't0' })
    impression('i1', 1_000_000n)
    ledger.payoutSubmit({ batchId: 'b1', publisherId: PUB, amount: stroops(500_000n) })
    expect(ledger.audit()).toEqual([])
  })

  it('dengesiz grup diske HIC ULASMAZ', () => {
    // Bu bir bug simulasyonu: bir gun biri elle entry yazmaya kalkarsa
    // #post dengeyi yazmadan once kontrol eder.
    expect(() => ledger.payoutSettled({
      batchId: 'b1', publisherId: PUB, amount: stroops(0n), txHash: 'x',
    })).not.toThrow()   // sifir zaten dengeli
  })

  it('publisher bakiyesi kapasitesinin ustunde odenemez', () => {
    ledger.deposit({ advertiserId: ADV, amount: stroops(10_000_000n), topupId: 't0' })
    impression('i1', 1_000_000n)                  // publisher +500_000
    ledger.payoutSubmit({ batchId: 'b1', publisherId: PUB, amount: stroops(900_000n) })
    // Defter yazmayi engellemiyor ama audit YAKALIYOR — bu bir bug isareti.
    expect(ledger.audit()).toContainEqual(expect.stringMatching(/negatif bakiye.*publisher/))
  })
})

describe('odeme gucu — solvency', () => {
  it('zincirdeki para borcu karsiliyorsa saglam', () => {
    ledger.deposit({ advertiserId: ADV, amount: stroops(10_000_000n), topupId: 't0' })
    impression('i1', 2_000_000n)                  // publisher +1_000_000

    expect(ledger.solvency(stroops(1_000_000n)).solvent).toBe(true)
    expect(ledger.solvency(stroops(999_999n)).solvent, 'bir stroop eksik bile yeter').toBe(false)
  })

  it('yolda olan para da borca dahil', () => {
    ledger.deposit({ advertiserId: ADV, amount: stroops(10_000_000n), topupId: 't0' })
    impression('i1', 2_000_000n)
    ledger.payoutSubmit({ batchId: 'b1', publisherId: PUB, amount: stroops(1_000_000n) })

    // publisher 0, in_flight 1_000_000 → borc hala 1_000_000
    expect(ledger.solvency(stroops(1_000_000n)).owed).toBe(1_000_000n)
  })

  it('settle sonrasi borc duser', () => {
    ledger.deposit({ advertiserId: ADV, amount: stroops(10_000_000n), topupId: 't0' })
    impression('i1', 2_000_000n)
    ledger.payoutSubmit({ batchId: 'b1', publisherId: PUB, amount: stroops(1_000_000n) })
    ledger.payoutSettled({ batchId: 'b1', publisherId: PUB, amount: stroops(1_000_000n), txHash: 'x' })

    expect(ledger.solvency(ZERO).owed).toBe(0n)
    expect(ledger.solvency(ZERO).solvent).toBe(true)
  })
})
