/**
 * Hedef adres dogrulamasi — ADR-020.
 *
 * Zincir ustu odeme GERI ALINAMAZ. Yanlis adrese giden para gitmistir.
 * Bu yuzden dokuz kontrolun hepsi gecilmeden adres baglanmaz.
 *
 * Kontroller iki gruba ayriliyor:
 *   • Bicimsel — ag erisimi gerektirmez, aninda calisir
 *   • Zincir ustu — hesap, trustline, memo bayragi
 */

import { StrKey, Asset } from '@stellar/stellar-sdk'

export type AddressRejection =
  | 'gecersiz_bicim'
  | 'secret_key'
  | 'desteklenmeyen_tip_muxed'
  | 'desteklenmeyen_tip_contract'
  | 'hesap_yok'
  | 'trustline_yok'
  | 'trustline_yetkisiz'
  | 'trustline_limiti_yetersiz'
  | 'issuer_adresi'
  | 'memo_gerekiyor'
  | 'baska_hesaba_bagli'

export interface AddressCheck {
  readonly ok: boolean
  readonly reason: AddressRejection | null
  /** Kullaniciya gosterilecek tek cumle. */
  readonly message: string | null
  /** Kullanicinin ne yapmasi gerektigi. */
  readonly hint: string | null
}

const OK: AddressCheck = { ok: true, reason: null, message: null, hint: null }
const fail = (reason: AddressRejection, message: string, hint?: string): AddressCheck =>
  ({ ok: false, reason, message, hint: hint ?? null })

/**
 * Bicimsel kontroller — ag erisimi YOK.
 *
 * Ayri durmasinin sebebi: kullanici adresi yazarken aninda geri bildirim
 * verebilmek ve zincire gereksiz sorgu atmamak.
 */
export function checkAddressFormat(raw: string): AddressCheck {
  const address = raw.trim()

  // EN ONEMLI KONTROL, EN BASTA.
  //
  // Kullanici kazara secret key yapistirabilir. Bu durumda:
  //   • hemen dur
  //   • degeri EKRANA BASMA
  //   • LOG'A YAZMA
  //   • hata mesajina KOYMA
  // Anahtar bir kez bir yere yazildiginda geri alinamaz.
  if (StrKey.isValidEd25519SecretSeed(address)) {
    return fail('secret_key',
      'Bu bir GIZLI ANAHTAR. Adres degil.',
      'Ekrana veya bir dosyaya yapistirdiysan o cuzdani ARTIK KULLANMA. ' +
      'Yeni bir cuzdan olustur ve G ile baslayan ACIK adresini gir.')
  }

  if (StrKey.isValidMed25519PublicKey(address)) {
    return fail('desteklenmeyen_tip_muxed',
      'Muxed (M...) adresler henuz desteklenmiyor.',
      'Bu adresin altindaki G... adresini gir.')
  }

  if (StrKey.isValidContract(address)) {
    // Klasik `payment` operasyonunun hedefi G veya M olmak zorunda; C olamaz.
    // Contract account'a USDC gondermek SAC `transfer` cagrisi demek ve bir
    // Soroban transaction'inda tek host-function op'u bulunur, klasik op'larla
    // karismaz — batch modelini matematiksel olarak kirar.
    return fail('desteklenmeyen_tip_contract',
      'Akilli cuzdan (C...) adresleri henuz desteklenmiyor.',
      'Freighter veya LOBSTR ile olusturulmus G... adresi gir.')
  }

  if (!StrKey.isValidEd25519PublicKey(address)) {
    return fail('gecersiz_bicim',
      'Gecerli bir Stellar adresi degil.',
      'Adres G ile baslar ve 56 karakterdir.')
  }

  return OK
}

/** Zincirden okunan hesap durumu. `PaymentRail` doldurur. */
export interface OnChainAccount {
  readonly exists: boolean
  readonly trustline: {
    readonly exists: boolean
    readonly authorized: boolean
    /** Bakiye + gelecek odeme limiti asiyor mu? */
    readonly limit: bigint
    readonly balance: bigint
  } | null
  /** SEP-29 — hesap `config.memo_required` data entry'si tasiyor mu? */
  readonly memoRequired: boolean
}

export interface OnChainCheckInput {
  readonly address: string
  readonly account: OnChainAccount
  /** Odenmesi planlanan tutar — trustline limiti bunun icin kontrol edilir. */
  readonly plannedAmount: bigint
  readonly assetIssuer: string
  /** Adres baska bir publisher'a bagli mi? */
  readonly boundToOther: boolean
}

/** Zincir ustu kontroller — ADR-020 tablosunun 3-9. maddeleri. */
export function checkAddressOnChain(input: OnChainCheckInput): AddressCheck {
  const { address, account } = input

  // Issuer'a odeme yapmak varligi YAKAR. Geri donusu yok.
  if (address === input.assetIssuer) {
    return fail('issuer_adresi',
      'Bu adres USDC ihraccisinin kendisi.',
      'Buraya gonderilen USDC yok olur. Kendi cuzdan adresini gir.')
  }

  if (input.boundToOther) {
    // Ayni adresin N hesaba baglanabilmesi ADR-010'un sybil savunmasinda delik:
    // 500 GitHub hesabi tek cuzdana odeme yapabilirdi.
    return fail('baska_hesaba_bagli',
      'Bu adres baska bir Dwell hesabina bagli.',
      'Her adres yalnizca bir hesaba baglanabilir.')
  }

  if (!account.exists) {
    return fail('hesap_yok',
      'Bu hesap Stellar aginda bulunamadi veya hic fonlanmamis.',
      'Hesabin en az 1 XLM ile aktiflestirilmis olmasi gerekiyor.')
  }

  if (account.memoRequired) {
    // Memo transaction seviyesindedir, operation seviyesinde DEGILDIR. Toplu
    // odemede hedef basina memo koymak imkansiz; memo'suz gonderilen para
    // borsada kaybolur ve geri gelmez.
    return fail('memo_gerekiyor',
      'Bu adres memo gerektiriyor — muhtemelen bir borsa yatirma adresi.',
      'Borsa adresi baglanamaz. Freighter veya LOBSTR gibi kendi cuzdanini kullan.')
  }

  if (!account.trustline?.exists) {
    return fail('trustline_yok',
      'Bu adreste USDC trustline yok.',
      'Asagidaki "USDC\'yi aktiflestir" butonuna bas — rezervi biz karsiliyoruz.')
  }

  if (!account.trustline.authorized) {
    // Sinsi ara durum: `authorized_to_maintain_liabilities`. Trustline listede
    // gorunur, odeme yine `op_not_authorized` ile patlar.
    return fail('trustline_yetkisiz',
      'USDC trustline yetkilendirilmemis.',
      'USDC ihraccisi bu adresi yetkilendirmemis. Baska bir adres dene.')
  }

  if (account.trustline.balance + input.plannedAmount > account.trustline.limit) {
    // `op_line_full` TUM batch'i dusurur — dokumanin ilk surumunde bu kontrol
    // hic yoktu.
    return fail('trustline_limiti_yetersiz',
      'USDC trustline limiti yetersiz.',
      'Cuzdanindan USDC trustline limitini yukselt.')
  }

  return OK
}

/** Iki asamayi birlestirir. */
export function checkAddress(input: OnChainCheckInput): AddressCheck {
  const format = checkAddressFormat(input.address)
  return format.ok ? checkAddressOnChain(input) : format
}

/** Kullaniciya gosterilirken adresi kisalt. Tam hali kopyalanabilir kalmali. */
export const shortAddress = (a: string): string =>
  a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a
