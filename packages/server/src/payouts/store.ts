/**
 * `payout_items` — hangi para, kime, hangi islemde, hangi operasyonda.
 *
 * Defter (`Ledger`) parayi izler; burasi PARANIN FIILEN NASIL GONDERILDIGINI
 * izler. Ikisi ayri: defter "Alice'e 2.5 borcumuz yok artik" der, burasi
 * "su hash'in 0. operasyonunda su adrese gitti" der. Bir kullanici
 * "param nerede" diye sordugunda cevabi veren ikincisi.
 *
 * Neden ayri bir kayit:
 *
 *   op_index         Batch kismen basarisiz olursa kimin odendigi buradan
 *                    okunur. Sonradan turetmeye calismak, zincire bakip
 *                    tahmin etmek demek (§8 tuzak #7).
 *   envelope_xdr     Retry AYNI byte'lari gonderir. Saklamazsak yeniden
 *                    insa etmek zorunda kalir, ayni odemeyi iki kez
 *                    yapabiliriz (§8 tuzak #9).
 *   address SNAPSHOT Kullanici odemeden sonra cuzdanini degistirebilir.
 *                    "Nereye gonderdik" sorusunun cevabi o anki adrestir,
 *                    su anki degil. Guncel adresi okumak gecmisi yeniden
 *                    yazmak olurdu.
 */

import type { Stroops } from '@dwell/protocol'
import type { SubmissionReceipt, SettlementState } from '@dwell/payments'

export type PayoutItemState =
  /** Gonderildi, zincirde onay bekleniyor. */
  | 'submitted'
  /** Zincirde ve `successful === true`. Tek dogru "odendi". */
  | 'settled'
  /** Zincire girdi ve basarisiz oldu; ya da sure doldu. Para geri verildi. */
  | 'failed'

export interface PayoutItemRecord {
  readonly batchId: string
  readonly publisherId: string
  /** O ANKI adres. Sonradan degisse bile bu kayit degismez. */
  readonly destinationAddress: string
  readonly amount: Stroops
  readonly opIndex: number
  readonly txHash: string
  readonly envelopeXdr: string
  readonly sourceSeq: string
  readonly maxTime: number
  readonly state: PayoutItemState
  readonly submittedAt: number
  readonly settledAt: number | null
  readonly failureReason: string | null
}

export interface PayoutStore {
  recordSubmit(input: {
    receipt: SubmissionReceipt
    items: readonly { publisherId: string; address: string; amount: Stroops }[]
    at: number
  }): readonly PayoutItemRecord[]
  markSettled(batchId: string, txHash: string, at: number): number
  markFailed(batchId: string, reason: string, at: number): number
  forPublisher(publisherId: string, limit?: number): readonly PayoutItemRecord[]
  byBatch(batchId: string): readonly PayoutItemRecord[]
  /** Zincirde henuz karara baglanmamis batch'ler — yeniden baslatmadan sonra. */
  unresolved(): readonly { batchId: string; receipt: SubmissionReceipt }[]
  all(): readonly PayoutItemRecord[]
}

export class MemoryPayoutStore implements PayoutStore {
  readonly #items: PayoutItemRecord[] = []
  readonly #receipts = new Map<string, SubmissionReceipt>()

  recordSubmit(input: {
    receipt: SubmissionReceipt
    items: readonly { publisherId: string; address: string; amount: Stroops }[]
    at: number
  }): readonly PayoutItemRecord[] {
    const { receipt } = input

    // Ayni batch iki kez kaydedilirse mevcut kayitlar doner. Yeniden yazmak,
    // `settled` olmus bir kaydi `submitted`'a dusurebilirdi.
    const varolan = this.byBatch(receipt.batchId)
    if (varolan.length > 0) return varolan

    this.#receipts.set(receipt.batchId, receipt)

    const indexOf = new Map(receipt.opIndex.map((o) => [o.publisherId, o.index]))
    const yeni = input.items.map((it): PayoutItemRecord => {
      const opIndex = indexOf.get(it.publisherId)
      // Eslesmeyen item KAYIT DISI birakilmaz, hata verir: hangi operasyonda
      // oldugunu bilmedigimiz bir odemeyi "gonderildi" diye yazmak, sonradan
      // mutabakat yapilamayan bir kayit uretir.
      if (opIndex === undefined) {
        throw new Error(`op_index eksik: ${it.publisherId} (batch ${receipt.batchId})`)
      }
      return {
        batchId: receipt.batchId,
        publisherId: it.publisherId,
        destinationAddress: it.address,
        amount: it.amount,
        opIndex,
        txHash: receipt.txHash,
        envelopeXdr: receipt.envelopeXdr,
        sourceSeq: receipt.sourceSeq,
        maxTime: receipt.maxTime,
        state: 'submitted',
        submittedAt: input.at,
        settledAt: null,
        failureReason: null,
      }
    })

    this.#items.push(...yeni)
    return yeni
  }

  markSettled(batchId: string, txHash: string, at: number): number {
    return this.#transition(batchId, (r) => ({ ...r, state: 'settled', txHash, settledAt: at }))
  }

  markFailed(batchId: string, reason: string, at: number): number {
    return this.#transition(batchId, (r) => ({ ...r, state: 'failed', settledAt: at, failureReason: reason }))
  }

  #transition(batchId: string, fn: (r: PayoutItemRecord) => PayoutItemRecord): number {
    let n = 0
    for (let i = 0; i < this.#items.length; i++) {
      const r = this.#items[i]!
      if (r.batchId !== batchId) continue
      // `settled` SON DURAKTIR. Zincirde onaylanmis bir odemeyi sonradan
      // `failed`'a cevirmek, olmus bir ters kayit yazmak demekti.
      if (r.state === 'settled') continue
      this.#items[i] = fn(r)
      n++
    }
    return n
  }

  forPublisher(publisherId: string, limit = 20): readonly PayoutItemRecord[] {
    return this.#items
      .filter((r) => r.publisherId === publisherId)
      .sort((a, b) => b.submittedAt - a.submittedAt)
      .slice(0, limit)
  }

  byBatch(batchId: string): readonly PayoutItemRecord[] {
    return this.#items.filter((r) => r.batchId === batchId)
  }

  /**
   * Karara baglanmamis batch'ler.
   *
   * Sunucu submit ile reconcile ARASINDA yeniden baslarsa, o batch hicbir
   * yerde takip edilmiyor olurdu: para `payouts_in_flight`'ta asili kalir ve
   * kullanici "yolda" gorup bekler. Envelope saklandigi icin kaldigi yerden
   * devam edilebiliyor.
   */
  unresolved(): readonly { batchId: string; receipt: SubmissionReceipt }[] {
    const acik = new Set(this.#items.filter((r) => r.state === 'submitted').map((r) => r.batchId))
    return [...acik].flatMap((b) => {
      const receipt = this.#receipts.get(b)
      return receipt ? [{ batchId: b, receipt }] : []
    })
  }

  all(): readonly PayoutItemRecord[] { return this.#items }
}

/** Zincir durumunu kayit durumuna cevirir. */
export function stateFromSettlement(s: SettlementState): PayoutItemState | null {
  switch (s) {
    case 'settled': return 'settled'
    case 'failed': return 'failed'
    case 'expired': return 'failed'
    // `pending` bir KARAR DEGIL. Kayit `submitted` kalir, tekrar bakilir.
    case 'pending': return null
  }
}
