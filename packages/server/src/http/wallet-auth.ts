/**
 * Cuzdanla giris — ADR-010 (2026-08-15 revizyonu), ADR-014.
 *
 * Akis:
 *   1. Istemci adresini verir       → sunucu SEP-10 challenge uretir
 *   2. Kullanici cuzdaniyla imzalar → sunucu dogrular
 *   3. Sunucu device token uretir   → istemci onu saklar
 *
 * Challenge `sequence = 0` olan bir transaction'dir; aga HICBIR ZAMAN
 * submit edilemez. Guvenlik yapinin kendisinden gelir, bizim dikkatimizden
 * degil (ADR-014).
 *
 * `publisherId` adresin KENDISIDIR. Ayri bir kullanici tablosu yok:
 * kimlik ile odeme hedefi ayni sey, ikisini ayirmak gereksiz bir eslesme
 * katmani yaratirdi.
 */

import { Keypair, TransactionBuilder } from '@stellar/stellar-sdk'
import { Sep10, type VerifyResult } from '@dwell/payments'
import { StrKey } from '@stellar/stellar-sdk'
import type { Clock, IdGenerator, TokenScope } from '@dwell/protocol'

export interface PendingChallenge {
  readonly address: string
  /** Islemin imzasiz govdesinin hash'i — gelen imzayi buna eslestiririz. */
  readonly hash: string
  readonly expiresAt: number
}

/**
 * Adres basina bekleyen challenge sayisi.
 *
 * Adres basina TEK challenge tutulsaydi, baskasinin adresine surekli yeni
 * challenge isteyen biri o kisinin imzaladigi challenge'i ezip girisini
 * engellerdi. Birkac tane tutuyoruz; her biri tek kullanimlik. IP basina hiz
 * siniri (app.ts) tek bir kaynagin bu pencereyi doldurmasini yavaslatir.
 */
const MAX_PER_ADDRESS = 20

/**
 * Bellekteki toplam bekleyen challenge. Rastgele adreslerle spam bellegi
 * sinirsiz buyutmesin; dolarsa yeni challenge "birazdan tekrar dene" alir.
 */
const MAX_TOTAL = 10_000

/**
 * Islemin imzasiz govdesinin hash'i. Imzalar zarfta, govdede degil; yani
 * kullanici imzalasa da ayni kalir ve "bu, bizim verdigimiz challenge mi"
 * sorusunu cevaplar.
 */
function txHash(xdr: string, networkPassphrase: string): string | null {
  try { return TransactionBuilder.fromXDR(xdr, networkPassphrase).hash().toString('hex') }
  catch { return null }
}

export interface WalletAuthDeps {
  readonly clock: Clock
  readonly ids: IdGenerator
  readonly sep10: Sep10
  /** Hesabin zincirdeki signer listesi. `null` → hesap yok, master key'e bakilir. */
  readonly loadSigners: (address: string) => Promise<
    { signers: readonly { key: string; weight: number }[]; medThreshold: number } | null
  >
  /** Uretilen token'i saklar; ham token DEGIL, hash'i saklanir. */
  readonly issueToken: (input: {
    publisherId: string
    tokenHash: string
    scopes: readonly TokenScope[]
    role: Role
  }) => { tokenId: string }
  readonly hashToken: (raw: string) => string
  /** Testler icin; varsayilanlar `MAX_PER_ADDRESS` / `MAX_TOTAL`. */
  readonly maxPerAddress?: number
  readonly maxTotal?: number
}

/**
 * Rol basina kapsamlar.
 *
 * Ayni cuzdan hem yayinci hem reklamveren olabilir — ama AYNI ANDA DEGIL,
 * ayni token'la degil. Iki ayri giris, iki ayri token.
 *
 * Sebep: kapsam karistirmak, calinmis bir daemon token'inin kampanya
 * olusturup butce harcamasi demek. Daemon her makinede duruyor; panel
 * token'i yalnizca tarayicida.
 */
export type Role = 'publisher' | 'advertiser'

export const SCOPES_BY_ROLE: Record<Role, readonly TokenScope[]> = {
  publisher: ['report:impressions', 'read:balance', 'withdraw:balance'],
  advertiser: ['manage:campaigns', 'read:spend'],
}

