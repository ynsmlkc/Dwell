/**
 * Odeme turu — defter, kayit ve zincirin birlikte dogru kalmasi.
 *
 * Buradaki testler tek tek bilesenlerin degil, ARALARINDAKI SIRANIN testi.
 * Her biri gercek bir para kaybi ya da cifte odeme senaryosuna karsilik
 * geliyor; hicbiri "acaba olur mu" degil, "olursa ne olur" sorusundan
 * turedi.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { fixedClock, stroops, type Stroops } from '@dwell/protocol'
import { WalletStore, type PaymentRail, type SubmissionReceipt, type PayoutBatch } from '@dwell/payments'
import { Ledger } from '../src/ledger/ledger.js'
import { MemoryLedgerStore } from '../src/ledger/memory-store.js'
import { accountId } from '../src/ledger/accounts.js'
import { PayoutRunner, schedulePayouts } from '../src/payouts/runner.js'
import { MemoryPayoutStore } from '../src/payouts/store.js'

const ADDR: Record<string, string> = {
  alice: 'GA' + 'A'.repeat(53) + 'WHF5',
  bob: 'GB' + 'B'.repeat(53) + 'WHF5',
}

/** Zinciri taklit eder; her adimda ne olacagi testten kontrol edilir. */
class SahteRail implements PaymentRail {
  gonderilen: PayoutBatch[] = []
  sonuc: 'settled' | 'failed' | 'pending' | 'expired' = 'settled'
  submitPatlar = false
  reconcilePatlar = false
  #n = 0

  constructor(private readonly clock: { now: () => number }) {}

  now(): number { return this.clock.now() }

  async validateDestinations(addresses: readonly string[]) {
    return addresses.map((address) => ({
      address, exists: true, trustlineOk: true, authorized: true,
      memoRequired: false, trustlineLimit: 10n ** 15n, trustlineBalance: 0n,
    }))
  }

  async sourceStatus() {
    return {
      address: 'GHOT', usdcBalance: stroops(10n ** 12n),
      availableXlm: 100n * 10_000_000n, sequence: '1',
    }
  }

