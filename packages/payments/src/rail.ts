/**
 * Odeme rayi — §6.4.
 *
 * Stellar'a dokunan her sey bu arayuzun arkasinda. Sebebi test edilebilirlik:
 * `payments` her zaman mock rail ile birim test edilir, testnet yalnizca ayri
 * bir entegrasyon suite'inde kullanilir (§11).
 */

import type { Stroops } from '@dwell/protocol'

export interface DestinationStatus {
  readonly address: string
  readonly exists: boolean
  readonly trustlineOk: boolean
  readonly authorized: boolean
  readonly memoRequired: boolean
  readonly trustlineLimit: bigint
  readonly trustlineBalance: bigint
}

export interface PayoutItem {
  readonly publisherId: string
  readonly address: string
  readonly amount: Stroops
}

export interface PayoutBatch {
  readonly batchId: string
  readonly items: readonly PayoutItem[]
}

/**
 * Submit sonucu.
 *
 * `hash` submit'ten ONCE biliniyor (Kivilcim 2'de kanitlandi): transaction'in
 * hash'i imzalardan bagimsiz olarak yerel hesaplanabiliyor. Bu yuzden "submit
 * ettim ama cevap gelmedi" durumunda bile mutabakat kurulabilir.
 */
export interface SubmissionReceipt {
  readonly batchId: string
  readonly txHash: string
  /** ADR §8 tuzak #9 — retry AYNI byte'lari gonderir, yeniden insa etmez. */
  readonly envelopeXdr: string
  readonly sourceSeq: string
  /** Bu zamandan sonra transaction kesin olarak olu sayilir. */
  readonly maxTime: number
  readonly feeBid: bigint
  /** Hangi item hangi operation indeksinde — §8 tuzak #7. */
  readonly opIndex: readonly { publisherId: string; index: number }[]
}

export type SettlementState =
  /** Zincirde ve BASARILI. Tek dogru "odendi" tanimi. */
  | 'settled'
  /** Ledger'a girdi ama `successful === false`. Ucret kesildi, para gitmedi. */
  | 'failed'
  /** Henuz dahil edilmedi. `maxTime` gecmediyse AYNI envelope tekrar gonderilir. */
  | 'pending'
  /** `maxTime` gecti ve hala yok. Ancak SIMDI yeni sequence ile yeniden kurulur. */
  | 'expired'

export interface SettlementResult {
  readonly state: SettlementState
  readonly txHash: string
  readonly ledger: number | null
  readonly feeCharged: bigint | null
  /** Basarisizsa hangi operasyon neden patladi. */
  readonly opResults: readonly { index: number; code: string }[]
}

export interface SourceAccountStatus {
  readonly address: string
  readonly usdcBalance: Stroops
  /**
   * Harcanabilir XLM — minimum bakiye ve satis yukumlulukleri dusulmus.
   *
   * USDC'si dolu ama XLM'i biten payout hesabi SESSIZCE DURUR ve USDC
   * alarmi susar. Bu yuzden ayri izlenir (§8 tuzak #11).
   */
  readonly availableXlm: bigint
  readonly sequence: string
}

export interface PaymentRail {
  /** Batch kurulmadan HEMEN once cagrilir — TOCTOU penceresi dar tutulur. */
  validateDestinations(addresses: readonly string[]): Promise<readonly DestinationStatus[]>
  sourceStatus(): Promise<SourceAccountStatus>
  /** Imzali envelope'i URETIR ve gonderir. Envelope cagirana geri doner. */
  submitBatch(batch: PayoutBatch): Promise<SubmissionReceipt>
  /** Ayni byte'lari tekrar gonderir. Ag seviyesinde idempotenttir. */
  resubmit(receipt: SubmissionReceipt): Promise<void>
  reconcile(receipt: SubmissionReceipt): Promise<SettlementResult>
  now(): number
}
