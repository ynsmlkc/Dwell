/**
 * Sunucu iletisimi — ADR-003.
 *
 * KATI KURAL: bu dosyadaki hicbir sey shim'in yolunu bloklamaz. Shim
 * daemon'a sorar, daemon ONBELLEKTEN cevap verir. Ag islemleri arka planda,
 * kendi temposunda doner.
 *
 * Ag koptugunda urun DURMAZ:
 *   • Reklam onbellekten servis edilir; onbellek bosalirsa hicbir sey basilmaz
 *   • Gosterimler diske yazilmaya devam eder, kuyruk buyur
 *   • Sunucu dondugunde kuyruk bosalir
 *
 * Kimse "sunucu yok" diye hata gormez.
 */

import { remoteConfigSchema, FALLBACK_CONFIG, PROTOCOL_HEADER, PROTOCOL_VERSION } from '@dwell/protocol'
import type { AdPayload, RemoteConfig } from '@dwell/protocol'
import type { CompletedImpression } from './turns.js'
import type { ImpressionQueue } from './queue.js'

export interface SyncOptions {
  readonly baseUrl: string
  readonly token: string
  readonly clientVersion: string
  readonly queue: ImpressionQueue
  readonly config: () => RemoteConfig
  readonly setConfig: (c: RemoteConfig) => void
  readonly onLog: (m: string) => void
  /** Onbellekte tutulacak reklam sayisi. */
  readonly prefetchCount?: number
  readonly fetchImpl?: typeof fetch
}

export interface SyncState {
  readonly lastContactMs: number | null
  readonly lastError: string | null
  readonly adsCached: number
}

const TIMEOUT_MS = 10_000

export class ServerSync {
  #ads: AdPayload[] = []
  #lastContact: number | null = null
  #lastError: string | null = null
  #timers: NodeJS.Timeout[] = []
  #stopped = false

  constructor(private readonly opts: SyncOptions) {}

