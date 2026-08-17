/**
 * Reklamveren para yatirma — ADR-021.
 *
 * Problem: adresimize USDC geliyor, BU PARA KIMIN?
 *
 * Klasik cozum memo'dur ve kotudur: kullanici yazmayi unutur, para sahipsiz
 * kalir, elle destek gerekir. Ikinci klasik cozum reklamveren basina ayri
 * adrestir; temiz ama her hesap ~1,5 XLM kilitler ve hepsini yonetmek gerekir.
 *
 * Bizim cozumumuz daha basit: reklamveren de CUZDANIYLA giris yapiyor
 * (ADR-010). O zaman GONDEREN ADRESE bakariz — `G_ADV`'den gelen para
 * `G_ADV`'nin hesabina yazilir. Eslesme kendiliginden oluyor, memo yok.
 *
 * Bedeli: borsadan gonderen para eslesmez, cunku gonderen adres borsanindir.
 * Panelde acikca yaziyor. Testnet icin sorun degil; mainnet'te bu paralar
 * "eslesmeyen yatirma" olarak birikir ve elle cozulur.
 */

import type { Clock } from '@dwell/protocol'
import { stroops, type Stroops } from '@dwell/protocol'
import { toStroopBigint } from '@dwell/payments'
import type { Ledger } from '../ledger/ledger.js'

export interface DepositWatcherDeps {
  readonly clock: Clock
  readonly ledger: Ledger
  readonly horizonUrl: string
  /** Paranin gonderildigi adres — sicak cuzdan. */
  readonly destination: string
  readonly assetCode: string
  readonly assetIssuer: string
  /** Bu adres bir reklamverene ait mi? Degilse para bekletilir. */
  readonly isKnownAdvertiser: (address: string) => boolean
  readonly log: (m: string) => void
  /** Nereden devam edilecegi. Yeniden baslatmada kaldigi yerden. */
  readonly cursor: {
    readonly get: () => string | null
    readonly set: (c: string) => void
  }
  readonly fetchImpl?: typeof fetch
}

export interface DepositResult {
  readonly credited: number
  readonly unmatched: number
  readonly total: Stroops
}

export class DepositWatcher {
  #running = false

  constructor(private readonly deps: DepositWatcherDeps) {}

  /**
   * Zinciri tarar ve yeni odemeleri deftere yazar.
   *
   * Horizon'un `cursor`'u ile ilerliyor: her odemenin bir `paging_token`'i
   * var ve son islenenden sonrasini istiyoruz. Zaman damgasina gore
   * ilerlemek YANLIS olurdu — ayni saniyede birden fazla odeme olabilir.
   */
  async poll(): Promise<DepositResult> {
    if (this.#running) return { credited: 0, unmatched: 0, total: stroops(0n) }
    this.#running = true
    try {
      return await this.#poll()
    } finally {
      this.#running = false
    }
  }

  async #poll(): Promise<DepositResult> {
    const f = this.deps.fetchImpl ?? fetch
    const cursor = this.deps.cursor.get()
    const url = new URL(`${this.deps.horizonUrl}/accounts/${this.deps.destination}/payments`)
    url.searchParams.set('limit', '100')
    url.searchParams.set('order', 'asc')
    if (cursor) url.searchParams.set('cursor', cursor)

    let kayitlar: any[]
    try {
      const res = await f(url.toString(), { signal: AbortSignal.timeout(15_000) })
      if (!res.ok) {
        this.deps.log(`yatirma taramasi: HTTP ${res.status}`)
        return { credited: 0, unmatched: 0, total: stroops(0n) }
      }
      kayitlar = ((await res.json()) as any)._embedded?.records ?? []
    } catch (e) {
      // Ag hatasi SESSIZ gecilmez ama akisi durdurmaz: bir sonraki turda
      // ayni cursor'dan devam edilir, hicbir odeme atlanmaz.
      this.deps.log(`yatirma taramasi basarisiz: ${e instanceof Error ? e.message : String(e)}`)
      return { credited: 0, unmatched: 0, total: stroops(0n) }
    }

    let credited = 0, unmatched = 0
    let toplam = 0n
    let sonToken: string | null = null

    for (const p of kayitlar) {
      sonToken = String(p.paging_token)

      // Yalnizca BIZE gelen, BIZIM varligimizdan olan odemeler.
      if (p.type !== 'payment') continue
      if (p.to !== this.deps.destination) continue
      if (p.asset_code !== this.deps.assetCode || p.asset_issuer !== this.deps.assetIssuer) continue
      // `transaction_successful` false ise para HAREKET ETMEDI.
      if (p.transaction_successful === false) continue

      const gonderen = String(p.from)
      const tutar = toStroopBigint(String(p.amount))
      if (tutar <= 0n) continue

      if (!this.deps.isKnownAdvertiser(gonderen)) {
        // Taninmayan adres. Para duruyor, kaybolmadi — ama kimin oldugunu
        // bilmedigimiz icin deftere yazamiyoruz. Cursor ilerledigi icin
        // bir daha bakilmayacak; elle cozulmesi gerekiyor.
        unmatched++
        this.deps.log(
          `⚠ eslesmeyen yatirma: ${p.amount} ${p.asset_code} ` +
          `${gonderen.slice(0, 8)}…${gonderen.slice(-4)} tx ${String(p.transaction_hash).slice(0, 12)}…`,
        )
        continue
      }

      // Idempotency: `topupId` islem hash'i + operasyon kimligi. Ayni odeme
      // iki kez taranirsa defter ikincisini reddeder (ADR-005).
      const topupId = `chain:${p.transaction_hash}:${p.id}`
      try {
        this.deps.ledger.deposit({
          advertiserId: gonderen,
          amount: stroops(tutar),
          topupId,
        })
        credited++
        toplam += tutar
        this.deps.log(`yatirma: ${p.amount} ${p.asset_code} → ${gonderen.slice(0, 8)}…`)
      } catch (e) {
        this.deps.log(`yatirma yazilamadi (${topupId}): ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    // Cursor EN SONDA ilerletilir. Once ilerletseydik ve arada patlasaydik,
    // islenmemis odemeler atlanirdi.
    if (sonToken) this.deps.cursor.set(sonToken)

    return { credited, unmatched, total: stroops(toplam) }
  }
}

/** Cursor'u diskte tutar — yeniden baslatmada bastan taramamak icin. */
export function sqliteCursor(db: import('../store/db.js').Db, key = 'deposit_cursor') {
  return {
    get: (): string | null => {
      const r = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as any
      return r ? String(r.value) : null
    },
    set: (c: string): void => {
      db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(key, c)
    },
  }
}
