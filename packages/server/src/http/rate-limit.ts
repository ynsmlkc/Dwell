/**
 * Anahtar basina token kovasi — `/v1/ads/next` icin (PROBLEMS.md #1.4).
 *
 * Her gosterim sunucunun verdigi bir nonce'u tuketiyor. Nonce uretimi hiz
 * sinirliysa, bir yayincinin bildirebilecegi gosterim sayisi GERCEK GECEN
 * SUREYLE sinirli olur — ve bu sure SUNUCUNUN saatiyle olculur, istemcinin
 * degil. "Duvar saati kurali" (#1.2) boylece kaynakta uygulanmis oluyor:
 * istemci saatini ya da `clientTs`'i ne kadar kurcalarsa kurcalasin, bir
 * saatte alabilecegi nonce sayisi sabit.
 *
 * Varsayilanlar gercek kullanimdan: aktif bir daemon ~20 saniyede bir reklam
 * tuketiyor (ADR-022 rotasyonu) ve acilista 3 tane onden cekiyor. Kova 10,
 * 10 saniyede bir dolum → iki makinede kesintisiz calisan bir yayinciya
 * bile pay kalir; tek hesap saatte en fazla ~360 nonce alir.
 */

export interface RateLimitOptions {
  readonly now: () => number
  /** Kovanin alabilecegi en fazla jeton — ani istek patlamasi payi. */
  readonly capacity?: number
  /** Bir jetonun dolma suresi. */
  readonly refillMs?: number
}

export class RateLimiter {
  readonly #buckets = new Map<string, { tokens: number; at: number }>()
  readonly #capacity: number
  readonly #refillMs: number

  constructor(private readonly opts: RateLimitOptions) {
    this.#capacity = opts.capacity ?? 10
    this.#refillMs = opts.refillMs ?? 10_000
  }

  /** Jeton varsa harcar ve `0` doner; yoksa bir sonraki jetona kalan ms. */
  take(key: string): number {
    const now = this.opts.now()
    const b = this.#buckets.get(key) ?? { tokens: this.#capacity, at: now }
    const dolan = Math.floor((now - b.at) / this.#refillMs)
    if (dolan > 0) {
      b.tokens = Math.min(this.#capacity, b.tokens + dolan)
      // Kesirli kalan sure kaybolmasin; kova doluysa saat simdiye gelir.
      b.at = b.tokens === this.#capacity ? now : b.at + dolan * this.#refillMs
    }
    if (b.tokens < 1) {
      this.#buckets.set(key, b)
      return this.#refillMs - (now - b.at)
    }
    b.tokens -= 1
    this.#buckets.set(key, b)
    this.#gc(now)
    return 0
  }

  /** Dolmus kovalar bilgi tasimiyor — bellek yayinci sayisiyla buyumesin. */
  #gc(now: number): void {
    if (this.#buckets.size < 10_000) return
    const tam = this.#capacity * this.#refillMs
    for (const [k, b] of this.#buckets) if (now - b.at >= tam) this.#buckets.delete(k)
  }
}