  state(): SyncState {
    return { lastContactMs: this.#lastContact, lastError: this.#lastError, adsCached: this.#ads.length }
  }

  /**
   * Siradaki reklam — SENKRON, ag yok.
   *
   * Onbellek bosaldiysa `null` doner ve hicbir sey basilmaz. Bos bir reklam
   * gostermektense susmak dogrudur.
   */
  nextAd(): AdPayload | null {
    const now = Date.now()
    // Suresi dolmus nonce'lu reklamlar atilir: sunucu onlari zaten reddeder.
    while (this.#ads.length > 0 && this.#ads[0]!.nonceExpiresAt <= now) this.#ads.shift()
    const ad = this.#ads.shift() ?? null
    if (this.#ads.length < 2) void this.#prefetch()      // arka planda doldur
    return ad
  }

  start(): void {
    void this.#pollConfig()
    void this.#prefetch()
    void this.#flush()

    const every = (ms: number, fn: () => Promise<void>): void => {
      const t = setInterval(() => { if (!this.#stopped) void fn() }, ms)
      t.unref()
      this.#timers.push(t)
    }
    every(this.opts.config().configPollSec * 1000, () => this.#pollConfig())
    every(this.opts.config().reportIntervalSec * 1000, () => this.#flush())
    every(30_000, () => this.#prefetch())
  }

  stop(): void {
    this.#stopped = true
    for (const t of this.#timers) clearInterval(t)
    this.#timers = []
  }

  /** Kapanirken son bir deneme — kuyruk diskte kalir, kaybolmaz. */
  async flushNow(): Promise<void> { await this.#flush() }

  /* ─────────────────────────── ic isler ─────────────────────────── */

  async #req(path: string, init: RequestInit = {}): Promise<Response | null> {
    const f = this.opts.fetchImpl ?? fetch
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    try {
      const res = await f(`${this.opts.baseUrl}${path}`, {
        ...init,
        signal: ctrl.signal,
        headers: {
          authorization: `Bearer ${this.opts.token}`,
          'content-type': 'application/json',
          'x-dwell-client-version': this.opts.clientVersion,
          ...(init.headers ?? {}),
        },
      })
      this.#lastContact = Date.now()

      // ADR-016 — sunucu bizi eski buluyorsa render'i durdur. Kullaniciya
      // sessizce yanlis calisan bir istemci birakmaktansa susmak dogru.
      if (res.status === 426) {
        this.#lastError = 'istemci surumu cok eski — `npm i -g dwell` ile guncelle'
        this.opts.setConfig({ ...this.opts.config(), renderEnabled: false })
        this.opts.onLog(this.#lastError)
        return null
      }
      if (!res.ok && res.status !== 204) {
        this.#lastError = `HTTP ${res.status} ${path}`
        return null
      }
      this.#lastError = null
      return res
    } catch (e) {
      // Ag hatasi SESSIZ. Kullanici bunu gormez, urun calismaya devam eder.
      this.#lastError = e instanceof Error ? e.message : String(e)
      return null
    } finally {
      clearTimeout(t)
    }
  }

  async #prefetch(): Promise<void> {
    const want = this.opts.prefetchCount ?? 3
    while (this.#ads.length < want) {
      const res = await this.#req('/v1/ads/next', { method: 'POST' })
      if (!res) return
      // 204 = "su an gosterecek bir sey yok". Hata degil; onbellek bos kalir.
      if (res.status === 204) return
      try {
        const ad = (await res.json()) as AdPayload
        if (!ad?.nonce || !ad?.creative) return
        this.#ads.push(ad)
      } catch { return }
    }
  }

  async #pollConfig(): Promise<void> {
    const res = await this.#req('/v1/config', { method: 'GET' })
    if (!res) return
    try {
      const parsed = remoteConfigSchema.safeParse(await res.json())
      if (parsed.success) this.opts.setConfig(parsed.data)
      // Sema tutmuyorsa MEVCUT config korunur. Bozuk bir config'i uygulamak,
      // eski ama gecerli olani kullanmaktan kotudur.
    } catch { /* sessiz */ }
  }

  async #flush(): Promise<void> {
    const pending = this.opts.queue.pending()
    if (pending.length === 0) return

    // Tek seferde en fazla 500 — sema siniri.
    const batch = pending.slice(0, 500)
    const res = await this.#req('/v1/impressions', {
      method: 'POST',
      body: JSON.stringify({ events: batch.map(toEvent) }),
    })
    if (!res) return                       // ag yok — kuyruk yerinde kalir

    try {
      const body = (await res.json()) as {
        accepted?: string[]; rejected?: { id: string }[]; duplicates?: string[]
      }
      // Kabul EDILEN, REDDEDILEN ve YINELENEN — ucu de kuyruktan silinir.
      //
      // Reddedileni tutmak sonsuz yeniden gonderime yol acar: sunucu onu bir
      // daha kabul etmeyecek. Karar sunucuda verildi ve kalicidir.
      const done = [
        ...(body.accepted ?? []),
        ...(body.rejected ?? []).map((r) => r.id),
        ...(body.duplicates ?? []),
      ]
      if (done.length > 0) {
        this.opts.queue.markSent(done)
        this.opts.onLog(
          `kuyruk: ${body.accepted?.length ?? 0} kabul, ` +
          `${body.rejected?.length ?? 0} red, ${body.duplicates?.length ?? 0} yinelenen`,
        )
      }
    } catch { /* bozuk cevap — kuyruk yerinde kalir, sonra tekrar denenir */ }
  }
}

/** Kuyruk kaydini tel uzerindeki sekle cevirir. */
function toEvent(i: CompletedImpression): Record<string, unknown> {
  return {
    id: i.id,
    campaignId: i.campaignId,
    nonce: i.nonce,
    sessionId: i.sessionId,
    surface: i.surface,
    durationMs: i.durationMs,
    clientTs: i.clientTs,
    // §10 — ham `cwd` ASLA gonderilmez. Bu alan yerel tuzla turetilmis HMAC;
    // daemon dolduracak. Su an yer tutucu.
    projectKey: 'f'.repeat(64),
    clientVersion: process.env['DWELL_VERSION'] ?? '0.0.0',
    os: process.platform === 'win32' ? 'win32' : process.platform === 'linux' ? 'linux' : 'darwin',
    arch: process.arch,
  }
}
