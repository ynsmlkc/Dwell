/**
 * Istege bagli cekim — hem reklamveren hem yayinci icin AYNI makine.
 *
 * Once yalnizca reklamverenin harcamadigi butceyi geri cekmesi icin
 * yazilmisti (denetimde bulundu: para yatirma vardi, cikarma yoktu).
 * Yayinci tarafinda ise odeme hep TERSI yondeydi: sabit bir esik (eskiden
 * $1) asilinca gunluk bir job herkesi otomatik odüyordu — kullanicinin
 * "ne zaman cekecegimi ben secmek istiyorum" talebi bunu degistirdi.
 *
 * ADR-006 zaten sunu tespit etmisti: Stellar'da islem ucreti
 * `base_fee × operation_sayisi`dir, batch'lemek ucret kazandirmaz. Yani
 * "hepsini tek seferde ode" modelinin ekonomik gerekcesi hic yoktu — yalnizca
 * operasyonel rahatlik saglıyordu ve karsiliginda kullaniciya "param ne
 * zaman gelecek" belirsizligini kaynak birakiyordu. Istege bagli cekim aynı
 * railı kullanarak bu belirsizligi kaldiriyor: kullanici istedigi an,
 * istedigi (esik ustu) miktari cekebiliyor.
 *
 * Reklamveren ile yayincinin FARKI yalnizca `spendable` fonksiyonunun ne
 * dondurdugu: reklamverende `balance − rezerve` (teslim edilmis ama
 * raporlanmamis reklamlar), yayincida ise DOGRUDAN ledger bakiyesi — cunku
 * yayinci bakiyesi zaten yalnizca `verified` gosterimlerden olusuyor
 * (ADR-011), rezerve edilecek bir sey yok.
 *
 * Uc kural, ikisi icin de gecerli:
 *
 *   1. Yalnizca `spendable()`'in dondurdugu tutar cekilir.
 *   2. Para YALNIZCA kendi adresine gider. Kimlik zaten cuzdan (ADR-010);
 *      baska bir hedef parametresi yok. Bu yuzden calinmis bir token bile
 *      parayi baskasina gonderemez — en kotu ihtimalle erken bir cekimi
 *      TETIKLER, calmaz.
 *   3. Defter zincirden ONCE yazilir. Tersi olsa ve sunucu arada dusse,
 *      para zincirde giderdi ama defterde durmaya devam ederdi.
 */

import { stroops, type Stroops, type Clock } from '@dwell/protocol'
import type { PaymentRail } from '@dwell/payments'
import type { Ledger } from '../ledger/ledger.js'
import { accountId, PLATFORM_REVENUE } from '../ledger/accounts.js'
import type { PayoutStore } from './store.js'

export interface WithdrawDeps {
  readonly clock: Clock
  readonly rail: PaymentRail
  readonly ledger: Ledger
  readonly store: PayoutStore
  /**
   * Hangi hesap turu cekiyor — ledger kaydinin `kind` alanina gider.
   * `platform_revenue` SAHIPSIZ, tekil bir havuz (bkz. `accounts.ts`) —
   * bu durumda `withdraw()`'a verilen `id`, ledger hesabini DEGIL, yalnizca
   * paranin gidecegi hedef adresi belirler (`spendable` de buna gore
   * PLATFORM_REVENUE'yu okuyacak sekilde enjekte edilmeli).
   */
  readonly kind: 'advertiser' | 'publisher' | 'platform_revenue'
  /** `balance − rezerve` (reklamveren) veya dogrudan `balance` (yayinci/platform). */
  readonly spendable: (id: string) => Stroops
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

  async withdraw(id: string, amount: Stroops): Promise<WithdrawResult> {
    // Ayni hesap icin iki cekim ust uste calisamaz: ikisi de ayni bakiyeyi
    // gorur ve toplami bakiyeyi asar.
    if (this.#busy.has(id)) {
      return { ok: false, reason: 'bir cekim zaten suruyor', retryable: true }
    }
    this.#busy.add(id)
    try {
      return await this.#run(id, amount)
    } finally {
      this.#busy.delete(id)
    }
  }

  async #run(id: string, amount: Stroops): Promise<WithdrawResult> {
    if (amount < MIN_WITHDRAW) {
      return { ok: false, reason: `en az ${MIN_WITHDRAW} stroop cekilebilir`, retryable: false }
    }

    const spendable = this.deps.spendable(id)
    if (amount > spendable) {
      // Reklamverende bu, teslim edilmis ama henuz raporlanmamis reklamlarin
      // karsiligi olabilir — sebep acikca soyleniyor, "yetersiz bakiye" demek
      // "ama param var" diye dolandirilmis hissettirirdi. Yayincida boyle bir
      // rezerve yok (bkz. dosya basi), mesaj yine de dogru: `spendable` zaten
      // cekilebilecek TAVANIN kendisi.
      const neden = this.deps.kind === 'advertiser'
        ? ' — gerisi gosterilmis ama henuz raporlanmamis reklamlar icin ayrildi'
        : ''
      return {
        ok: false,
        reason: `en fazla ${spendable} stroop cekilebilir${neden}`,
        retryable: false,
      }
    }

    // Hedef, hesabin KENDI adresi. Baska bir hedef parametresi yok ve
    // olmayacak: kimlik zaten cuzdan (ADR-010).
    const [dest] = await this.deps.rail.validateDestinations([id])
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
    const items = [{ publisherId: id, address: id, amount }]

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
    this.deps.ledger.payoutSubmit({ batchId, publisherId: id, amount, kind: this.deps.kind })
    this.deps.store.recordSubmit({ receipt, items, at: this.deps.clock.now() })
    this.deps.log(`cekim gonderildi (${this.deps.kind}) ${id.slice(0, 8)}… ${amount} stroop`)

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
        batchId, publisherId: id, amount, txHash: settlement.txHash,
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

    // Basarisiz ya da suresi doldu: para hesaba GERI DONER.
    const sebep = settlement.state === 'expired' ? 'sure doldu' : 'zincirde basarisiz'
    this.deps.ledger.reverse('payout_batch', `${batchId}:${id}`, sebep)
    this.deps.store.markFailed(batchId, sebep, this.deps.clock.now())
    this.deps.log(`⚠ cekim basarisiz (${sebep}) — para iade edildi`)
    return { ok: false, reason: `${sebep} — paran hesabinda duruyor`, retryable: true }
  }

  /** Su an cekilebilecek tutar. */
  available(id: string): Stroops {
    const s = this.deps.spendable(id)
    return s < MIN_WITHDRAW ? stroops(0n) : s
  }

  /** Defterdeki ham bakiye — teshis icin. */
  balance(id: string): Stroops {
    if (this.deps.kind === 'platform_revenue') return this.deps.ledger.balance(PLATFORM_REVENUE)
    return this.deps.ledger.balance(accountId(this.deps.kind, id))
  }
}
