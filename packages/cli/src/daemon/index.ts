/**
 * Daemon govdesi — parcalari birlestirir.
 *
 * Hazir: tur makinesi, unix socket, disk kuyrugu.
 * Eksik: sunucu iletisimi ve reklam prefetch (omurga adim 3) — su an reklam
 * havuzu disaridan veriliyor.
 */

import { renderAdLine, systemClock, cryptoIdGenerator, FALLBACK_CONFIG } from '@dwell/protocol'
import type { AdPayload, RemoteConfig, Clock } from '@dwell/protocol'
import { TurnMachine, type CompletedImpression } from './turns.js'
import { startSocketServer, type SocketServer } from './server.js'
import { ImpressionQueue } from './queue.js'
import { SpinnerSync } from './spinner-sync.js'
import { SOCKET_PATH, DWELL_HOME, type Request, type Response, type HookEvent } from '../ipc.js'

export interface DaemonOptions {
  readonly socketPath?: string
  readonly clock?: Clock
  readonly config?: RemoteConfig
  /** Reklam havuzu. Ilerideki prefetch bunu besleyecek. */
  readonly ads?: readonly AdPayload[]
  /** Kuyrugun yazilacagi dizin. Varsayilan `~/.dwell`. */
  readonly dataDir?: string
  /** Spinner katmanini aktif reklamla senkronla (ADR-001). */
  readonly syncSpinner?: boolean
  /** Test icin: settings.json yolu. */
  readonly settingsPath?: string
  readonly authenticated?: boolean
  readonly onImpression?: (imp: CompletedImpression) => void
  readonly onError?: (e: unknown) => void
}

export interface Daemon {
  readonly stop: () => Promise<void>
  /** Diskte gonderilmeyi bekleyen gosterimler. */
  readonly impressions: () => readonly CompletedImpression[]
  readonly setPaused: (v: boolean) => void
  /**
   * Socket'ten gelen istekle AYNI yolu kullanir.
   *
   * Makine disariya acilmiyor: dogrudan `machine.onTick()` cagirmak `drain()`
   * adimini atlar ve gosterimler makinede sikisip kalir. Tek giris noktasi
   * olmasi bu hatayi imkansiz kiliyor.
   */
  readonly tick: (session: string, columns?: number) => Response
  readonly hook: (event: HookEvent, session: string) => void
  readonly phase: () => string
}

export const VERSION = '0.0.0'

