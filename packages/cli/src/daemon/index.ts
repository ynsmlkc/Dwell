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
import { ServerSync } from './sync.js'
import { writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
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
  /** Sunucu adresi. Verilmezse daemon offline calisir (gelistirme). */
  readonly serverUrl?: string
  readonly token?: string
  readonly clientVersion?: string
  readonly fetchImpl?: typeof fetch
  readonly authenticated?: boolean
  readonly onImpression?: (imp: CompletedImpression) => void
  readonly onError?: (e: unknown) => void
  readonly onLog?: (m: string) => void
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
  /** Spinner on yuklemesi: sunucu modunda siradaki reklami TUKETIR (spinner
   *  sayilmadigi icin bir reklamin harcanmasi sorun degil), yerelde peek. */
  const spinnerAd = (): AdPayload | null => (sync ? sync.nextAd() : peekAd())
  // Acilista diskteki duraklatma durumunu geri yukle.
  const pausePath = (): string => join(dirname(opts.socketPath ?? SOCKET_PATH), 'paused')
  let paused = existsSync(pausePath())
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

  let currentConfig = config
  const sync = opts.serverUrl
    ? new ServerSync({
        baseUrl: opts.serverUrl,
        token: opts.token ?? '',
        clientVersion: opts.clientVersion ?? VERSION,
        queue,
        config: () => currentConfig,
        setConfig: (c) => { currentConfig = c },
        onLog: (m) => opts.onLog?.(m),
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      })
    : null

  const machine = new TurnMachine({
    clock,
    ids: cryptoIdGenerator(clock),
    config: () => currentConfig,
    isPaused: () => paused,
    isAuthenticated: () => opts.authenticated ?? true,
    // Sunucu bagliysa ondan; degilse yerel listeden (gelistirme).
    // ADR-022: ayni reklam tur icinde ardisik tekrar etmesin diye sirayla dolas.
    nextAd: () => sync
      ? sync.nextAd()
      : (ads.length === 0 ? null : ads[adCursor++ % ads.length]!),
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
      // Sunucu YOKSA kuyruga ALMIYORUZ.
      //
      // Demo modunda gosterilen reklamin karsiligi yok: hicbir reklamveren
      // odemedi, sunucudan nonce gelmedi. Onlari biriktirmek iki zarar
      // veriyordu — kullanici giris yaptiginda binlerce gecersiz kayit
      // sunucuya gidip toptan reddediliyor, ve GERCEK kazanci o yiginin
      // arkasinda siraya giriyor. Bir kullanicida 3.152 kayit birikmisti.
      //
      // Sayilmaya devam ediyorlar (log ve `dwell status` icin), yalnizca
      // diske yazilmiyorlar.
      if (sync) queue.add(imp)
      opts.onImpression?.(imp)
    }
  }

  const handle = (req: Request): Response => {
    switch (req.t) {
      case 'tick': {
        const d = machine.onTick(req.session, clock.now())
        drain()
        // Spinner'a BURADA DOKUNULMAZ — bkz. `hook` dalindaki aciklama.
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

        // Spinner YALNIZCA burada, yalnizca tur bitiminde yazilir.
        //
        // OLCULDU (2026-08-14): Claude Code `spinnerVerbs`'u TUR BASINDA
        // okuyor. Tur icinde yazmak o turu etkilemez — ama dosyayi ekranda
        // gorunenden FARKLI hale getirir ve hata ayiklamayi yaniltir.
        //
        // Kural: dosyadaki deger, o an ekranda ne yaziyorsa o olmali.
        //   tur N-1 bitti  → siradaki reklam yazilir  (Y)
        //   tur N basladi  → Claude Y'yi okur, ekranda Y   → dosya = ekran ✓
        //   tur N suruyor  → DOKUNULMAZ                    → dosya = ekran ✓
        //   tur N bitti    → siradaki yazilir (Z)
        if (req.event === 'Stop') spinner?.sync(spinnerAd()?.creative.brand ?? null)
        return { t: 'ok' }
      }

      case 'pause': {
        // Duraklatma DISKE yazilir.
        //
        // Yalnizca bellekte tutsaydik `dwell restart` ya da makine yeniden
        // baslatma sessizce devam ettirirdi — kullanici durdurdugunu bilir,
        // reklamlar doner. Sessizce yanlis calisan bir anahtar, hic olmayan
        // anahtardan kotudur.
        paused = req.on
        try {
          if (req.on) writeFileSync(pausePath(), String(clock.now()), { mode: 0o600 })
          else if (existsSync(pausePath())) unlinkSync(pausePath())
        } catch (e) {
          opts.onError?.(e)
        }
        opts.onLog?.(req.on ? 'duraklatildi' : 'devam ediliyor')
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
            adsCached: sync ? sync.state().adsCached : ads.length,
            renderEnabled: currentConfig.renderEnabled,
            authenticated: opts.authenticated ?? true,
            paused,
            lastServerContactMs: sync?.state().lastContactMs ?? null,
            lastError: sync?.state().lastError ?? lastError,
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

  sync?.start()

  // Ilk reklami hemen yaz: kurulumdan sonraki ILK tur, `dwell init`'in
  // koydugu yer tutucuyu degil gercek bir reklami gormeli.
  spinner?.sync(spinnerAd()?.creative.brand ?? null)

  return {
    impressions: () => queue.pending(),
    setPaused: (v) => { paused = v },
    stop: async () => {
      // Makinede ASILI KALAN gosterimi once diske al.
      //
      // Gosterim yalnizca tick geldiginde kapanir. Kullanici tur biter bitmez
      // terminali kapatirsa son gosterim makinede kalir ve kaybolur —
      // kazanilmis bir gosterim, hicbir yerde izi olmadan.
      machine.onSessionEnd(machine.activeSession ?? '', clock.now())
      drain()

      // Sonra son bir gonderim denenir; basarisiz olursa kuyruk diskte kalir
      // ve bir sonraki acilista gonderilir.
      if (sync) { await sync.flushNow(); sync.stop() }
      spinner?.clear()
      await server.close()
    },
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
