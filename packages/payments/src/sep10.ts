/**
 * SEP-10 Web Authentication — ADR-014.
 *
 * Kullanicinin bir adresi kontrol ettigini ispatlamanin standart yolu.
 *
 * Neden kendi challenge'imizi yazmiyoruz: SEP-10 challenge'i `sequence = 0`
 * olan bir transaction'dir ve bu yuzden aga **HICBIR ZAMAN submit edilemez.**
 * Guvenlik ozelligi yapinin kendisinden gelir.
 *
 * Ham imza yolu iki sebeple reddedildi:
 *   1. Kimse secret key'ini bir CLI'a yapistirmaz; yapistiran da bos bir
 *      keypair uretip yapistirir — ispat degersizlesir.
 *   2. Sunucunun sectigi ham byte'lari imzalatmak bir "signing oracle"dir:
 *      ele gecirilmis bir sunucu challenge yerine gercek bir odeme
 *      transaction'inin hash'ini gonderip cuzdani bosaltabilir.
 *
 * Ayrica multisig hesaplar (LOBSTR 2FA, kurumsal treasury) master key
 * agirligini 0'a ceker; ham ed25519 dogrulamasi bu hesaplari YANLISLIKLA
 * REDDEDER. `verifyChallengeTxThreshold` signer setini ve esigi zincirden
 * okuyup dogru karari verir.
 */

import { Keypair, Networks, WebAuth } from '@stellar/stellar-sdk'
import type { Clock } from '@dwell/protocol'

export interface Sep10Config {
  /** Sunucunun imzalama anahtari. `stellar.toml`'da SIGNING_KEY olarak yayinlanir. */
  readonly serverKeypair: Keypair
  /** `stellar.toml`'in barindigi alan adi. */
  readonly homeDomain: string
  /** Challenge'i sunan uc noktanin alan adi. */
  readonly webAuthDomain: string
  readonly networkPassphrase: string
  /** Challenge omru. Kisa tutulur — replay penceresini daraltir. */
  readonly timeoutSec?: number
}

export interface ChallengeResult {
  readonly xdr: string
  readonly networkPassphrase: string
  readonly expiresAt: number
}

export type VerifyFailure =
  | 'gecersiz_xdr'
  | 'imza_yok'
  | 'imza_gecersiz'
  | 'esik_altinda'
  | 'suresi_dolmus'
  | 'yanlis_ag'
  | 'yanlis_hesap'

export type VerifyResult =
  | { readonly ok: true; readonly account: string; readonly signers: readonly string[] }
  | { readonly ok: false; readonly reason: VerifyFailure; readonly detail: string }

export const DEFAULT_TIMEOUT_SEC = 300

export class Sep10 {
  constructor(private readonly cfg: Sep10Config, private readonly clock: Clock) {}

  /**
   * Challenge uretir. Bu transaction submit EDILEMEZ (`sequence = 0`),
   * dolayisiyla kullaniciya zarar veremez.
   */
  challenge(clientAccount: string, memo?: string): ChallengeResult {
    const timeout = this.cfg.timeoutSec ?? DEFAULT_TIMEOUT_SEC
    const now = Math.floor(this.clock.now() / 1000)

    const xdr = WebAuth.buildChallengeTx(
      this.cfg.serverKeypair,
      clientAccount,
      this.cfg.homeDomain,
      timeout,
      this.cfg.networkPassphrase,
      this.cfg.webAuthDomain,
      memo ?? null,
    )

    return { xdr, networkPassphrase: this.cfg.networkPassphrase, expiresAt: (now + timeout) * 1000 }
  }

  /**
   * Imzalanmis challenge'i dogrular.
   *
   * `async` ve gerekce donuyor — ilk tasarimdaki `boolean` yetersizdi:
   * multisig dogrulamasi hesabin signer listesini ve esigini AGDAN okumayi
   * gerektiriyor, ve red sebebini kaybetmek kullaniciya "gecersiz" demekten
   * baska bir sey soyleyememek demek.
   */
  verify(
    signedXdr: string,
    clientAccount: string,
    account: { signers: readonly { key: string; weight: number }[]; medThreshold: number } | null,
  ): VerifyResult {
    let tx
    try {
      const read = WebAuth.readChallengeTx(
        signedXdr,
        this.cfg.serverKeypair.publicKey(),
        this.cfg.networkPassphrase,
        this.cfg.homeDomain,
        this.cfg.webAuthDomain,
      )
      tx = read.tx
      if (read.clientAccountID !== clientAccount) {
        return { ok: false, reason: 'yanlis_hesap', detail: `beklenen ${clientAccount}, gelen ${read.clientAccountID}` }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // Ag yanlissa mesaj bunu soyler; ayirt etmek onemli cunku testnette
      // uretilmis bir imza mainnette gecerli SAYILMAMALI.
      if (/network/i.test(msg)) return { ok: false, reason: 'yanlis_ag', detail: msg }
      if (/expired|time bounds/i.test(msg)) return { ok: false, reason: 'suresi_dolmus', detail: msg }
      return { ok: false, reason: 'gecersiz_xdr', detail: msg }
    }

    try {
      if (account === null) {
        // Hesap zincirde YOKSA SEP-10 master key'e karsi dogrular. Bizim
        // durumumuzda fonlanmamis hesap zaten odenemez (ADR-020), ama
        // dogrulama asamasinda reddetmiyoruz — sebep ayri raporlanir.
        const signers = WebAuth.verifyChallengeTxSigners(
          signedXdr, this.cfg.serverKeypair.publicKey(), this.cfg.networkPassphrase,
          [clientAccount], this.cfg.homeDomain, this.cfg.webAuthDomain,
        )
        return { ok: true, account: clientAccount, signers }
      }

      // DIKKAT: `threshold` bir SAYI. Nesne gecirilirse JS sessizce kabul
      // eder, karsilastirma NaN uretir ve esik kontrolu ETKISIZ KALIR —
      // yetersiz tek imza gecer. Tip imzasi bunu yakalamiyor, test yakaladi.
      const signers = WebAuth.verifyChallengeTxThreshold(
        signedXdr, this.cfg.serverKeypair.publicKey(), this.cfg.networkPassphrase,
        account.medThreshold,
        account.signers.map((s) => ({ key: s.key, weight: s.weight, type: 'ed25519_public_key' as const })),
        this.cfg.homeDomain, this.cfg.webAuthDomain,
      )
      return { ok: true, account: clientAccount, signers }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (/threshold/i.test(msg)) return { ok: false, reason: 'esik_altinda', detail: msg }
      if (/no signature|not signed/i.test(msg)) return { ok: false, reason: 'imza_yok', detail: msg }
      return { ok: false, reason: 'imza_gecersiz', detail: msg }
    }
  }
}

export const NETWORKS = {
  testnet: Networks.TESTNET,
  pubnet: Networks.PUBLIC,
} as const
