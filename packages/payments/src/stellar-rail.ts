/**
 * `PaymentRail`'in GERCEK uygulamasi — Stellar agina baglanir.
 *
 * Buraya kadarki her sey mock ray uzerinde calisti; burasi paranin fiilen
 * hareket ettigi yer. Dolayisiyla buradaki her karar geri alinamaz sonuclar
 * dogurur: zincire yazilan bir odeme geri cagirilamaz.
 *
 * Uc kural:
 *
 *   1. ENVELOPE BIR KEZ KURULUR. Retry AYNI byte'lari gonderir; yeniden
 *      insa etmek yeni bir hash uretir ve ayni odemeyi IKI KEZ yapabilir
 *      (§8 tuzak #9).
 *   2. "GONDERDIM" ODENDI DEMEK DEGIL. Yalnizca `successful === true` odendi
 *      demektir. HTTP 200 bile yeterli degil — transaction ledger'a girip
 *      basarisiz olabilir; ucret kesilir, para gitmez.
 *   3. USDC BAKIYESI YETMEZ. XLM'i biten hesap sessizce durur ve USDC alarmi
 *      susar (§8 tuzak #11). Ikisi ayri izlenir.
 */

import {
  Horizon, Keypair, TransactionBuilder, Operation, Asset, Memo,
  BASE_FEE, Networks, Account, TimeoutInfinite,
} from '@stellar/stellar-sdk'
import { stroops, type Stroops } from '@dwell/protocol'
import { toAmountString } from '@dwell/protocol'
import type {
  PaymentRail, PayoutBatch, DestinationStatus, SubmissionReceipt,
  SettlementResult, SourceAccountStatus, SettlementState,
} from './rail.js'

export interface StellarRailConfig {
  readonly horizonUrl: string
  readonly networkPassphrase: string
  /** Sicak cuzdanin gizli anahtari. Yalnizca sunucuda, secret manager'dan. */
  readonly sourceSecret: string
  /**
   * Odenecek varlik.
   *
   * §8 tuzak #8: Circle'in USDC'si kullanilir, kendi asset'imiz DEGIL. Ayni
   * kodu tasiyan farkli issuer'lar farkli varliktir; yanlis issuer'la yapilan
   * odeme, kullanicinin cuzdaninda "USDC" gorunur ama degersizdir.
   */
  readonly assetCode: string
  readonly assetIssuer: string
  /** Islem omru. Kisa tutulur: asilı kalan bir batch'i beklemek pahalidir. */
  readonly timeoutSec?: number
  /** Ucret tavani. Ag tikandiginda sinirsiz ucret odemek istemiyoruz. */
  readonly maxFeeStroops?: number
}

const DEFAULT_TIMEOUT_SEC = 180
/** Operasyon basina 10.000 stroop = 0.001 XLM. Taban ucretin ~100 kati. */
const DEFAULT_MAX_FEE = 10_000

export class StellarRail implements PaymentRail {
  readonly #server: Horizon.Server
  readonly #keypair: Keypair
  readonly #asset: Asset

  constructor(private readonly cfg: StellarRailConfig) {
    this.#server = new Horizon.Server(cfg.horizonUrl)
    this.#keypair = Keypair.fromSecret(cfg.sourceSecret)
    this.#asset = new Asset(cfg.assetCode, cfg.assetIssuer)
  }

  now(): number { return Date.now() }

