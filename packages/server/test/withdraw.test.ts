/**
 * Reklamveren para cekme.
 *
 * Denetimde bulundu: para giriyordu, cikmiyordu. Buradaki testlerin cogu
 * "cekebiliyor mu" degil, "cekMEmesi gereken durumda cekemiyor mu"
 * sorusunu soruyor — bir para cikisinda hata, olmamasi gereken bir
 * odemedir.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixedClock, stroops, type Stroops } from '@dwell/protocol'
import type { PaymentRail, PayoutBatch, SubmissionReceipt, SettlementState } from '@dwell/payments'
import { openDb, type Db } from '../src/store/db.js'
import { SqliteLedgerStore, SqlitePayoutStore } from '../src/store/persistent.js'
import { Ledger } from '../src/ledger/ledger.js'
import { accountId } from '../src/ledger/accounts.js'
import { WithdrawService, MIN_WITHDRAW } from '../src/advertisers/withdraw.js'

const ADV = 'GA' + 'A'.repeat(53) + 'WHF5'

class SahteRail implements PaymentRail {
  sonuc: SettlementState = 'settled'
  trustline = true
  hesapVar = true
  memoIster = false
  prepareVar = true
  gonderilen: PayoutBatch[] = []
  #n = 0
  constructor(private clock: { now: () => number }) {}
  now() { return this.clock.now() }
  async validateDestinations(a: readonly string[]) {
    return a.map((address) => ({
      address, exists: this.hesapVar, trustlineOk: this.trustline, authorized: true,
      memoRequired: this.memoIster, trustlineLimit: 10n ** 15n, trustlineBalance: 0n,
    }))
  }
  async sourceStatus() {
    return { address: 'GHOT', usdcBalance: stroops(10n ** 12n), availableXlm: 10n ** 9n, sequence: '1' }
  }
  async prepare(batch: PayoutBatch): Promise<SubmissionReceipt> {
    if (!this.prepareVar) throw new Error('zarf kurulamadi')
    this.gonderilen.push(batch)
    return {
      batchId: batch.batchId, txHash: `h${++this.#n}`.padEnd(64, '0'),
      envelopeXdr: `xdr-${batch.batchId}`, sourceSeq: String(this.#n),
      maxTime: this.clock.now() + 180_000, feeBid: 100n,
      opIndex: batch.items.map((it, index) => ({ publisherId: it.publisherId, index })),
    }
  }
  async send() {}
  async reconcile(r: SubmissionReceipt) {
    return { state: this.sonuc, txHash: r.txHash, ledger: 1, feeCharged: 100n, opResults: [] }
  }
}

let dir: string, db: Db
const clock = fixedClock(1_700_000_000_000)
let n = 0

function kur(spendable: bigint, bakiye = spendable) {
  const ids = () => `id-${++n}`
  const ledger = new Ledger(new SqliteLedgerStore(db, clock, ids), clock, ids)
  if (bakiye > 0n) ledger.deposit({ advertiserId: ADV, amount: stroops(bakiye), topupId: `t-${++n}` })
  const rail = new SahteRail(clock)
  const loglar: string[] = []
  const svc = new WithdrawService({
    clock, ledger, rail, store: new SqlitePayoutStore(db),
    spendable: () => stroops(spendable),
    newBatchId: () => `w-${++n}`,
    log: (m) => loglar.push(m),
  })
  return { svc, ledger, rail, loglar }
}

const bakiye = (l: Ledger) => l.balance(accountId('advertiser', ADV))

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dwell-w-')); db = openDb(join(dir, 'w.db')); n = 0 })
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

describe('para cekme', () => {
  it('harcanmamis butce cekilir ve defterden DUSER', async () => {
    const t = kur(20_000_000n)
    const r = await t.svc.withdraw(ADV, stroops(20_000_000n))

    expect(r.ok).toBe(true)
    expect(bakiye(t.ledger)).toBe(0n)
    expect(t.ledger.audit()).toEqual([])
  })

  it('kismi cekimde kalan durur', async () => {
    const t = kur(20_000_000n)
    await t.svc.withdraw(ADV, stroops(8_000_000n))
    expect(bakiye(t.ledger)).toBe(12_000_000n)
  })

  it('para KENDI adresine gider, baska yere degil', async () => {
    const t = kur(20_000_000n)
    await t.svc.withdraw(ADV, stroops(20_000_000n))
    expect(t.rail.gonderilen[0]!.items[0]!.address).toBe(ADV)
  })

  /**
   * En onemli kural. Teslim edilmis ama henuz raporlanmamis reklamlarin
   * karsiligi rezervede. Cekilebilseydi reklamveren reklamini gosterttirip
   * parasini geri alir, yayinci karsiligini alamazdi.
   */
  it('REZERVE edilmis para cekilemez', async () => {
    // Bakiye 20, harcanabilir yalnizca 5 — gerisi teslim edilmis reklamlarda.
    const t = kur(5_000_000n, 20_000_000n)
    const r = await t.svc.withdraw(ADV, stroops(20_000_000n))

    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toContain('raporlanmamis')
    expect(bakiye(t.ledger)).toBe(20_000_000n)      // hicbir sey hareket etmedi
  })

  it('harcanabilir tutarin tamami cekilebilir', async () => {
    const t = kur(5_000_000n, 20_000_000n)
    expect((await t.svc.withdraw(ADV, stroops(5_000_000n))).ok).toBe(true)
    expect(bakiye(t.ledger)).toBe(15_000_000n)
  })

  it('esigin altindaki toz cekilemez', async () => {
    const t = kur(20_000_000n)
    const r = await t.svc.withdraw(ADV, stroops(MIN_WITHDRAW - 1n))
    expect(r.ok).toBe(false)
    expect(bakiye(t.ledger)).toBe(20_000_000n)
  })

  /* ── cuzdan kontrolleri ── */

  it('USDC kabulu olmayan cuzdana gonderilmez', async () => {
    const t = kur(20_000_000n)
    t.rail.trustline = false
    const r = await t.svc.withdraw(ADV, stroops(20_000_000n))

    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toContain('trustline')
    // Para yerinde: gonderilemeyen odeme defterden DUSMEZ.
    expect(bakiye(t.ledger)).toBe(20_000_000n)
    expect(t.rail.gonderilen).toHaveLength(0)
  })

  it('zincirde olmayan hesaba gonderilmez', async () => {
    const t = kur(20_000_000n)
    t.rail.hesapVar = false
    expect((await t.svc.withdraw(ADV, stroops(20_000_000n))).ok).toBe(false)
    expect(bakiye(t.ledger)).toBe(20_000_000n)
  })

  it('memo isteyen adrese gonderilmez', async () => {
    const t = kur(20_000_000n)
    t.rail.memoIster = true
    expect((await t.svc.withdraw(ADV, stroops(20_000_000n))).ok).toBe(false)
    expect(bakiye(t.ledger)).toBe(20_000_000n)
  })

  /* ── ariza modlari ── */

  it('zincirde patlarsa para GERI DONER', async () => {
    const t = kur(20_000_000n)
    t.rail.sonuc = 'failed'
    const r = await t.svc.withdraw(ADV, stroops(20_000_000n))

    expect(r.ok).toBe(false)
    expect(bakiye(t.ledger)).toBe(20_000_000n)      // iade edildi
    expect(t.ledger.audit()).toEqual([])
  })

  it('sure dolarsa da iade edilir', async () => {
    const t = kur(20_000_000n)
    t.rail.sonuc = 'expired'
    await t.svc.withdraw(ADV, stroops(20_000_000n))
    expect(bakiye(t.ledger)).toBe(20_000_000n)
  })

  /**
   * "Bilmiyorum"u "olmadi" saymak, zincirde gecmis bir odemeyi ikinci kez
   * yapmak demek. Belirsizde para YOLDA kalir, iade EDILMEZ.
   */
  it('belirsiz kalirsa iade EDILMEZ, yolda bekler', async () => {
    const t = kur(20_000_000n)
    t.rail.sonuc = 'pending'
    const r = await t.svc.withdraw(ADV, stroops(20_000_000n))

    expect(r.ok).toBe(false)
    expect(bakiye(t.ledger)).toBe(0n)                                  // hesaptan cikti
    expect(t.ledger.balance(accountId('payouts_in_flight'))).toBe(20_000_000n)  // ama yolda
  })

  it('zarf kurulamazsa hicbir kayit yazilmaz', async () => {
    const t = kur(20_000_000n)
    t.rail.prepareVar = false
    const r = await t.svc.withdraw(ADV, stroops(20_000_000n))

    expect(r.ok).toBe(false)
    expect(r.ok === false && r.retryable).toBe(true)
    expect(bakiye(t.ledger)).toBe(20_000_000n)
  })

  /**
   * Iki cekim ayni anda calisirsa ikisi de ayni bakiyeyi gorur ve toplami
   * bakiyeyi asar.
   */
  it('ayni anda iki cekim calismaz', async () => {
    const t = kur(20_000_000n)
    const [a, b] = await Promise.all([
      t.svc.withdraw(ADV, stroops(20_000_000n)),
      t.svc.withdraw(ADV, stroops(20_000_000n)),
    ])
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1)
    expect(t.rail.gonderilen).toHaveLength(1)
  })

  it('cekim sonrasi defter invariantlari saglam', async () => {
    const t = kur(20_000_000n)
    await t.svc.withdraw(ADV, stroops(12_000_000n))
    expect(t.ledger.audit()).toEqual([])
  })

  it('cekilebilir tutar esigin altindaysa sifir gosterilir', () => {
    const t = kur(MIN_WITHDRAW - 1n)
    expect(t.svc.available(ADV)).toBe(0n)
  })
})
