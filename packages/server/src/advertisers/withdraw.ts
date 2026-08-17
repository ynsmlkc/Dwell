/**
 * Reklamverenin harcamadigi butceyi geri cekmesi.
 *
 * Denetimde ortaya cikti: para yatirma vardi, cikarma yoktu. Reklamveren
 * $50 yatirip $10 harcarsa kalan $40 sistemde kilitli kaliyordu. Bir
 * reklamvereni ikna edip "paran bizde kalir" demek satilabilir bir sey degil.
 *
 * Odeme makinesinin AYNISINI kullaniyor — ayni `payouts_in_flight` kutusu,
 * ayni ters kayit, ayni mutabakat. Ayri bir akis yazmak, test edilmis
 * mantigin ikinci ve daha az bakimli bir kopyasini uretmek olurdu.
 *
 * Uc kural:
 *
 *   1. Yalnizca HARCANABILIR tutar cekilir. Teslim edilmis ama henuz
 *      raporlanmamis reklamlarin karsiligi rezervede kalir — yoksa
 *      reklamveren reklamini gosterttirip parasini geri alabilirdi.
 *   2. Para YALNIZCA kendi adresine gider. `advertiserId` zaten cuzdan
 *      adresi (ADR-010); baska bir hedef kabul etmiyoruz.
 *   3. Defter zincirden ONCE yazilir. Tersi olsa ve sunucu arada dusse,
 *      para zincirde giderdi ama defterde durmaya devam ederdi.
 */

import { stroops, type Stroops, type Clock } from '@dwell/protocol'
import type { PaymentRail } from '@dwell/payments'
import type { Ledger } from '../ledger/ledger.js'
import { accountId } from '../ledger/accounts.js'
import type { PayoutStore } from '../payouts/store.js'

export interface WithdrawDeps {
  readonly clock: Clock
  readonly rail: PaymentRail
  readonly ledger: Ledger
  readonly store: PayoutStore
  /** `balance − rezerve`. Pipeline'dan gelir. */
  readonly spendable: (advertiserId: string) => Stroops
  readonly newBatchId: () => string
  readonly log: (m: string) => void
}

export type WithdrawResult =
  | { readonly ok: true; readonly txHash: string; readonly amount: Stroops }
  | { readonly ok: false; readonly reason: string; readonly retryable: boolean }

/** Zincir ucreti cekilecek tutarin altinda kalmali; toz cekimini engelle. */
export const MIN_WITHDRAW: Stroops = 1_000_000n as Stroops       // $0.10

export class WithdrawService {
  #busy = new Set<string>()

  constructor(private readonly deps: WithdrawDeps) {}

  async withdraw(advertiserId: string, amount: Stroops): Promise<WithdrawResult> {
    // Ayni reklamveren icin iki cekim ust uste calisamaz: ikisi de ayni
    // bakiyeyi gorur ve toplami bakiyeyi asar.
    if (this.#busy.has(advertiserId)) {
      return { ok: false, reason: 'bir cekim zaten suruyor', retryable: true }
    }
    this.#busy.add(advertiserId)
    try {
      return await this.#run(advertiserId, amount)
    } finally {
      this.#busy.delete(advertiserId)
    }
  }

  async #run(advertiserId: string, amount: Stroops): Promise<WithdrawResult> {
    if (amount < MIN_WITHDRAW) {
      return { ok: false, reason: `en az ${MIN_WITHDRAW} stroop cekilebilir`, retryable: false }
    }

    const spendable = this.deps.spendable(advertiserId)
    if (amount > spendable) {
      // Rezerve edilmis tutari cekmeye calisiyor: teslim edilmis reklamlarin
      // karsiligi. Sebebi acikca soyleniyor, "yetersiz bakiye" demek
      // reklamvereni "ama param var" diye dolandirilmis hissettirirdi.
      return {
        ok: false,
        reason: `en fazla ${spendable} stroop cekilebilir — gerisi gosterilmis ama henuz raporlanmamis reklamlar icin ayrildi`,
        retryable: false,
      }
    }

