/**
 * Odeme turu — defter, kayit ve zincir tek yerde bulusur.
 *
 * `PayoutJob` batch'i kurar ve gonderir; burasi SONUCUN her yere dogru
 * yazilmasini saglar. Ayri durmasinin sebebi: job Stellar'i bilir, defteri
 * bilmez; defter Stellar'i bilmez. Birini digerinin icine koymak ikisini de
 * test edilemez yapardi.
 *
 * SIRALAMA KRITIK:
 *
 *   1. Defter once yazilir (`payoutSubmit`) — para `payouts_in_flight`'a gecer
 *   2. Sonra zincire gonderilir
 *
 * Tersi olsaydi ve sunucu arada dusseydi, para zincirde giderdi ama defterde
 * hala odenebilir gorunurdu — ayni para ikinci kez odenirdi. Bu sirayla en
 * kotu ihtimalle para "yolda" asili kalir; bu geri alinabilir bir hata.
 */

import type { Clock, Stroops } from '@dwell/protocol'
import { stroops } from '@dwell/protocol'
import { PayoutJob, type PayoutCandidate, type PaymentRail } from '@dwell/payments'
import type { WalletStore } from '@dwell/payments'
import type { Ledger } from '../ledger/ledger.js'
import { accountId } from '../ledger/accounts.js'
import { type PayoutStore, stateFromSettlement } from './store.js'

export interface PayoutRunnerDeps {
  readonly clock: Clock
  readonly rail: PaymentRail
  readonly wallets: WalletStore
  readonly ledger: Ledger
  readonly store: PayoutStore
  readonly threshold: Stroops
  readonly newBatchId: () => string
  readonly log: (m: string) => void
  readonly batchSize?: number
  readonly minXlmReserve?: bigint
}

export interface RunnerResult {
  readonly batches: number
  readonly paid: number
  readonly skipped: number
  readonly failed: number
  readonly totalPaid: Stroops
  readonly alerts: readonly string[]
  /** Kullaniciya gosterilecek sebepler — "neden odenmedim" sorusunun cevabi. */
  readonly skipReasons: readonly { publisherId: string; reason: string }[]
}

export class PayoutRunner {
  #running = false

  constructor(private readonly deps: PayoutRunnerDeps) {}

  /**
   * Odenebilir bakiyesi esigi gecen herkes.
   *
   * Defterden okunur, ayri bir tablodan DEGIL: tek dogru kaynak defter.
   * Ikinci bir yerde tutmak, ikisinin ayrisabilecegi anlamina gelir ve
   * ayristiklarinda hangisinin dogru oldugunu kimse bilemez.
   */
  candidates(): readonly PayoutCandidate[] {
    const out: PayoutCandidate[] = []
    for (const publisherId of this.deps.ledger.publishers()) {
      const payable = this.deps.ledger.balance(accountId('publisher', publisherId))
      if (payable >= this.deps.threshold) out.push({ publisherId, payable })
    }
    return out
  }

  /**
   * Bir tur calistirir.
   *
   * Ayni anda iki tur ASLA calismamali: ikisi de ayni bakiyeyi gorur ve ayni
   * parayi iki kez gondermeye calisir. Defter ikinciyi reddederdi ama zincire
   * gonderim ondan once oluyor.
   */
  async run(): Promise<RunnerResult> {
    if (this.#running) {
      return { batches: 0, paid: 0, skipped: 0, failed: 0, totalPaid: stroops(0n), alerts: ['tur zaten calisiyor'], skipReasons: [] }
    }
    this.#running = true
    try {
      await this.resumeUnresolved()
      return await this.#run()
    } finally {
      this.#running = false
    }
  }

  async #run(): Promise<RunnerResult> {
    const skipReasons: { publisherId: string; reason: string }[] = []

    const job = new PayoutJob({
      clock: this.deps.clock,
      rail: this.deps.rail,
      wallets: this.deps.wallets,
      candidates: () => this.candidates(),
      threshold: this.deps.threshold,
      newBatchId: this.deps.newBatchId,
      ...(this.deps.batchSize !== undefined ? { batchSize: this.deps.batchSize } : {}),
      ...(this.deps.minXlmReserve !== undefined ? { minXlmReserve: this.deps.minXlmReserve } : {}),

      // ── 1. Gonderimden ONCE: defter + kayit ──
      onSubmit: (batchId, items, receipt) => {
        for (const it of items) {
          this.deps.ledger.payoutSubmit({ batchId, publisherId: it.publisherId, amount: it.amount })
        }
        this.deps.store.recordSubmit({ receipt, items, at: this.deps.clock.now() })
        this.deps.log(`odeme gonderildi ${batchId} · ${items.length} kalem · ${receipt.txHash.slice(0, 12)}…`)
      },

      // ── 2. Zincirde onaylandi ──
      onSettled: (batchId, items, txHash) => {
        for (const it of items) {
          this.deps.ledger.payoutSettled({ batchId, publisherId: it.publisherId, amount: it.amount, txHash })
        }
        this.deps.store.markSettled(batchId, txHash, this.deps.clock.now())
        this.deps.log(`odeme onaylandi ${batchId} · ${txHash}`)
      },

      // ── 3. Patladi: para publisher'a GERI DONER ──
      onFailed: (batchId, items, reason) => {
        for (const it of items) {
          // ADR-005: formulu negatif girdiyle yeniden calistirmiyoruz,
          // orijinal kayitlari negatifliyoruz. Yuvarlama artigi aksi halde
          // ters yone duser ve `ref_id` toplami sifir olmaz.
          this.deps.ledger.reverse('payout_batch', `${batchId}:${it.publisherId}`, reason)
        }
        this.deps.store.markFailed(batchId, reason, this.deps.clock.now())
        this.deps.log(`⚠ odeme basarisiz ${batchId}: ${reason} — para iade edildi`)
      },

      onSkipped: (publisherId, reason) => {
        skipReasons.push({ publisherId, reason })
        this.deps.log(`atlandi ${publisherId}: ${reason}`)
      },
    })