  get publicKey(): string { return this.#keypair.publicKey() }

  /* ───────────────────────── hedef kontrolu ───────────────────────── */

  /**
   * Batch kurulmadan HEMEN once cagrilir.
   *
   * TOCTOU: kullanici bu kontrol ile submit arasinda trustline'ini
   * kaldirabilir. Pencereyi kapatamayiz, yalnizca daraltabiliriz — ve
   * zaten kapatmaya gerek yok: trustline'i olmayan hedef operasyonu
   * `op_no_trust` ile patlar, batch'in TAMAMI basarisiz olur ve hicbir
   * odeme yapilmaz. Yanlis odemedense hicbir odeme dogrudur.
   */
  async validateDestinations(addresses: readonly string[]): Promise<readonly DestinationStatus[]> {
    return Promise.all(addresses.map((a) => this.#one(a)))
  }

  async #one(address: string): Promise<DestinationStatus> {
    const yok: DestinationStatus = {
      address, exists: false, trustlineOk: false, authorized: false,
      memoRequired: false, trustlineLimit: 0n, trustlineBalance: 0n,
    }

    let acc: Horizon.ServerApi.AccountRecord
    try {
      acc = await this.#server.loadAccount(address) as unknown as Horizon.ServerApi.AccountRecord
    } catch (e) {
      if (isNotFound(e)) return yok
      // Horizon hatasi "hesap yok" DEGILDIR. Ikisini birlestirmek, gecici bir
      // kesinti yuzunden gercek bir alacakliyi batch'ten dusurmek demek.
      throw e
    }

    const line = (acc.balances as any[]).find(
      (b) => b.asset_code === this.cfg.assetCode && b.asset_issuer === this.cfg.assetIssuer,
    )

    return {
      address,
      exists: true,
      trustlineOk: line !== undefined,
      // `is_authorized` alani YOKSA varlik authorization gerektirmiyordur —
      // o durumda yetkili sayilir. `!== false` bilincli; `=== true` olsaydi
      // authorization kullanmayan (cogu) varlikta herkes reddedilirdi.
      authorized: line !== undefined && line.is_authorized !== false,
      // SEP-29: memo isteyen hesaba memosuz odeme borsalarda KAYBOLUR.
      memoRequired: (acc.data_attr as Record<string, string> | undefined)?.['config.memo_required'] !== undefined,
      trustlineLimit: line ? toStroopBigint(line.limit) : 0n,
      trustlineBalance: line ? toStroopBigint(line.balance) : 0n,
    }
  }

  /* ───────────────────────── kaynak hesap ───────────────────────── */

  async sourceStatus(): Promise<SourceAccountStatus> {
    const acc = await this.#server.loadAccount(this.#keypair.publicKey())
    const balances = acc.balances as any[]

    const usdc = balances.find(
      (b) => b.asset_code === this.cfg.assetCode && b.asset_issuer === this.cfg.assetIssuer,
    )
    const xlm = balances.find((b) => b.asset_type === 'native')

    // Harcanabilir XLM = bakiye − minimum bakiye − satis yukumlulukleri.
    //
    // Ham bakiyeyi kullanmak yanlis olurdu: bakiyenin buyuk kismi kilitli
    // olabilir ve hesap "2 XLM'im var" derken tek bir islemi bile
    // odeyemeyebilir.
    const subentries = (acc as any).subentry_count as number
    const sponsoring = ((acc as any).num_sponsoring as number) ?? 0
    const sponsored = ((acc as any).num_sponsored as number) ?? 0
    const minXlm = BigInt(2 + subentries + sponsoring - sponsored) * 5_000_000n
    const selling = xlm ? toStroopBigint(xlm.selling_liabilities ?? '0') : 0n
    const raw = xlm ? toStroopBigint(xlm.balance) : 0n

    return {
      address: this.#keypair.publicKey(),
      usdcBalance: stroops(usdc ? toStroopBigint(usdc.balance) : 0n),
      availableXlm: max0(raw - minXlm - selling),
      sequence: acc.sequenceNumber(),
    }
  }

  /* ───────────────────────── gonderim ───────────────────────── */

  async submitBatch(batch: PayoutBatch): Promise<SubmissionReceipt> {
    if (batch.items.length === 0) throw new Error('bos batch gonderilemez')

    const acc = await this.#server.loadAccount(this.#keypair.publicKey())
    const timeout = this.cfg.timeoutSec ?? DEFAULT_TIMEOUT_SEC
    const perOpFee = String(Math.min(this.cfg.maxFeeStroops ?? DEFAULT_MAX_FEE, Number(BASE_FEE) * 100))

    // §8 tuzak #7 — hangi item hangi operasyonda. Bu esleme SUBMIT'TEN ONCE
    // sabitlenir ve kaydedilir. Sonradan yeniden turetmeye calismak, batch
    // kismen basarisiz oldugunda kimin odendigini bilememek demek.
    const opIndex = batch.items.map((it, index) => ({ publisherId: it.publisherId, index }))

    let tb = new TransactionBuilder(acc, {
      fee: perOpFee,                          // OPERASYON BASINA — toplam degil
      networkPassphrase: this.cfg.networkPassphrase,
    })

    for (const it of batch.items) {
      tb = tb.addOperation(Operation.payment({
        destination: it.address,
        asset: this.#asset,
        // Stroop → ondalikli metin. Float'tan GECMEZ (protocol/money.ts):
        // 0.1 + 0.2 problemi burada birinin parasini eksiltirdi.
        amount: toAmountString(it.amount),
      }))
    }

    // Batch memo'su: zincirde hangi batch oldugunu gorebilmek icin. Hedefin
    // memo'su DEGIL — memo isteyen adresler zaten batch'ten dusuruluyor
    // (payout-job), cunku tek transaction'da hedefe ozel memo tasinamaz.
    const tx = tb
      .addMemo(Memo.text(batch.batchId.slice(0, 28)))
      .setTimeout(timeout)
      .build()

    tx.sign(this.#keypair)

    // Hash imzadan BAGIMSIZ olarak simdi biliniyor. Bu kritik: "gonderdim ama
    // cevap gelmedi" durumunda bile ne aradigimizi biliyoruz.
    const receipt: SubmissionReceipt = {
      batchId: batch.batchId,
      txHash: tx.hash().toString('hex'),
      envelopeXdr: tx.toEnvelope().toXDR('base64'),
      sourceSeq: tx.sequence,
      maxTime: Number(tx.timeBounds?.maxTime ?? 0) * 1000,
      feeBid: BigInt(tx.fee),
      opIndex,
    }

    try {
      await this.#server.submitTransaction(tx)
    } catch (e) {
      // Gonderim hatasi ODEME YAPILMADI DEMEK DEGIL. Zaman asimi ya da
      // baglanti kopmasi, transaction ag tarafindan kabul edildikten SONRA
      // da olabilir. Bu yuzden makbuz YINE DE donuyor: cagiran `reconcile`
      // ile zincire bakip karar verir.
      //
      // Burada throw etmek en tehlikeli hataya yol acardi: "basarisiz oldu"
      // sanip ayni odemeyi yeniden kurmak.
      if (isDefinitelyRejected(e)) {
        throw new SubmitRejected(receipt, describeError(e))
      }
    }

    return receipt
  }

  /**
   * AYNI byte'lari tekrar gonderir.
   *
   * Ag seviyesinde idempotent: ayni sequence + ayni hash, ag ikinci kez
   * uygulamaz. Yeniden insa etmek bunu bozardi.
   */
  async resubmit(receipt: SubmissionReceipt): Promise<void> {
    const tx = TransactionBuilder.fromXDR(receipt.envelopeXdr, this.cfg.networkPassphrase)
    try {
      await this.#server.submitTransaction(tx as any)
    } catch (e) {
      // `tx_bad_seq` burada IYI haber: sequence tuketilmis, yani ilk gonderim
      // aslinda gecmis. `reconcile` gercegi soyleyecek.
      if (!isDefinitelyRejected(e)) return
    }
  }

  /* ───────────────────────── mutabakat ───────────────────────── */

  /**
   * Zincire bakar ve TEK dogru cevabi verir.
   *
   * `successful === true` disindaki hicbir sey "odendi" degildir. Ledger'a
   * girmis ama basarisiz bir transaction ucret keser, para gondermez — ve
   * Horizon onu yine de dondurur.
   */
  async reconcile(receipt: SubmissionReceipt): Promise<SettlementResult> {
    let tx: any
    try {
      tx = await this.#server.transactions().transaction(receipt.txHash).call()
    } catch (e) {
      if (!isNotFound(e)) throw e
      // Zincirde yok. Sure dolduysa bu transaction ARTIK ASLA gecemez —
      // yeni sequence ile yeniden kurulabilir. Dolmadiysa beklemeye devam.
      const state: SettlementState = this.now() > receipt.maxTime ? 'expired' : 'pending'
      return { state, txHash: receipt.txHash, ledger: null, feeCharged: null, opResults: [] }
    }

    const settled = tx.successful === true
    const opResults = settled ? [] : await this.#failedOps(receipt.txHash)

    return {
      state: settled ? 'settled' : 'failed',
      txHash: receipt.txHash,
      ledger: typeof tx.ledger_attr === 'number' ? tx.ledger_attr : (tx.ledger ?? null),
      feeCharged: tx.fee_charged !== undefined ? BigInt(tx.fee_charged) : null,
      opResults,
    }
  }

  /** Hangi operasyon neden patladi — kismi basarisizligi teshis icin. */
  async #failedOps(hash: string): Promise<readonly { index: number; code: string }[]> {
    try {
      const ops = await this.#server.operations().forTransaction(hash).limit(200).call()
      return ops.records.map((o: any, index: number) => ({
        index,
        code: o.transaction_successful === false ? 'op_failed' : 'ok',
      }))
    } catch {
      // Teshis bilgisi alinamadi. Ana karar (`failed`) degismiyor.
      return []
    }
  }
}

/** Ag tarafindan KESIN olarak reddedilmis gonderim. Odeme yapilmadi. */
export class SubmitRejected extends Error {
  constructor(readonly receipt: SubmissionReceipt, message: string) {
    super(message)
    this.name = 'SubmitRejected'
  }
}

/* ───────────────────────── yardimcilar ───────────────────────── */

const max0 = (n: bigint): bigint => (n < 0n ? 0n : n)

/** `"1.2345678"` → `12345678n`. Float'a UGRAMAZ. */
export function toStroopBigint(amount: string): bigint {
  const [whole = '0', frac = ''] = amount.split('.')
  return BigInt(whole) * 10_000_000n + BigInt((frac + '0000000').slice(0, 7))
}

const isNotFound = (e: unknown): boolean =>
  (e as any)?.response?.status === 404 || (e as any)?.status === 404

/**
 * Ag transaction'i KESIN reddetti mi?
 *
 * Ayrim hayati: reddedilmis bir transaction guvenle yeniden kurulabilir,
 * belirsiz olan KURULAMAZ. Belirsizi reddedilmis saymak cifte odeme demektir,
 * bu yuzden varsayilan "belirsiz" tarafinda.
 */
function isDefinitelyRejected(e: unknown): boolean {
  const status = (e as any)?.response?.status
  // 400 = ag zarfi degerlendirdi ve reddetti. 504/timeout = bilmiyoruz.
  return status === 400
}

function describeError(e: unknown): string {
  const rc = (e as any)?.response?.data?.extras?.result_codes
  if (rc) return `${rc.transaction ?? '?'}${rc.operations ? ` [${rc.operations.join(', ')}]` : ''}`
  return e instanceof Error ? e.message : String(e)
}

/** Circle'in testnet USDC'si. §8 tuzak #8 — kendi asset'imiz DEGIL. */
export const TESTNET_USDC = {
  code: 'USDC',
  issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
} as const

export const HORIZON = {
  testnet: 'https://horizon-testnet.stellar.org',
  pubnet: 'https://horizon.stellar.org',
} as const

export { Networks }