    // Hedef reklamverenin KENDI adresi. Baska bir hedef parametresi yok ve
    // olmayacak: kimlik zaten cuzdan (ADR-010).
    const [dest] = await this.deps.rail.validateDestinations([advertiserId])
    if (!dest || !dest.exists) {
      return { ok: false, reason: 'cuzdan zincirde bulunamadi', retryable: false }
    }
    if (!dest.trustlineOk) {
      return { ok: false, reason: 'cuzdanin USDC kabulu yok — once trustline ekle', retryable: false }
    }
    if (!dest.authorized) {
      return { ok: false, reason: 'USDC trustline yetkilendirilmemis', retryable: false }
    }
    if (dest.memoRequired) {
      return { ok: false, reason: 'adres memo gerektiriyor — desteklenmiyor', retryable: false }
    }

    const batchId = this.deps.newBatchId()
    const items = [{ publisherId: advertiserId, address: advertiserId, amount }]

    // ── 1. Zarfi kur. Aga hicbir sey yazilmadi. ──
    let receipt
    try {
      receipt = await this.deps.rail.prepare({ batchId, items })
    } catch (e) {
      return {
        ok: false,
        reason: `islem hazirlanamadi: ${e instanceof Error ? e.message : String(e)}`,
        retryable: true,
      }
    }

    // ── 2. Defter ve kayit, gonderimden ONCE. ──
    this.deps.ledger.payoutSubmit({ batchId, publisherId: advertiserId, amount, kind: 'advertiser' })
    this.deps.store.recordSubmit({ receipt, items, at: this.deps.clock.now() })
    this.deps.log(`cekim gonderildi ${advertiserId.slice(0, 8)}… ${amount} stroop`)

    // ── 3. Gonder. ──
    try {
      await this.deps.rail.send(receipt)
    } catch (e) {
      this.deps.log(`cekim gonderilemedi: ${e instanceof Error ? e.message : String(e)}`)
    }

    // ── 4. Zincire sor. Tek dogru cevap orada. ──
    const settlement = await this.deps.rail.reconcile(receipt)

    if (settlement.state === 'settled') {
      this.deps.ledger.payoutSettled({
        batchId, publisherId: advertiserId, amount, txHash: settlement.txHash,
      })
      this.deps.store.markSettled(batchId, settlement.txHash, this.deps.clock.now())
      this.deps.log(`cekim onaylandi ${settlement.txHash}`)
      return { ok: true, txHash: settlement.txHash, amount }
    }

    if (settlement.state === 'pending') {
      // Belirsiz. Para "yolda" kutusunda kaliyor ve `resumeUnresolved`
      // sonraki turda zincire tekrar soruyor. Burada iade ETMIYORUZ:
      // "bilmiyorum"u "olmadi" saymak, zincirde gecmis bir odemeyi
      // ikinci kez yapmak demek.
      return { ok: false, reason: 'islem henuz onaylanmadi — birazdan bakiyeni kontrol et', retryable: false }
    }

    // Basarisiz ya da suresi doldu: para reklamverene GERI DONER.
    const sebep = settlement.state === 'expired' ? 'sure doldu' : 'zincirde basarisiz'
    this.deps.ledger.reverse('payout_batch', `${batchId}:${advertiserId}`, sebep)
    this.deps.store.markFailed(batchId, sebep, this.deps.clock.now())
    this.deps.log(`⚠ cekim basarisiz (${sebep}) — para iade edildi`)
    return { ok: false, reason: `${sebep} — paran hesabinda duruyor`, retryable: true }
  }

  /** Su an cekilebilecek tutar. */
  available(advertiserId: string): Stroops {
    const s = this.deps.spendable(advertiserId)
    return s < MIN_WITHDRAW ? stroops(0n) : s
  }

  /** Defterdeki ham bakiye — teshis icin. */
  balance(advertiserId: string): Stroops {
    return this.deps.ledger.balance(accountId('advertiser', advertiserId))
  }
}
