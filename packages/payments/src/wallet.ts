/**
 * Cuzdan baglama akisi — ADR-014, ADR-020.
 *
 * Iki ayri saldiriya karsi tasarlandi:
 *
 *   • **Hesap ele gecirme.** Token'i calan biri adresi kendi cuzdanina cevirip
 *     birikmis bakiyeyi aninda ceker. 72 saatlik bekleme + bildirim kullaniciya
 *     tepki penceresi acar.
 *
 *     DIKKAT: imza ispati bu saldiriyi ENGELLEMEZ. Saldirgan challenge'i kendi
 *     cuzdaniyla imzalar ve dogrulama sorunsuz gecer. Imza yalnizca "hedef
 *     adresin sahibi bu istegi yapti" der, "hesabin gercek sahibi yapti"
 *     demez. Tek savunma bekleme suresi ve bildirimdir.
 *
 *   • **Yanlis adres.** Zincir ustu odeme geri alinamaz. Imza ispati,
 *     kullanicinin gercekten kontrol etmedigi bir adrese odeme yapilmasini
 *     engeller.
 */

import type { Clock } from '@dwell/protocol'

export type Network = 'testnet' | 'pubnet'

export interface WalletBinding {
  readonly publisherId: string
  readonly address: string
  readonly network: Network
  readonly verifiedAt: number
  /** Adres DEGISTIRILDIYSE bu zamana kadar odeme yapilmaz. */
  readonly holdUntil: number | null
  readonly previousAddress: string | null
}

export type PayoutBlock =
  | { readonly blocked: false }
  | { readonly blocked: true; readonly reason: string; readonly until: number | null }

export interface WalletStoreDeps {
  readonly clock: Clock
  /** ADR-014 — adres degisikligi sonrasi bekleme. */
  readonly holdMs?: number
  /** Bildirim kanallari: e-posta VE daemon uzerinden terminal (§E1). */
  readonly notify: (n: WalletChangeNotice) => void
}

export interface WalletChangeNotice {
  readonly publisherId: string
  readonly previousAddress: string | null
  readonly newAddress: string
  readonly holdUntil: number
  readonly kind: 'ilk_baglama' | 'adres_degisti'
}

/** ADR-014 — 72 saat. */
export const DEFAULT_HOLD_MS = 72 * 3600_000

export class WalletStore {
  readonly #byPublisher = new Map<string, WalletBinding>()
  readonly #byAddress = new Map<string, string>()

  constructor(private readonly deps: WalletStoreDeps) {}

  get(publisherId: string): WalletBinding | null {
    return this.#byPublisher.get(publisherId) ?? null
  }

  /** ADR-020 #9 — bu adres baska bir hesaba bagli mi? */
  boundToOther(address: string, publisherId: string): boolean {
    const owner = this.#byAddress.get(address)
    return owner !== undefined && owner !== publisherId
  }

  /**
   * Adresi baglar. Cagiran taraf ONCE SEP-10 dogrulamasini ve ADR-020
   * kontrollerini gecmis olmali — burada tekrar kontrol edilmez.
   */
  bind(publisherId: string, address: string, network: Network): WalletBinding {
    const now = this.deps.clock.now()
    const hold = this.deps.holdMs ?? DEFAULT_HOLD_MS
    const previous = this.#byPublisher.get(publisherId) ?? null

    // Ayni adresi yeniden baglamak degisiklik sayilmaz — bekleme baslamaz.
    // Aksi halde kullanici dogrulamayi tazeledigi her seferinde 72 saat
    // cezalandirilirdi.
    const changed = previous !== null && previous.address !== address

    const binding: WalletBinding = {
      publisherId, address, network,
      verifiedAt: now,
      holdUntil: changed ? now + hold : null,
      previousAddress: previous?.address ?? null,
    }

    if (previous && previous.address !== address) this.#byAddress.delete(previous.address)
    this.#byPublisher.set(publisherId, binding)
    this.#byAddress.set(address, publisherId)

    // Bildirim HER baglamada gider — ilk baglamada da. Kullanici kendisi
    // yapmadiysa bunu ancak bildirimle ogrenir.
    this.deps.notify({
      publisherId,
      previousAddress: previous?.address ?? null,
      newAddress: address,
      holdUntil: binding.holdUntil ?? now,
      kind: changed ? 'adres_degisti' : 'ilk_baglama',
    })

    return binding
  }

  /**
   * Odeme yapilabilir mi?
   *
   * Odeme job'i bunu HER batch oncesi sorar. `blocked` ise o publisher
   * batch'ten dusurulur — patlamasina izin verilmez.
   */
  payoutBlock(publisherId: string): PayoutBlock {
    const b = this.#byPublisher.get(publisherId)
    if (!b) {
      return { blocked: true, reason: 'cuzdan bagli degil', until: null }
    }
    if (b.holdUntil !== null && this.deps.clock.now() < b.holdUntil) {
      const kalanSaat = Math.ceil((b.holdUntil - this.deps.clock.now()) / 3600_000)
      return {
        blocked: true,
        reason: `adres degisikligi beklemesi — ${kalanSaat} saat kaldi`,
        until: b.holdUntil,
      }
    }
    return { blocked: false }
  }

  /**
   * Kullanici "ben degilim" dedi — degisiklik geri alinir.
   *
   * Bildirimdeki tek tiklik kurtarma yolu (§E1). Onceki adres varsa ona
   * donulur; yoksa baglama tamamen kaldirilir.
   */
  revert(publisherId: string): WalletBinding | null {
    const current = this.#byPublisher.get(publisherId)
    if (!current) return null

    this.#byAddress.delete(current.address)
    if (!current.previousAddress) {
      this.#byPublisher.delete(publisherId)
      return null
    }

    const restored: WalletBinding = {
      publisherId,
      address: current.previousAddress,
      network: current.network,
      verifiedAt: this.deps.clock.now(),
      // Geri donuste bekleme YOK: kullanici zaten bu adresi daha once
      // dogrulamisti ve simdi aktif olarak sahiplendi.
      holdUntil: null,
      previousAddress: null,
    }
    this.#byPublisher.set(publisherId, restored)
    this.#byAddress.set(restored.address, publisherId)
    return restored
  }

  /**
   * Ag degisimi — testnet baglamalari mainnet'e TASINMAZ.
   *
   * Pilotta kullanicilar deneme keypair'i baglayip secret'ini atacak.
   * Mainnet'e gecerken bunlar aynen tasinirsa gercek USDC erisilemez
   * adreslere gider.
   */
  invalidateForNetwork(target: Network): number {
    let n = 0
    for (const [pub, b] of this.#byPublisher) {
      if (b.network !== target) {
        this.#byAddress.delete(b.address)
        this.#byPublisher.delete(pub)
        n++
      }
    }
    return n
  }
}
