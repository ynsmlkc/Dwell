/**
 * Hesap plani — ADR-005.
 *
 * `users.balance` gibi bir kolon YOK. Bakiye, o hesaba ait entry'lerin
 * toplamidir. Mutable bakiye kolonu ilk clawback'te tutarsizlasir ve geriye
 * donuk denetlenemez.
 */

export const ACCOUNT_KINDS = [
  /** Geliştirici. Kazanci burada birikir. */
  'publisher',
  /** Reklamveren. Yatirdigi para buraya girer (ADR-021). */
  'advertiser',
  /** Platform geliri — %50 pay + yuvarlama artigi (ADR-011). */
  'platform_revenue',
  /**
   * Odemesi gonderilmis ama henuz onaylanmamis para.
   *
   * Bu hesap olmadan `payable` iki kez secilir: submit ile settle arasinda
   * publisher bakiyesi hala "odenebilir" gorunur ve bir sonraki job ayni
   * parayi tekrar gonderir.
   */
  'payouts_in_flight',
  /** Disaridan gelen para (reklamverenin yatirdigi). Karsi taraf. */
  'external_cash',
  /** Zincire cikan para. Karsi taraf. */
  'external_settlement',
] as const

export type AccountKind = (typeof ACCOUNT_KINDS)[number]

declare const accountIdBrand: unique symbol
export type AccountId = string & { readonly [accountIdBrand]: 'AccountId' }

/**
 * Hesap kimligi `kind:owner` formatinda.
 * Tekil hesaplarda owner yok: `platform_revenue`, `external_cash`.
 */
export function accountId(kind: AccountKind, owner?: string): AccountId {
  if (owner === undefined) return kind as AccountId
  if (owner.includes(':')) throw new Error(`owner ':' iceremez: ${owner}`)
  return `${kind}:${owner}` as AccountId
}

export const parseAccountId = (id: AccountId): { kind: AccountKind; owner: string | null } => {
  const i = id.indexOf(':')
  const kind = (i === -1 ? id : id.slice(0, i)) as AccountKind
  return { kind, owner: i === -1 ? null : id.slice(i + 1) }
}

export const PLATFORM_REVENUE = accountId('platform_revenue')
export const EXTERNAL_CASH = accountId('external_cash')
export const EXTERNAL_SETTLEMENT = accountId('external_settlement')

/**
 * Bakiyesi negatife DUSEMEYECEK hesaplar.
 *
 * `advertiser` burada: parasi gelmemis bir reklamveren reklam yayinlatamaz
 * (ADR-021). `publisher` burada: kimseye borclanmayiz — clawback negatif
 * bakiye yaratirsa bu ayri bir akistir (ADR-005 clawback kurali), normal
 * kayit yolu degil.
 */
export const NON_NEGATIVE: readonly AccountKind[] = [
  'publisher', 'advertiser', 'payouts_in_flight', 'platform_revenue',
]

/** Karsi taraf hesaplari — sinirsiz negatife gidebilir, dis dunyayi temsil eder. */
export const IS_EXTERNAL = (kind: AccountKind): boolean =>
  kind === 'external_cash' || kind === 'external_settlement'
