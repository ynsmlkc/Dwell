/**
 * GERCEK testnet odemesi — SOW Teslim 3'un kaniti.
 *
 * Bu suite Stellar testnet'ine baglanir ve gercekten para gonderir. Birim
 * testlerden ayri tutulmasinin sebebi bu: yavas, ag gerektirir, ve mock
 * ile kanitlanamayacak seyleri kanitlar.
 *
 *   pnpm --filter @dwell/payments test:testnet
 *
 * Kanitlanan sey (SOW bitti kriteri):
 *   "Testnet'te uc adrese tek islemde odeme, stellar.expert'te gorunuyor;
 *    trustline'siz hedef batch'ten dusurulmus ve islem yine basarili."
 *
 * VARLIK NOTU: burada kendi test varligimizi (`TSTUSD`) basiyoruz, Circle'in
 * USDC'sini degil. Sebep pratik: Circle testnet USDC'si yalnizca elle
 * doldurulan bir faucet'ten geliyor, otomatik testte alinamiyor. Kanitlanan
 * MEKANIZMA ayni — trustline, yetki, batch, mutabakat. Uretimde
 * `TESTNET_USDC` sabiti kullanilir; hangi varlik oldugu YALNIZCA config
 * meselesi, kod ayni.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import {
  Keypair, Horizon, TransactionBuilder, Operation, Asset, BASE_FEE, Networks,
} from '@stellar/stellar-sdk'
import { systemClock, stroops, cryptoIdGenerator } from '@dwell/protocol'
import { StellarRail, HORIZON, toStroopBigint } from '../../src/stellar-rail.js'
import { PayoutJob, type PayoutItem } from '../../src/payout-job.js'
import { WalletStore } from '../../src/wallet.js'

const HZ = new Horizon.Server(HORIZON.testnet)
const NET = Networks.TESTNET
const clock = systemClock
const ids = cryptoIdGenerator(clock)

/** Testnet hesap kurma yavas; tek sefer yapilir. */
const TIMEOUT = 180_000

async function fund(kp: Keypair): Promise<void> {
  const r = await fetch(`https://friendbot.stellar.org?addr=${kp.publicKey()}`)
  if (!r.ok && r.status !== 400) throw new Error(`friendbot ${r.status}`)
}

async function submit(kp: Keypair, build: (tb: TransactionBuilder) => TransactionBuilder): Promise<void> {
  const acc = await HZ.loadAccount(kp.publicKey())
  const tx = build(new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: NET }))
    .setTimeout(120).build()
  tx.sign(kp)
  await HZ.submitTransaction(tx)
}

async function balanceOf(address: string, asset: Asset): Promise<bigint> {
  const acc = await HZ.loadAccount(address)
  const b = (acc.balances as any[]).find(
    (x) => x.asset_code === asset.getCode() && x.asset_issuer === asset.getIssuer(),
  )
  return b ? toStroopBigint(b.balance) : 0n
}