/** Geriye donuk ad. */
export const LOGIN_SCOPES = SCOPES_BY_ROLE.publisher

export type ChallengeResult =
  | { readonly ok: true; readonly xdr: string; readonly networkPassphrase: string; readonly expiresAt: number }
  | { readonly ok: false; readonly reason: string; readonly busy?: true }

export type LoginResult =
  | { readonly ok: true; readonly token: string; readonly tokenId: string; readonly publisherId: string }
  | { readonly ok: false; readonly reason: string; readonly detail?: string }

export class WalletAuth {
  /** Adres → bekleyen challenge'lar (eskiden yeniye). */
  readonly #pending = new Map<string, PendingChallenge[]>()
  #total = 0
  /** Sep10 tek bir ag icin kurulu; ilk challenge'da ogrenilir. */
  #networkPassphrase = ''

  constructor(private readonly deps: WalletAuthDeps) {}

  /** Adres icin challenge uretir. */
  challenge(address: string): ChallengeResult {
    // ADR-020: yalnizca `G...`. Muxed ve contract adresler burada da reddedilir
    // — kimlik ile odeme hedefi ayni sey oldugu icin ayni kurallar gecerli.
    if (!StrKey.isValidEd25519PublicKey(address)) {
      return { ok: false, reason: 'gecersiz Stellar adresi (G ile baslamali)' }
    }

    this.#gc()
    if (this.#total >= (this.deps.maxTotal ?? MAX_TOTAL)) {
      return { ok: false, reason: 'cok fazla bekleyen giris — birazdan tekrar dene', busy: true }
    }

    const c = this.deps.sep10.challenge(address)
    const hash = txHash(c.xdr, c.networkPassphrase)
    if (hash === null) return { ok: false, reason: 'challenge uretilemedi' }

    const list = this.#pending.get(address) ?? []
    list.push({ address, hash, expiresAt: c.expiresAt })
    this.#total++
    // Pencere dolduysa en eskisi duser.
    if (list.length > (this.deps.maxPerAddress ?? MAX_PER_ADDRESS)) { list.shift(); this.#total-- }
    this.#pending.set(address, list)
    this.#networkPassphrase = c.networkPassphrase
    return { ok: true, xdr: c.xdr, networkPassphrase: c.networkPassphrase, expiresAt: c.expiresAt }
  }

  /** Imzalanmis challenge'i dogrular ve token uretir. */
  async verify(address: string, signedXdr: string, role: Role = 'publisher'): Promise<LoginResult> {
    const list = this.#pending.get(address)
    if (!list || list.length === 0) {
      return { ok: false, reason: 'challenge bulunamadi — once /v1/auth/challenge' }
    }

    // Imzalanan islem, BU adres icin SU AN bekleyen challenge'lardan biri
    // olmali. Kullanilan challenge listeden silinir; yani onceki bir giristen
    // kalan (ve ele gecirilmis) imzali challenge — kendi zaman siniri icinde
    // gecerli bir SEP-10 islemi olsa bile — ikinci bir token alamaz.
    const hash = txHash(signedXdr, this.#networkPassphrase)
    const pending = hash === null ? undefined : list.find((p) => p.hash === hash)
    if (!pending) {
      return { ok: false, reason: 'imzalanan islem bekleyen bir challenge degil (zaten kullanilmis olabilir)' }
    }
    if (pending.expiresAt < this.deps.clock.now()) {
      this.#remove(address, pending)
      return { ok: false, reason: 'challenge suresi dolmus' }
    }

    let signers: Awaited<ReturnType<WalletAuthDeps['loadSigners']>>
    try {
      signers = await this.deps.loadSigners(address)
    } catch (e) {
      // Zincire ULASILAMIYORSA giris BASARISIZ olur — master key'e dusmek YOK.
      //
      // Ilk yazdigimda dusuyordu ve bu bir acikti: master key agirligi 0'a
      // cekilmis multisig bir hesapta, atilmis olabilecek master secret'la
      // atilan imza zincirde degersizdir. Horizon dustugunde onu kabul etmek,
      // "hesap yok" ile "goremiyorum"u ayni saymak demek.
      //
      // Girisi tekrar denemek bedavadir; yanlis kimlik baglamak geri alinamaz.
      return {
        ok: false,
        reason: 'zincire ulasilamadi — birazdan tekrar dene',
        detail: e instanceof Error ? e.message : String(e),
      }
    }

    const result: VerifyResult = this.deps.sep10.verify(signedXdr, address, signers)
    if (!result.ok) {
      return { ok: false, reason: 'imza dogrulanamadi', detail: result.reason }
    }

    // Tek kullanimlik: ayni imzayi ikinci kez gondermek yeni token uretemez.
    // `await` sonrasi tekrar kontrol: ayni imzayla iki es zamanli istek
    // Horizon'u beklerken ikisi de buraya gelebilir.
    if (!this.#remove(address, pending)) {
      return { ok: false, reason: 'imzalanan islem bekleyen bir challenge degil (zaten kullanilmis olabilir)' }
    }

    // Ham token YALNIZCA burada, bir kez gorunur. Sunucu hash'ini saklar.
    const raw = `dwl_${this.deps.ids.randomHex(24)}`
    const { tokenId } = this.deps.issueToken({
      publisherId: address,
      tokenHash: this.deps.hashToken(raw),
      scopes: SCOPES_BY_ROLE[role],
      role,
    })

    return { ok: true, token: raw, tokenId, publisherId: address }
  }

  /** Listeden siler; zaten yoksa `false`. */
  #remove(address: string, p: PendingChallenge): boolean {
    const list = this.#pending.get(address)
    const i = list ? list.indexOf(p) : -1
    if (!list || i === -1) return false
    list.splice(i, 1)
    this.#total--
    if (list.length === 0) this.#pending.delete(address)
    return true
  }

  /** Suresi dolmus challenge'lari at — bellek sinirsiz buyumesin. */
  #gc(): void {
    const now = this.deps.clock.now()
    for (const [k, list] of this.#pending) {
      const kalan = list.filter((p) => p.expiresAt >= now - 60_000)
      this.#total -= list.length - kalan.length
      if (kalan.length === 0) this.#pending.delete(k)
      else if (kalan.length !== list.length) this.#pending.set(k, kalan)
    }
  }