export async function startDaemon(opts: DaemonOptions = {}): Promise<Daemon> {
  const clock = opts.clock ?? systemClock
  const started = clock.now()
  const socketPath = opts.socketPath ?? SOCKET_PATH
  const config = opts.config ?? { ...FALLBACK_CONFIG, renderEnabled: true,
    surfaces: { statusline: true, spinnerVerb: true, spinnerTip: true } }

  const ads = [...(opts.ads ?? [])]
  let adCursor = 0
  /** Siradaki reklami TUKETMEDEN gosterir — spinner on yuklemesi icin. */
  const peekAd = (): AdPayload | null => (ads.length === 0 ? null : ads[adCursor % ads.length]!)
  let paused = false
  let lastError: string | null = null
  const queue = new ImpressionQueue({
    dir: opts.dataDir ?? DWELL_HOME,
    onError: (e) => {
      lastError = e instanceof Error ? e.message : String(e)
      opts.onError?.(e)
    },
  })

  const spinner = opts.syncSpinner
    ? new SpinnerSync({
        ...(opts.settingsPath ? { path: opts.settingsPath } : {}),
        onError: (e) => { lastError = e instanceof Error ? e.message : String(e) },
      })
    : null

  const machine = new TurnMachine({
    clock,
    ids: cryptoIdGenerator(clock),
    config: () => config,
    isPaused: () => paused,
    isAuthenticated: () => opts.authenticated ?? true,
    // ADR-022: ayni reklam tur icinde ardisik tekrar etmesin diye sirayla dolas.
    nextAd: () => (ads.length === 0 ? null : ads[adCursor++ % ads.length]!),
  })

  /**
   * Makineden cikan gosterimleri ANINDA diske yazar.
   *
   * Bellekte biriktirmek yanlis olurdu: daemon carparsa, makine uyursa veya
   * kullanici bilgisayari kapatirsa kazanilmis gosterimler kaybolur ve
   * kullanici bunu asla ogrenemez.
   */
  const drain = (): void => {
    for (const imp of machine.drainImpressions()) {
      queue.add(imp)
      opts.onImpression?.(imp)
    }
  }

  const handle = (req: Request): Response => {
    switch (req.t) {
      case 'tick': {
        const d = machine.onTick(req.session, clock.now())
        drain()
        // Spinner GLOBAL bir ayardir — tek dosya, tum oturumlar.
        //
        // Bu yuzden istegi yapan oturumun sonucuna DEGIL, sayilan gosterime
        // bakilir. Aksi halde bostaki bir oturumun tick'i, calisan oturumun
        // reklamini siler ve spinner varsayilanlara doner.
        spinner?.sync(machine.currentAd?.creative.brand ?? null)
        if (!d.ad) return { t: 'render', line: '', phase: d.phase, reason: d.reason }
        // Kirli kreatif gelirse renderAdLine firlatir → hicbir sey basilmaz
        // (ADR-007 fail-closed). Daemon ayakta kalir.
        try {
          const line = renderAdLine(d.ad.creative, req.columns)
          return { t: 'render', line: line.ansi, phase: d.phase, reason: d.reason }
        } catch (e) {
          lastError = e instanceof Error ? e.message : String(e)
          opts.onError?.(e)
          return { t: 'render', line: '', phase: d.phase, reason: 'kreatif reddedildi' }
        }
      }

      case 'hook': {
        applyHook(machine, req.event, req.session, clock.now())
        drain()

        // OLCULDU (2026-08-14): Claude Code `spinnerVerbs`'u TUR BASINDA
        // okuyor. Tur icinde dosyayi degistirmek o turu etkilemiyor; bir
        // sonraki prompt'ta yeni deger geciyor.
        //
        // Bu yuzden tur BITER BITMEZ siradaki reklam yaziliyor. Aksi halde
        // dosyada hala biten turun reklami durur ve bir sonraki tur onu
        // yakalar — surekli BIR TUR GERIDEN geliriz.
        spinner?.sync(
          req.event === 'Stop'
            ? peekAd()?.creative.brand ?? null
            : machine.currentAd?.creative.brand ?? null,
        )
        return { t: 'ok' }
      }

      case 'health':
        return {
          t: 'health',
          info: {
            version: VERSION,
            pid: process.pid,
            uptimeMs: clock.now() - started,
            phase: machine.phase,
            activeSession: machine.activeSession,
            openTurns: machine.openTurns,
            queuedImpressions: queue.size(),
            adsCached: ads.length,
            renderEnabled: config.renderEnabled,
            authenticated: opts.authenticated ?? true,
            paused,
            lastServerContactMs: null,
            lastError,
          },
        }
    }
  }

  let server: SocketServer
  try {
    server = await startSocketServer(socketPath, handle, (e) => {
      lastError = e instanceof Error ? e.message : String(e)
      opts.onError?.(e)
    })
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e)
    throw e
  }

  return {
    impressions: () => queue.pending(),
    setPaused: (v) => { paused = v },
    stop: async () => { spinner?.clear(); await server.close() },
    phase: () => machine.phase,
    tick: (session, columns = 80) => handle({ t: 'tick', session, columns }),
    hook: (event, session) => { handle({ t: 'hook', event, session }) },
  }
}

/**
 * Hook olaylarini makine olaylarina cevirir.
 *
 * `PreToolUse`/`PostToolUse` bilincli olarak **hicbir sey yapmiyor**: tool
 * calisma suresi bekleme degil (medyan 0.2sn, §12.2) ve sayaca dokunmamali.
 * Yalnizca teshis icin loglanabilirler.
 */
function applyHook(m: TurnMachine, event: HookEvent, session: string, ts: number): void {
  switch (event) {
    case 'UserPromptSubmit': m.onTurnStart(session, ts); break
    case 'Stop': m.onTurnEnd(session, ts); break
    case 'SessionEnd': m.onSessionEnd(session, ts); break
    case 'SessionStart':
    case 'PreToolUse':
    case 'PostToolUse': break
  }
}
