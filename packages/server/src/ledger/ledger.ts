/**
 * Cift kayitli defter — ADR-005, ADR-011, ADR-021.
 *
 * Bu dosya saf: veritabani yok, saat disaridan enjekte. Depolama bir arayuzun
 * arkasinda; su an bellekte, sonra Postgres.
 *
 * Uc baglayici kural:
 *
 *   1. Her `(ref_id, asset)` icin entry toplami SIFIR. Ihlali bug'dir.
 *   2. Ters kayit YENIDEN HESAPLANMAZ, orijinalin negasyonudur.
 *   3. Ayni idempotency key ile ikinci yazma hata degil, ORIJINAL SONUC doner.
 */

import { type Stroops, stroops, add, neg, sum, splitRevenue, ZERO } from '@dwell/protocol'
import type { Clock } from '@dwell/protocol'
import {
  type AccountId, type AccountKind, parseAccountId,
  PLATFORM_REVENUE, EXTERNAL_CASH, EXTERNAL_SETTLEMENT, NON_NEGATIVE, accountId,
} from './accounts.js'

/* ─────────────────────────── tipler ─────────────────────────── */

export type EntryType =
  | 'impression'        // gosterim dogrulandi
  | 'deposit'           // reklamveren para yatirdi
  | 'payout_submit'     // odeme yola cikti
  | 'payout_settled'    // odeme zincirde onaylandi
  | 'reversal'          // ters kayit
  | 'clawback'

export type RefType = 'impression' | 'topup' | 'payout_batch' | 'reversal' | 'clawback'

/**
 * Varlik. Tek varlik olsa bile kolon BASTAN var: `asset`'siz bir mali tablo,
 * ikinci varlik geldigi gun mali kayit uzerinde migration demektir.
 */
export type Asset = 'USDC'

export interface Entry {
  readonly id: string
  readonly accountId: AccountId
  readonly amount: Stroops
  readonly asset: Asset
  readonly type: EntryType
  readonly refType: RefType
  readonly refId: string
  readonly idempotencyKey: string
  readonly createdAt: number
  /**
   * Denormalize alanlar — defter KENDI KENDINE YETERLI olmali.
   * `impressions` tablosu 90 gunde partition drop ediliyor; o gun bu kaydin
   * hangi kampanyaya ait oldugu baska turlu geri getirilemez.
   */
  readonly campaignId: string | null
  readonly publisherId: string | null
  readonly rateStroops: Stroops | null
}

export type NewEntry = Omit<Entry, 'id' | 'createdAt'>

export class LedgerError extends Error {
  override readonly name = 'LedgerError'
  constructor(message: string, readonly code: string) { super(message) }
}

/* ─────────────────────────── depolama ─────────────────────────── */

export interface LedgerStore {
  /** Tek transaction'da yazar. Idempotency key cakisirsa ORIJINALLERI doner. */
  append(entries: readonly NewEntry[]): readonly Entry[]
  byIdempotencyKey(key: string): Entry | null
  byRef(refType: RefType, refId: string): readonly Entry[]
  balance(account: AccountId, asset: Asset): Stroops
  all(): readonly Entry[]
}

/* ─────────────────────────── defter ─────────────────────────── */

export class Ledger {
  constructor(
    private readonly store: LedgerStore,
    private readonly clock: Clock,
    private readonly newId: () => string,
  ) {}

  balance(account: AccountId, asset: Asset = 'USDC'): Stroops {
    return this.store.balance(account, asset)
  }

  /**
   * Defterde kaydi olan tum publisher'lar.
   *
   * Ayri bir publisher tablosu YOK ve olmamali: kimin parasi oldugunu bilen
   * tek yer defter. Ikinci bir liste tutmak, ikisinin ayrisabilecegi anlamina
   * gelir ve ayristiklarinda hangisinin dogru oldugu bilinemez.
   */
  publishers(): readonly string[] {
    const set = new Set<string>()
    for (const e of this.store.all()) {
      if (e.publisherId) set.add(e.publisherId)
    }
    return [...set]
  }

  entriesFor(refType: RefType, refId: string): readonly Entry[] {
    return this.store.byRef(refType, refId)
  }