describe.skipIf(!process.env['DWELL_TESTNET'])('testnet odemesi', () => {
  const issuer = Keypair.random()
  const hot = Keypair.random()
  const alice = Keypair.random()      // trustline VAR
  const bob = Keypair.random()        // trustline VAR
  const carol = Keypair.random()      // trustline YOK — dusurulmeli

  let asset: Asset
  let rail: StellarRail

  beforeAll(async () => {
    asset = new Asset('TSTUSD', issuer.publicKey())

    await Promise.all([issuer, hot, alice, bob, carol].map(fund))

    // Trustline'lar. Carol bilerek disarida.
    await Promise.all([hot, alice, bob].map((kp) =>
      submit(kp, (tb) => tb.addOperation(Operation.changeTrust({ asset }))),
    ))

    // Sicak cuzdani fonla.
    await submit(issuer, (tb) => tb.addOperation(Operation.payment({
      destination: hot.publicKey(), asset, amount: '1000',
    })))

    rail = new StellarRail({
      horizonUrl: HORIZON.testnet,
      networkPassphrase: NET,
      sourceSecret: hot.secret(),
      assetCode: asset.getCode(),
      assetIssuer: asset.getIssuer(),
    })
  }, TIMEOUT)

  it('kaynak hesap durumu dogru okunur — USDC ve XLM AYRI', async () => {
    const s = await rail.sourceStatus()
    expect(s.address).toBe(hot.publicKey())
    expect(s.usdcBalance).toBe(1_000_0000000n)

    // XLM ayri izlenir: USDC'si dolu ama XLM'i biten hesap sessizce durur.
    // Harcanabilir XLM minimum bakiye dusulmus hali — ham bakiye DEGIL.
    expect(s.availableXlm).toBeGreaterThan(0n)
    const acc = await HZ.loadAccount(hot.publicKey())
    const raw = toStroopBigint((acc.balances as any[]).find((b) => b.asset_type === 'native').balance)
    expect(s.availableXlm).toBeLessThan(raw)
  }, TIMEOUT)

  it('hedef kontrolu trustline\'i olani ve olmayani ayirir', async () => {
    const [a, b, c, yok] = await rail.validateDestinations([
      alice.publicKey(), bob.publicKey(), carol.publicKey(), Keypair.random().publicKey(),
    ])

    expect(a!.exists && a!.trustlineOk && a!.authorized).toBe(true)
    expect(b!.trustlineOk).toBe(true)

    // Carol hesap olarak VAR ama trustline'i YOK. Ikisi farkli sey.
    expect(c!.exists).toBe(true)
    expect(c!.trustlineOk).toBe(false)

    // Hic olusturulmamis hesap.
    expect(yok!.exists).toBe(false)
  }, TIMEOUT)

  /**
   * SOW bitti kriteri. Uc aday, biri trustline'siz.
   */
  it('uc adaydan ikisi TEK islemde odenir, trustline\'siz olan dusurulur', async () => {
    const wallets = new WalletStore({ clock, holdMs: 0, notify: () => {} })
    wallets.bind('pub-alice', alice.publicKey(), 'testnet')
    wallets.bind('pub-bob', bob.publicKey(), 'testnet')
    wallets.bind('pub-carol', carol.publicKey(), 'testnet')

    const submitted: { batchId: string; items: readonly PayoutItem[]; txHash: string }[] = []
    const settled: { batchId: string; txHash: string; items: readonly PayoutItem[] }[] = []
    const skipped: { publisherId: string; reason: string }[] = []
    const failed: { reason: string }[] = []

    const job = new PayoutJob({
      clock, rail, wallets,
      candidates: () => [
        { publisherId: 'pub-alice', payable: stroops(25_000_000n) },   // 2.5
        { publisherId: 'pub-bob', payable: stroops(13_500_000n) },     // 1.35
        { publisherId: 'pub-carol', payable: stroops(99_000_000n) },   // 9.9 — gitmemeli
      ],
      threshold: stroops(10_000_000n),
      newBatchId: () => `it-${ids.impressionId().slice(-10)}`,
      onSubmit: (batchId, items, r) => submitted.push({ batchId, items, txHash: r.txHash }),
      onSettled: (batchId, items, txHash) => settled.push({ batchId, items, txHash }),
      onFailed: (_b, _i, reason) => failed.push({ reason }),
      onSkipped: (publisherId, reason) => skipped.push({ publisherId, reason }),
    })

    const result = await job.run()

    // Carol dusuruldu — ve SEBEBI kullaniciya gosterilebilir halde.
    expect(skipped.map((s) => s.publisherId)).toEqual(['pub-carol'])
    expect(skipped[0]!.reason).toContain('trustline')

    // Diger ikisi odendi, islem BASARILI.
    expect(failed).toEqual([])
    expect(result.paid).toBe(2)
    expect(result.batches).toBe(1)
    expect(settled).toHaveLength(1)

    // Tek transaction — iki ayri islem degil.
    expect(new Set(submitted.map((s) => s.txHash)).size).toBe(1)

    // Zincirde gercekten var ve gercekten basarili.
    const tx = await HZ.transactions().transaction(settled[0]!.txHash).call()
    expect(tx.successful).toBe(true)
    expect(tx.operation_count).toBe(2)

    // Ve para GERCEKTEN ulasti. "Gonderildi" degil, "vardi".
    expect(await balanceOf(alice.publicKey(), asset)).toBe(25_000_000n)
    expect(await balanceOf(bob.publicKey(), asset)).toBe(13_500_000n)
    expect(await balanceOf(carol.publicKey(), asset)).toBe(0n)

    // eslint-disable-next-line no-console
    console.log(`\n  stellar.expert: https://stellar.expert/explorer/testnet/tx/${settled[0]!.txHash}\n`)
  }, TIMEOUT)

  /**
   * §8 tuzak #9 — retry AYNI byte'lari gonderir.
   *
   * Yeniden insa etmek yeni bir hash uretir ve ayni odemeyi IKI KEZ yapar.
   */
  it('ayni envelope tekrar gonderilince IKINCI odeme OLMAZ', async () => {
    const once = await rail.prepare({
      batchId: `it-tekrar-${Date.now()}`,
      items: [{ publisherId: 'pub-alice', address: alice.publicKey(), amount: stroops(1_000_000n) }],
    })
    await rail.send(once)

    const sonra = await balanceOf(alice.publicKey(), asset)
    expect((await rail.reconcile(once)).state).toBe('settled')

    // Ayni byte'lar tekrar. Ag `tx_bad_seq` ile reddeder — sequence tuketilmis.
    await rail.send(once)
    await rail.send(once)

    expect(await balanceOf(alice.publicKey(), asset)).toBe(sonra)
    expect((await rail.reconcile(once)).state).toBe('settled')
  }, TIMEOUT)

  /**
   * Odemeyi "gonderdim" degil "zincirde basarili" tanimliyoruz.
   *
   * Trustline'siz bir hedefi zorla batch'e koyarsak transaction ledger'a
   * girer, ucret KESILIR, ama para GITMEZ. Bunu "odendi" saymak, defterde
   * olmayan bir odemeyi kayitli tutmak demekti.
   */
  it('basarisiz transaction "odendi" SAYILMAZ', async () => {
    let receipt
    try {
      receipt = await rail.prepare({
        batchId: `it-basarisiz-${Date.now()}`,
        items: [{ publisherId: 'pub-carol', address: carol.publicKey(), amount: stroops(1_000_000n) }],
      })
      await rail.send(receipt)
    } catch (e: any) {
      // Horizon bunu 400 ile pesinen reddedebilir — o da dogru sonuc:
      // odeme yapilmadi ve makbuz elimizde.
      expect(e.name).toBe('SubmitRejected')
      expect(await balanceOf(carol.publicKey(), asset)).toBe(0n)
      return
    }

    const r = await rail.reconcile(receipt)
    expect(r.state).not.toBe('settled')
    expect(await balanceOf(carol.publicKey(), asset)).toBe(0n)
  }, TIMEOUT)

  it('bilinmeyen hash bekliyor veya suresi dolmus doner — ASLA settled', async () => {
    const sahte = {
      batchId: 'yok', txHash: 'a'.repeat(64), envelopeXdr: '', sourceSeq: '0',
      maxTime: Date.now() - 1000, feeBid: 100n, opIndex: [],
    }
    expect((await rail.reconcile(sahte)).state).toBe('expired')
    expect((await rail.reconcile({ ...sahte, maxTime: Date.now() + 60_000 })).state).toBe('pending')
  }, TIMEOUT)
})
