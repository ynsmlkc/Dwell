/**
 * Mock odeme rayi — §11 test stratejisi.
 *
 * `payments` HER ZAMAN bunun uzerinde birim test edilir; testnet yalnizca
 * ayri bir entegrasyon suite'inde. Sebebi: Kivilcim 2'de gordugumuz ariza
 * modlarini (trustline yok, tx failed ama ledger'da, zaman asimi) istedigimiz
 * anda ve deterministik olarak uretebilmek.
 */

import { type Stroops, stroops, ZERO } from '@dwell/protocol'
import type {
  PaymentRail, PayoutBatch, SubmissionReceipt, SettlementResult,
  DestinationStatus, SourceAccountStatus,
} from '../src/rail.js'

export interface MockRailOptions {
  /** Adres → durum. Tanimsiz adres "hesap yok" sayilir. */
  destinations?: Record<string, Partial<DestinationStatus>>
  usdcBalance?: bigint
  availableXlm?: bigint
  /** Bu adres batch'te varsa transaction TAMAMEN patlar (§8 tuzak #1). */
  failingAddress?: string
  /** Zarf KURULURKEN patlasin — hicbir sey gonderilmez. */
  throwOnPrepare?: boolean
  /** GONDERIM patlasin — zarf kurulmus, defter yazilmis olur. */
  throwOnSend?: boolean
  /** Mutabakat kac kez `pending` donsun. */
  pendingRounds?: number
  /** Zaman asimi senaryosu: hicbir zaman dahil edilmesin. */
  neverIncluded?: boolean
  /** Her `reconcile` cagrisinda saati bu kadar ilerlet — polling gercekci olsun. */
  advanceOnReconcile?: number
}

export class MockRail implements PaymentRail {
  #now = 1_700_000_000_000
  #seq = 1
  readonly submitted: SubmissionReceipt[] = []
  readonly resubmits: string[] = []
  /** Kurulmus zarflar — gonderilmis olanlar `submitted`'da. */
  readonly prepared: SubmissionReceipt[] = []
  #pendingLeft: number

  constructor(private readonly opts: MockRailOptions = {}) {
    this.#pendingLeft = opts.pendingRounds ?? 0
  }

  now(): number { return this.#now }
  advance(ms: number): void { this.#now += ms }

  async validateDestinations(addresses: readonly string[]): Promise<readonly DestinationStatus[]> {
    return addresses.map((address) => {
      const o = this.opts.destinations?.[address]
      return {
        address,
        exists: o?.exists ?? true,
        trustlineOk: o?.trustlineOk ?? true,
        authorized: o?.authorized ?? true,
        memoRequired: o?.memoRequired ?? false,
        trustlineLimit: o?.trustlineLimit ?? 10_000_000_000_000n,
        trustlineBalance: o?.trustlineBalance ?? 0n,
      }
    })
  }

  async sourceStatus(): Promise<SourceAccountStatus> {
    return {
      address: 'GSOURCE',
      usdcBalance: stroops(this.opts.usdcBalance ?? 1_000_000_000_000n),
      availableXlm: this.opts.availableXlm ?? 100_000_000n,
      sequence: String(this.#seq),
    }
  }

  async prepare(batch: PayoutBatch): Promise<SubmissionReceipt> {
    if (this.opts.throwOnPrepare) throw new Error('zarf kurulamadi')

    const receipt: SubmissionReceipt = {
      batchId: batch.batchId,
      // Kivilcim 2: hash submit'ten ONCE bilinir.
      txHash: `hash-${batch.batchId}`,
      envelopeXdr: `xdr-${batch.batchId}`,
      sourceSeq: String(this.#seq++),
      maxTime: this.#now + 180_000,
      feeBid: BigInt(batch.items.length) * 1000n,
      opIndex: batch.items.map((it, index) => ({ publisherId: it.publisherId, index })),
    }
    this.prepared.push(receipt)
    return receipt
  }

  async send(receipt: SubmissionReceipt): Promise<void> {
    if (this.opts.throwOnSend) throw new Error('ag reddetti')
    this.submitted.push(receipt)
    this.resubmits.push(receipt.envelopeXdr)
  }

  async reconcile(receipt: SubmissionReceipt): Promise<SettlementResult> {
    if (this.opts.advanceOnReconcile) this.#now += this.opts.advanceOnReconcile
    if (this.opts.neverIncluded) {
      return { state: 'pending', txHash: receipt.txHash, ledger: null, feeCharged: null, opResults: [] }
    }
    if (this.#pendingLeft > 0) {
      this.#pendingLeft--
      return { state: 'pending', txHash: receipt.txHash, ledger: null, feeCharged: null, opResults: [] }
    }

    const bad = this.opts.failingAddress
    const failingIndex = bad
      ? receipt.opIndex.findIndex((o) => this.#addressOf(o.publisherId) === bad)
      : -1

    if (failingIndex >= 0) {
      // §8 tuzak #7 — ledger'a GIRDI, ucret KESILDI, ama odeme olmadi.
      return {
        state: 'failed',
        txHash: receipt.txHash,
        ledger: 4_107_913,
        feeCharged: receipt.feeBid,
        opResults: receipt.opIndex.map((o) => ({
          index: o.index,
          code: o.index === failingIndex ? 'op_no_trust' : 'op_success',
        })),
      }
    }

    return {
      state: 'settled',
      txHash: receipt.txHash,
      ledger: 4_107_914,
      feeCharged: receipt.feeBid,
      opResults: receipt.opIndex.map((o) => ({ index: o.index, code: 'op_success' })),
    }
  }

  /** Test kolayligi: publisherId ile adres eslesmesi disaridan verilir. */
  addressMap: Record<string, string> = {}
  #addressOf(publisherId: string): string { return this.addressMap[publisherId] ?? '' }
}