  async prepare(batch: PayoutBatch): Promise<SubmissionReceipt> {
    if (this.submitPatlar) throw new Error('zincir reddetti')
    this.gonderilen.push(batch)
    return {
      batchId: batch.batchId,
      txHash: `hash${++this.#n}`.padEnd(64, '0'),
      envelopeXdr: `xdr-${batch.batchId}`,
      sourceSeq: String(this.#n),
      maxTime: this.clock.now() + 180_000,
      feeBid: 100n * BigInt(batch.items.length),
      opIndex: batch.items.map((it, index) => ({ publisherId: it.publisherId, index })),
    }
  }

  async send(): Promise<void> {}

  async reconcile(receipt: SubmissionReceipt) {
    if (this.reconcilePatlar) throw new Error('horizon dustu')
    return {
      state: this.sonuc, txHash: receipt.txHash,
      ledger: this.sonuc === 'settled' ? 42 : null,
      feeCharged: 200n, opResults: [],
    }
  }
}

function kur(over: { threshold?: Stroops } = {}) {
  const clock = fixedClock(1_700_000_000_000)
  let n = 0
  const ids = () => `id-${++n}`
  const ledger = new Ledger(new MemoryLedgerStore(clock, ids), clock, ids)
  const store = new MemoryPayoutStore()
  const wallets = new WalletStore({ clock, holdMs: 0, notify: () => {} })
  const rail = new SahteRail(clock)
  const loglar: string[] = []

  const runner = new PayoutRunner({
    clock, rail, wallets, ledger, store,
    threshold: over.threshold ?? stroops(10_000_000n),
    newBatchId: () => `batch-${++n}`,
    log: (m) => loglar.push(m),
  })

  /** Publisher'a defterde para yazar — gosterim boru hattini atlayarak. */
  const kazandir = (publisherId: string, amount: bigint): void => {
    ledger.deposit({ advertiserId: 'adv', amount: stroops(amount * 2n), topupId: `t-${++n}` })
    ledger.postImpression({
      impressionId: `imp-${n}`, publisherId, advertiserId: 'adv',
      campaignId: 'c1', rate: stroops(amount * 2n), revShareBps: 5000,
    })
  }

  const bakiye = (p: string): bigint => ledger.balance(accountId('publisher', p))

  return { clock, ledger, store, wallets, rail, runner, loglar, kazandir, bakiye }
}

describe('PayoutRunner', () => {
  let t: ReturnType<typeof kur>
  beforeEach(() => {
    t = kur()
    t.wallets.bind('alice', ADDR['alice']!, 'testnet')
    t.wallets.bind('bob', ADDR['bob']!, 'testnet')
  })

  it('esigi gecenler aday, gecmeyenler degil', () => {
    t.kazandir('alice', 25_000_000n)
    t.kazandir('bob', 3_000_000n)

    expect(t.runner.candidates().map((c) => c.publisherId)).toEqual(['alice'])
  })

  it('odeme akinca bakiye defterden DUSER ve zincire gider', async () => {
    t.kazandir('alice', 25_000_000n)
    const r = await t.runner.run()

    expect(r.paid).toBe(1)
    expect(t.bakiye('alice')).toBe(0n)
    expect(t.rail.gonderilen).toHaveLength(1)
    expect(t.rail.gonderilen[0]!.items[0]!.address).toBe(ADDR['alice'])
  })

  /**
   * SIRA TESTI. Defter, zincire gonderimden ONCE yazilmali.
   *
   * Tersi olsa ve sunucu arada dusse, para zincirde giderdi ama defterde
   * hala odenebilir gorunurdu — ayni para ikinci kez odenirdi.
   */
  it('defter zincirden ONCE yazilir', async () => {
    t.kazandir('alice', 25_000_000n)

    let bakiyeSubmitAninda: bigint | null = null
    // Zarf kurulup gonderildigi ANDA defterdeki bakiyeye bak.
    t.rail.send = async () => { bakiyeSubmitAninda = t.bakiye('alice') }

    await t.runner.run()

    // Zincire gonderildigi ANDA defterde para artik odenebilir degil.
    expect(bakiyeSubmitAninda).toBe(0n)
  })

  it('zincirde patlarsa para publisher\'a GERI DONER', async () => {
    t.kazandir('alice', 25_000_000n)
    t.rail.sonuc = 'failed'

    await t.runner.run()

    // Para kaybolmadi — iade edildi ve tekrar odenebilir.
    expect(t.bakiye('alice')).toBe(25_000_000n)
    expect(t.ledger.audit()).toEqual([])
  })

  it('sure dolarsa da iade edilir', async () => {
    t.kazandir('alice', 25_000_000n)
    t.rail.sonuc = 'expired'
    await t.runner.run()
    expect(t.bakiye('alice')).toBe(25_000_000n)
  })

  it('odeme sonrasi defter invariantlari saglam', async () => {
    t.kazandir('alice', 25_000_000n)
    t.kazandir('bob', 40_000_000n)
    await t.runner.run()
    expect(t.ledger.audit()).toEqual([])
  })

  /* ─────────────── payout_items kaydi ─────────────── */

  it('kayit op_index, envelope ve adres SNAPSHOT\'ini tutar', async () => {
    t.kazandir('alice', 25_000_000n)
    await t.runner.run()

    const [kayit] = t.store.forPublisher('alice')
    expect(kayit!.opIndex).toBe(0)
    expect(kayit!.envelopeXdr).toContain('xdr-')
    expect(kayit!.destinationAddress).toBe(ADDR['alice'])
    expect(kayit!.state).toBe('settled')
  })

  /**
   * Adres SNAPSHOT. Kullanici odemeden sonra cuzdanini degistirirse,
   * "nereye gonderdik" sorusunun cevabi o anki adres olmali.
   */
  it('sonradan cuzdan degisse bile kayittaki adres degismez', async () => {
    t.kazandir('alice', 25_000_000n)
    await t.runner.run()

    t.wallets.bind('alice', ADDR['bob']!, 'testnet')

    expect(t.store.forPublisher('alice')[0]!.destinationAddress).toBe(ADDR['alice'])
  })

  it('kalemler tek transaction\'da, farkli op_index\'lerde', async () => {
    t.kazandir('alice', 25_000_000n)
    t.kazandir('bob', 40_000_000n)
    await t.runner.run()

    const a = t.store.forPublisher('alice')[0]!
    const b = t.store.forPublisher('bob')[0]!
    expect(a.txHash).toBe(b.txHash)          // ayni islem
    expect(a.opIndex).not.toBe(b.opIndex)    // farkli operasyon
  })

  /* ─────────────── yeniden baslatma ─────────────── */

  /**
   * Submit ile reconcile ARASINDA sunucu duserse para `payouts_in_flight`'ta
   * asili kalir. Envelope saklandigi icin zincire sorup karar verebiliyoruz.
   */
  it('asili kalan batch yeniden baslatmada zincire sorulur ve cozulur', async () => {
    t.kazandir('alice', 25_000_000n)

    // Sunucu submit'ten hemen sonra dustu: defter + kayit yazildi,
    // reconcile hic calismadi.
    const receipt = await t.rail.prepare({
      batchId: 'batch-kayip',
      items: [{ publisherId: 'alice', address: ADDR['alice']!, amount: stroops(25_000_000n) }],
    })
    t.ledger.payoutSubmit({ batchId: 'batch-kayip', publisherId: 'alice', amount: stroops(25_000_000n) })
    t.store.recordSubmit({
      receipt,
      items: [{ publisherId: 'alice', address: ADDR['alice']!, amount: stroops(25_000_000n) }],
      at: t.clock.now(),
    })

    expect(t.ledger.balance(accountId('payouts_in_flight'))).toBe(25_000_000n)
    expect(t.store.unresolved()).toHaveLength(1)

    const cozulen = await t.runner.resumeUnresolved()

    expect(cozulen).toBe(1)
    expect(t.ledger.balance(accountId('payouts_in_flight'))).toBe(0n)
    expect(t.store.forPublisher('alice')[0]!.state).toBe('settled')
  })

  /**
   * "Bilmiyorum"u "basarisiz"a cevirmek, zincirde gecmis bir odemeyi iade
   * etmek olurdu — yani ayni parayi iki kez vermek.
   */
  it('zincire ulasilamiyorsa asili batch IADE EDILMEZ, bekler', async () => {
    t.kazandir('alice', 25_000_000n)
    const receipt = await t.rail.prepare({
      batchId: 'batch-belirsiz',
      items: [{ publisherId: 'alice', address: ADDR['alice']!, amount: stroops(25_000_000n) }],
    })
    t.ledger.payoutSubmit({ batchId: 'batch-belirsiz', publisherId: 'alice', amount: stroops(25_000_000n) })
    t.store.recordSubmit({
      receipt,
      items: [{ publisherId: 'alice', address: ADDR['alice']!, amount: stroops(25_000_000n) }],
      at: t.clock.now(),
    })

    t.rail.reconcilePatlar = true
    expect(await t.runner.resumeUnresolved()).toBe(0)

    // Kayit hala acik, para hala yolda, hicbir sey uydurulmadi.
    expect(t.store.unresolved()).toHaveLength(1)
    expect(t.ledger.balance(accountId('payouts_in_flight'))).toBe(25_000_000n)
    expect(t.bakiye('alice')).toBe(0n)
  })

  it('hala bekleyen batch karara baglanmaz', async () => {
    t.kazandir('alice', 25_000_000n)
    const receipt = await t.rail.prepare({
      batchId: 'b-bekliyor',
      items: [{ publisherId: 'alice', address: ADDR['alice']!, amount: stroops(25_000_000n) }],
    })
    t.ledger.payoutSubmit({ batchId: 'b-bekliyor', publisherId: 'alice', amount: stroops(25_000_000n) })
    t.store.recordSubmit({
      receipt, items: [{ publisherId: 'alice', address: ADDR['alice']!, amount: stroops(25_000_000n) }],
      at: t.clock.now(),
    })

    t.rail.sonuc = 'pending'
    expect(await t.runner.resumeUnresolved()).toBe(0)
    expect(t.store.forPublisher('alice')[0]!.state).toBe('submitted')
  })

  /* ─────────────── es zamanlilik ─────────────── */

  /**
   * Iki tur ayni anda calisirsa ikisi de ayni bakiyeyi gorur ve ayni parayi
   * iki kez gondermeye calisir. Defter ikinciyi reddeder ama gonderim ondan
   * once oluyor — yani zincire iki odeme gider.
   */
  it('ayni anda iki tur calismaz', async () => {
    t.kazandir('alice', 25_000_000n)
    const [a, b] = await Promise.all([t.runner.run(), t.runner.run()])

    const toplam = a.batches + b.batches
    expect(toplam).toBe(1)
    expect(t.rail.gonderilen).toHaveLength(1)
    expect([a, b].some((r) => r.alerts.includes('tur zaten calisiyor'))).toBe(true)
  })

  it('ust uste iki tur ayni parayi iki kez odemez', async () => {
    t.kazandir('alice', 25_000_000n)
    await t.runner.run()
    const ikinci = await t.runner.run()

    expect(ikinci.paid).toBe(0)
    expect(t.rail.gonderilen).toHaveLength(1)
  })

  it('atlananin SEBEBI kayda gecer', async () => {
    t.kazandir('carol', 25_000_000n)     // cuzdani bagli degil
    const r = await t.runner.run()

    expect(r.skipReasons.map((s) => s.publisherId)).toContain('carol')
    expect(r.skipReasons[0]!.reason).toBeTruthy()
  })
})

describe('schedulePayouts', () => {
  it('patlayan tur zamanlamayi DURDURMAZ', async () => {
    const loglar: string[] = []
    let n = 0
    const sahte = {
      run: async () => { n++; if (n === 1) throw new Error('gecici ag hatasi'); return { batches: 1, paid: 1, skipped: 0, failed: 0, totalPaid: stroops(0n), alerts: [], skipReasons: [] } },
    } as unknown as PayoutRunner

    const h = schedulePayouts(sahte, 5, (m) => loglar.push(m))
    await new Promise((r) => setTimeout(r, 60))
    h.stop()

    expect(n).toBeGreaterThan(1)
    expect(loglar.some((l) => l.includes('patladi'))).toBe(true)
  })

  it('stop cagrilinca yeni tur baslamaz', async () => {
    let n = 0
    const sahte = {
      run: async () => { n++; return { batches: 0, paid: 0, skipped: 0, failed: 0, totalPaid: stroops(0n), alerts: [], skipReasons: [] } },
    } as unknown as PayoutRunner

    const h = schedulePayouts(sahte, 5, () => {})
    await new Promise((r) => setTimeout(r, 30))
    h.stop()
    const durdugunda = n
    await new Promise((r) => setTimeout(r, 40))

    expect(n).toBe(durdugunda)
  })
})