    const r = await job.run()
    for (const a of r.alerts) this.deps.log(`⚠ ${a}`)

    const problems = this.deps.ledger.audit()
    if (problems.length > 0) this.deps.log(`⚠ LEDGER INVARIANT IHLALI: ${problems.join('; ')}`)

    return { ...r, skipReasons }
  }

  /**
   * Yeniden baslatmadan sonra asili kalanlari cozer.
   *
   * Submit ile reconcile arasinda sunucu duserse para `payouts_in_flight`'ta
   * kalir ve kimse bir daha bakmaz. Envelope saklandigi icin zincire sorup
   * karari verebiliyoruz — ve zincir zaten tek dogru kaynak.
   */
  async resumeUnresolved(): Promise<number> {
    const acik = this.deps.store.unresolved()
    if (acik.length === 0) return 0

    this.deps.log(`${acik.length} karara baglanmamis batch bulundu — zincire soruluyor`)
    let cozulen = 0

    for (const { batchId, receipt } of acik) {
      const kalemler = this.deps.store.byBatch(batchId)
      let sonuc
      try {
        sonuc = await this.deps.rail.reconcile(receipt)
      } catch (e) {
        // Zincire ulasilamadi. Kayit `submitted` KALIR ve bir sonraki turda
        // tekrar bakilir. "Bilmiyorum"u "basarisiz"a cevirmek, zincirde
        // gecmis bir odemeyi iade etmek olurdu.
        this.deps.log(`${batchId} sorulamadi: ${e instanceof Error ? e.message : String(e)}`)
        continue
      }

      const durum = stateFromSettlement(sonuc.state)
      if (durum === null) continue        // hala bekliyor

      if (durum === 'settled') {
        for (const k of kalemler) {
          this.deps.ledger.payoutSettled({
            batchId, publisherId: k.publisherId, amount: k.amount, txHash: sonuc.txHash,
          })
        }
        this.deps.store.markSettled(batchId, sonuc.txHash, this.deps.clock.now())
        this.deps.log(`asili batch cozuldu: ${batchId} ODENDI`)
      } else {
        const sebep = sonuc.state === 'expired' ? 'sure doldu' : 'zincirde basarisiz'
        for (const k of kalemler) {
          this.deps.ledger.reverse('payout_batch', `${batchId}:${k.publisherId}`, sebep)
        }
        this.deps.store.markFailed(batchId, sebep, this.deps.clock.now())
        this.deps.log(`asili batch cozuldu: ${batchId} ${sebep.toUpperCase()} — iade edildi`)
      }
      cozulen++
    }

    return cozulen
  }
}

/**
 * Turu periyodik calistirir.
 *
 * Basit bir `setInterval` degil: bir tur uzun surerse bir sonraki UST USTE
 * BINMEZ. Ust uste binmek, ayni bakiyeyi iki kez odemeye calismak demekti.
 */
export function schedulePayouts(
  runner: PayoutRunner,
  intervalMs: number,
  log: (m: string) => void,
): { stop: () => void } {
  let stopped = false
  let timer: NodeJS.Timeout | null = null

  const tur = async (): Promise<void> => {
    if (stopped) return
    try {
      const r = await runner.run()
      if (r.batches > 0 || r.skipped > 0) {
        log(`odeme turu: ${r.paid} odendi, ${r.skipped} atlandi, ${r.failed} basarisiz`)
      }
    } catch (e) {
      // Bir turun patlamasi zamanlamayi DURDURMAZ. Durdursaydi, gecici bir
      // ag hatasi odemeleri kalici olarak susturabilirdi.
      log(`⚠ odeme turu patladi: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (!stopped) {
      timer = setTimeout(() => void tur(), intervalMs)
      timer.unref()
    }
  }

  timer = setTimeout(() => void tur(), intervalMs)
  timer.unref()

  return {
    stop: () => {
      stopped = true
      if (timer) clearTimeout(timer)
    },
  }
}