  /**
   * ADR-021 — reklamveren cuzdanindan para yatirdi.
   *
   * Bu olmadan `advertiser` hesabinin yalnizca eksi yonu olur, bakiye sinirsiz
   * negatife gider ve "ref basina toplam sifir" invariant'i bunu YESIL GECER:
   * o invariant dengeyi degil, kaydin simetrisini kontrol eder.
   */
  deposit(input: {
    advertiserId: string
    amount: Stroops
    topupId: string
    asset?: Asset
  }): readonly Entry[] {
    if (input.amount <= 0n) throw new LedgerError('yatirilan tutar pozitif olmali', 'DWL_5006')
    const asset = input.asset ?? 'USDC'
    const advertiser = accountId('advertiser', input.advertiserId)

    return this.#post([
      this.#entry({
        accountId: advertiser, amount: input.amount, asset,
        type: 'deposit', refType: 'topup', refId: input.topupId,
        idempotencyKey: `topup:${input.topupId}:advertiser`,
      }),
      this.#entry({
        accountId: EXTERNAL_CASH, amount: neg(input.amount), asset,
        type: 'deposit', refType: 'topup', refId: input.topupId,
        idempotencyKey: `topup:${input.topupId}:external_cash`,
      }),
    ])
  }

  /**
   * ADR-011 — gosterim dogrulandi, uc satir yazilir.
   *
   * ```
   * advertiser  −rate
   * publisher   +rate × bps / 10000
   * platform    +artik
   * ─────────────────
   * toplam       0
   * ```
   *
   * Platform payi AYRICA HESAPLANMAZ, artik olarak alinir — boylece yuvarlama
   * bosluk birakmaz ve invariant kesin saglanir.
   */
  postImpression(input: {
    impressionId: string
    advertiserId: string
    publisherId: string
    campaignId: string
    /** Gosterim aninda dondurulmus birim fiyat (ADR-011). */
    rate: Stroops
    /** Gosterim aninda dondurulmus pay orani — kampanya sonradan degisebilir. */
    revShareBps: number
    asset?: Asset
  }): readonly Entry[] {
    if (input.rate < 0n) throw new LedgerError('rate negatif olamaz', 'DWL_5006')
    const asset = input.asset ?? 'USDC'
    const { publisher, platform } = splitRevenue(input.rate, input.revShareBps)

    const common = {
      asset, type: 'impression' as const, refType: 'impression' as const,
      refId: input.impressionId,
      campaignId: input.campaignId, publisherId: input.publisherId,
      rateStroops: input.rate,
    }

    return this.#post([
      this.#entry({
        ...common, accountId: accountId('advertiser', input.advertiserId),
        amount: neg(input.rate),
        idempotencyKey: `impression:${input.impressionId}:advertiser`,
      }),
      this.#entry({
        ...common, accountId: accountId('publisher', input.publisherId),
        amount: publisher,
        idempotencyKey: `impression:${input.impressionId}:publisher`,
      }),
      this.#entry({
        ...common, accountId: PLATFORM_REVENUE, amount: platform,
        idempotencyKey: `impression:${input.impressionId}:platform`,
      }),
    ])
  }

  /**
   * Odeme yola cikti — para publisher'dan "yolda" kutusuna gecer.
   *
   * Submit'ten ONCE cagrilir. Aksi halde submit ile settle arasindaki pencerede
   * bir sonraki job ayni bakiyeyi tekrar secer ve cift odeme olur.
   */
  payoutSubmit(input: {
    batchId: string
    publisherId: string
    amount: Stroops
    asset?: Asset
  }): readonly Entry[] {
    if (input.amount <= 0n) throw new LedgerError('odeme tutari pozitif olmali', 'DWL_5006')
    const asset = input.asset ?? 'USDC'
    const key = `${input.batchId}:${input.publisherId}`

    return this.#post([
      this.#entry({
        accountId: accountId('publisher', input.publisherId), amount: neg(input.amount),
        asset, type: 'payout_submit', refType: 'payout_batch', refId: key,
        idempotencyKey: `payout_submit:${key}:publisher`,
        publisherId: input.publisherId,
      }),
      this.#entry({
        accountId: accountId('payouts_in_flight'), amount: input.amount,
        asset, type: 'payout_submit', refType: 'payout_batch', refId: key,
        idempotencyKey: `payout_submit:${key}:in_flight`,
        publisherId: input.publisherId,
      }),
    ])
  }

  /** Zincirde onaylandi (`successful === true`) — para sistemden cikar. */
  payoutSettled(input: {
    batchId: string
    publisherId: string
    amount: Stroops
    txHash: string
    asset?: Asset
  }): readonly Entry[] {
    const asset = input.asset ?? 'USDC'
    const key = `${input.batchId}:${input.publisherId}`

    return this.#post([
      this.#entry({
        accountId: accountId('payouts_in_flight'), amount: neg(input.amount),
        asset, type: 'payout_settled', refType: 'payout_batch', refId: key,
        idempotencyKey: `payout_settled:${key}:in_flight`,
        publisherId: input.publisherId,
      }),
      this.#entry({
        accountId: EXTERNAL_SETTLEMENT, amount: input.amount,
        asset, type: 'payout_settled', refType: 'payout_batch', refId: key,
        idempotencyKey: `payout_settled:${key}:external`,
        publisherId: input.publisherId,
      }),
    ])
  }

  /**
   * ADR-005 — ters kayit.
   *
   * Orijinal entry'ler NEGATIFLENEREK kopyalanir. Formulu negatif girdiyle
   * yeniden calistirmak yasak: BigInt bolme sifira dogru truncate ettigi icin
   * yuvarlama artigi ters yone duser ve `ref_id` toplami sifir olmaz — yani
   * kendi invariant'ini kirarsin.
   */
  reverse(refType: RefType, refId: string, reason: string): readonly Entry[] {
    const original = this.store.byRef(refType, refId)
    if (original.length === 0) {
      throw new LedgerError(`ters cevrilecek kayit yok: ${refType}:${refId}`, 'DWL_5006')
    }
    const reversalRef = `${refId}:reversal`
    if (this.store.byRef('reversal', reversalRef).length > 0) {
      return this.store.byRef('reversal', reversalRef)     // zaten ters cevrilmis
    }

    return this.#post(original.map((e) => this.#entry({
      accountId: e.accountId,
      amount: neg(e.amount),                                // ← negasyon, yeniden hesap DEGIL
      asset: e.asset,
      type: 'reversal',
      refType: 'reversal',
      refId: reversalRef,
      idempotencyKey: `reversal:${e.idempotencyKey}`,
      campaignId: e.campaignId,
      publisherId: e.publisherId,
      rateStroops: e.rateStroops,
      note: reason,
    })))
  }

  /* ── invariantlar ── */

  /**
   * Butun defteri denetler. Test ve `solvency_check` job'i cagirir.
   * Ihlal listesi bos degilse bu bir BUG'dir, veri hatasi degil.
   */
  audit(): string[] {
    const problems: string[] = []
    const entries = this.store.all()

    // 1. Her (ref_id, asset) icin toplam sifir
    const byRef = new Map<string, Stroops>()
    for (const e of entries) {
      const k = `${e.refType}:${e.refId}|${e.asset}`
      byRef.set(k, add(byRef.get(k) ?? ZERO, e.amount))
    }
    for (const [k, total] of byRef) {
      if (total !== 0n) problems.push(`ref toplami sifir degil: ${k} = ${total}`)
    }

    // 2. Belirli hesaplar negatife dusemez
    const byAccount = new Map<string, Stroops>()
    for (const e of entries) {
      const k = `${e.accountId}|${e.asset}`
      byAccount.set(k, add(byAccount.get(k) ?? ZERO, e.amount))
    }
    for (const [k, bal] of byAccount) {
      const accId = k.slice(0, k.lastIndexOf('|')) as AccountId
      const { kind } = parseAccountId(accId)
      if (bal < 0n && NON_NEGATIVE.includes(kind)) {
        problems.push(`negatif bakiye: ${k} = ${bal}`)
      }
    }

    // 3. Idempotency key tekilligi
    const keys = new Set<string>()
    for (const e of entries) {
      if (keys.has(e.idempotencyKey)) problems.push(`tekrarli idempotency key: ${e.idempotencyKey}`)
      keys.add(e.idempotencyKey)
    }

    return problems
  }

  /**
   * Odeme gucu — §15.10.
   * Zincirdeki para, publisher'lara olan borcu karsiliyor mu?
   */
  solvency(onChainBalance: Stroops, asset: Asset = 'USDC'): {
    owed: Stroops; onChain: Stroops; solvent: boolean
  } {
    const owed = sum(
      this.store.all()
        .filter((e) => e.asset === asset)
        .filter((e) => {
          const { kind } = parseAccountId(e.accountId)
          return kind === 'publisher' || kind === 'payouts_in_flight'
        })
        .map((e) => e.amount),
    )
    return { owed, onChain: onChainBalance, solvent: onChainBalance >= owed }
  }

  /* ── ic isler ── */

  #entry(v: Omit<NewEntry, 'campaignId' | 'publisherId' | 'rateStroops'> & {
    campaignId?: string | null
    publisherId?: string | null
    rateStroops?: Stroops | null
    note?: string
  }): NewEntry {
    return {
      accountId: v.accountId, amount: v.amount, asset: v.asset, type: v.type,
      refType: v.refType, refId: v.refId, idempotencyKey: v.idempotencyKey,
      campaignId: v.campaignId ?? null,
      publisherId: v.publisherId ?? null,
      rateStroops: v.rateStroops ?? null,
    }
  }

  #post(entries: readonly NewEntry[]): readonly Entry[] {
    // Yazmadan ONCE dengeyi kontrol et. Dengesiz bir grup diske hic ulasmamali.
    const total = sum(entries.map((e) => stroops(e.amount)))
    if (total !== 0n) {
      throw new LedgerError(
        `dengesiz kayit grubu: toplam ${total} (sifir olmali) — ${entries[0]?.refType}:${entries[0]?.refId}`,
        'DWL_5006',
      )
    }
    return this.store.append(entries)
  }
}