  pendingCount(): number { return this.#total }
}

/**
 * Zincirden signer listesi okur — multisig cuzdanlar icin.
 *
 * Hesap yoksa (404) `null` doner; SEP-10 o durumda master key'e bakar.
 * Diger hatalar YUKARI ATILIR: "Horizon dustu" ile "hesap yok" ayni sey
 * degil, ikisini birlestirmek multisig bir hesabi tek imzayla gecirebilir.
 */
export function horizonSigners(horizonUrl: string): WalletAuthDeps['loadSigners'] {
  return async (address) => {
    const res = await fetch(`${horizonUrl}/accounts/${address}`)
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`horizon ${res.status}`)
    const acc = (await res.json()) as {
      signers: { key: string; weight: number }[]
      thresholds: { med_threshold: number }
    }
    return { signers: acc.signers, medThreshold: acc.thresholds.med_threshold }
  }
}

/**
 * Sunucunun SEP-10 imzalama anahtari.
 *
 * `DWELL_SEP10_SECRET` verilmezse gelistirme icin uretilir — ama uretimde bu
 * SESSIZ BIR ARIZADIR: anahtar her yeniden baslatmada degisir, o sirada
 * imzalanmakta olan her challenge gecersiz olur ve kullanici "imza
 * dogrulanamadi" gorur. Sebebini de asla bulamaz, cunku hicbir sey bozuk
 * gorunmez.
 *
 * Bu yuzden gercek bir dagitimda (`DWELL_ENV=production`) anahtar YOKSA
 * sunucu hic acilmaz. Yanlis calisan bir giris, calismayan bir girise gore
 * cok daha pahali.
 */
export function serverKeypair(): Keypair {
  const secret = process.env['DWELL_SEP10_SECRET']
  if (secret) return Keypair.fromSecret(secret)

  if (process.env['DWELL_ENV'] === 'production') {
    throw new Error(
      'DWELL_SEP10_SECRET tanimli degil.\n' +
      'Uretimde sabit bir imzalama anahtari sart — yoksa her yeniden ' +
      'baslatmada degisir ve girisler sessizce bozulur.\n' +
      'Uret: node -e "console.log(require(\'@stellar/stellar-sdk\').Keypair.random().secret())"',
    )
  }
  return Keypair.random()
}
