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

import { Keypair } from '@stellar/stellar-sdk'
import { Sep10, type VerifyResult } from '@dwell/payments'
import { StrKey } from '@stellar/stellar-sdk'
import type { Clock, IdGenerator, TokenScope } from '@dwell/protocol'

export interface PendingChallenge {
  readonly address: string
  readonly xdr: string
  readonly expiresAt: number
  consumed: boolean
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
  }) => { tokenId: string }
  readonly hashToken: (raw: string) => string
}

/** Yeni girisin alacagi kapsamlar. Daemon cuzdan degistiremez (ADR-014). */
export const LOGIN_SCOPES: readonly TokenScope[] = ['report:impressions', 'read:balance']

export type ChallengeResult =
  | { readonly ok: true; readonly xdr: string; readonly networkPassphrase: string; readonly expiresAt: number }
  | { readonly ok: false; readonly reason: string }

export type LoginResult =
  | { readonly ok: true; readonly token: string; readonly tokenId: string; readonly publisherId: string }
  | { readonly ok: false; readonly reason: string; readonly detail?: string }

export class WalletAuth {
  readonly #pending = new Map<string, PendingChallenge>()

  constructor(private readonly deps: WalletAuthDeps) {}

  /** Adres icin challenge uretir. */
  challenge(address: string): ChallengeResult {
    // ADR-020: yalnizca `G...`. Muxed ve contract adresler burada da reddedilir
    // — kimlik ile odeme hedefi ayni sey oldugu icin ayni kurallar gecerli.
    if (!StrKey.isValidEd25519PublicKey(address)) {
      return { ok: false, reason: 'gecersiz Stellar adresi (G ile baslamali)' }
    }

    const c = this.deps.sep10.challenge(address)
    this.#pending.set(address, { address, xdr: c.xdr, expiresAt: c.expiresAt, consumed: false })
    this.#gc()
    return { ok: true, xdr: c.xdr, networkPassphrase: c.networkPassphrase, expiresAt: c.expiresAt }
  }

  /** Imzalanmis challenge'i dogrular ve token uretir. */
  async verify(address: string, signedXdr: string): Promise<LoginResult> {
    const pending = this.#pending.get(address)
    if (!pending) return { ok: false, reason: 'challenge bulunamadi — once /v1/auth/challenge' }

    // Tek kullanimlik: ayni imzayi ikinci kez gondermek yeni token uretemez.
    if (pending.consumed) return { ok: false, reason: 'challenge zaten kullanilmis' }
    if (pending.expiresAt < this.deps.clock.now()) {
      this.#pending.delete(address)
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

    pending.consumed = true
    this.#pending.delete(address)

    // Ham token YALNIZCA burada, bir kez gorunur. Sunucu hash'ini saklar.
    const raw = `dwl_${this.deps.ids.randomHex(24)}`
    const { tokenId } = this.deps.issueToken({
      publisherId: address,
      tokenHash: this.deps.hashToken(raw),
      scopes: LOGIN_SCOPES,
    })

    return { ok: true, token: raw, tokenId, publisherId: address }
  }

  /** Suresi dolmus challenge'lari at — bellek sinirsiz buyumesin. */
  #gc(): void {
    const now = this.deps.clock.now()
    for (const [k, v] of this.#pending) {
      if (v.expiresAt < now - 60_000) this.#pending.delete(k)
    }
  }

  pendingCount(): number { return this.#pending.size }
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
