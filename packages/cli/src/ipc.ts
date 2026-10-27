/**
 * Shim ile daemon arasindaki yerel protokol.
 *
 * Newline ile ayrilmis JSON, unix domain socket uzerinden. Tek istek/tek cevap.
 * Basit tutuluyor cunku bu yol gunde ~13.700 kez kat ediliyor ve toplam
 * butcesi 50 milisaniye (ADR-003).
 */

import { homedir, tmpdir } from 'node:os'
import type { TermShape } from './shim/term-shape.js'
import { join, win32 } from 'node:path'

/**
 * Ev dizini `homedir()`'den, `HOME`'dan DEGIL.
 *
 * Windows'ta (PowerShell, cmd) `HOME` tanimli degil. `${HOME}/.dwell`
 * "undefined/.dwell", `join(HOME ?? '', ...)` ise calisma dizinine gore
 * GORELI bir yol veriyordu — shim ile daemon farkli dizinlere bakiyordu.
 */
export const dwellHome = (env: NodeJS.ProcessEnv = process.env): string =>
  env['DWELL_HOME'] ?? join(homedir(), '.dwell')

export const DWELL_HOME = dwellHome()

/**
 * Unix soket yolunun uzunluk siniri (`sun_path`, NUL haric).
 *
 * Linux 108, macOS/BSD 104 BYTE. Karakter degil byte: Turkce bir kullanici
 * adi ("Müşteri") ayni harf sayisinda daha fazla yer kaplar.
 */
const SUN_PATH_MAX = process.platform === 'linux' ? 107 : 103

/**
 * Daemon soketinin yolu.
 *
 * Sinir asilirsa `listen` HATA VERMEZ — yolu sessizce keser. Dosya beklenen
 * yerde olusmaz, ardindan `chmod` anlasilmaz bir `ENOENT` ile patlar ve
 * kullanici ham bir Node stack trace'i gorur. Gercek makinelerde oluyor:
 * derin kurumsal ev dizinleri, uzun Windows profil adlari, CI calisma
 * dizinleri.
 *
 * Bu yuzden sinir asilirsa tmpdir altinda KISA ve DETERMINISTIK bir yola
 * duseriz. Deterministik olmasi sart: shim ile daemon ayri sureclerdir ve
 * ayni yolu bagimsiz olarak hesaplamak zorundalar.
 */
export function socketPathFor(dwellHome: string, platform: NodeJS.Platform = process.platform): string {
  // Windows'ta Node unix soket DOSYASI dinleyemez (`listen EACCES`); yerel
  // IPC named pipe ile olur. Pipe adlari makine geneli oldugu icin ev
  // dizininden turetilir. Windows yollari buyuk/kucuk harf ve ayirac
  // duyarsiz: Git Bash'ten gelen "C:/Users/a/.dwell" ile PowerShell'den
  // gelen "c:\Users\a\.dwell" AYNI pipe'a cikmali.
  if (platform === 'win32') {
    return `\\\\.\\pipe\\dwell-${shortHash(win32.resolve(dwellHome).toLowerCase())}`
  }

  const normal = join(dwellHome, 'dwelld.sock')
  if (Buffer.byteLength(normal) <= SUN_PATH_MAX) return normal

  const kisa = join(tmpdir(), `dwell-${shortHash(dwellHome)}.sock`)
  if (Buffer.byteLength(kisa) > SUN_PATH_MAX) {
    // tmpdir bile sigmiyorsa yapabilecegimiz bir sey yok. Sessizce yanlis
    // calismaktansa ne oldugunu soyleyerek durmak dogru.
    throw new Error(
      `soket yolu cok uzun (${Buffer.byteLength(kisa)} > ${SUN_PATH_MAX} byte): ${kisa}\n` +
      'DWELL_SOCKET ile daha kisa bir yol ver',
    )
  }
  return kisa
}

/**
 * FNV-1a. Kriptografik DEGIL ve olmasi gerekmiyor: tek isi ev dizini basina
 * benzersiz bir dosya adi uretmek.
 *
 * `node:crypto` yerine bu: shim gunde ~13.700 kez calisiyor ve butcesi dar;
 * yalnizca isim uretmek icin modul yuklemeye degmez.
 */
function shortHash(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36).padStart(7, '0')
}

export const SOCKET_PATH = socketPathFor(DWELL_HOME)

/** Windows named pipe mi? Pipe'larin dosyasi, dizini ve izin bitleri yok. */
export const isNamedPipe = (p: string): boolean => /^\\\\[.?]\\pipe\\/i.test(p)

/** Shim'in toplam butcesi. Asarsa bos doner — gec bir reklam, reklamdan kotudur. */
export const SHIM_BUDGET_MS = 50

/* ─────────────────────────── istekler ─────────────────────────── */

export type Request =
  /**
   * statusLine tikladi: hem render karari iste hem zamani ilerlet.
   *
   * `shape` SHIM'DEN gelir cunku terminal kimligi yalnizca orada var —
   * shim terminalin icinde calisir, daemon calismaz.
   */
  | { readonly t: 'tick'; readonly session: string; readonly columns: number
      readonly shape?: TermShape }
  /** Hook olayi bildir. */
  | { readonly t: 'hook'; readonly event: HookEvent; readonly session: string; readonly promptId?: string }
  /** Saglik ve teshis — `dwell doctor` / `dwell status`. */
  | { readonly t: 'health' }
  /** Reklami gecici durdur/devam ettir — `dwell pause` / `dwell resume`. */
  | { readonly t: 'pause'; readonly on: boolean }

export type HookEvent =
  | 'UserPromptSubmit'   // tur acar
  | 'Stop'               // tur kapatir
  | 'SessionStart'
  | 'SessionEnd'
  | 'PreToolUse'         // yalnizca teshis — sayaca dokunmaz
  | 'PostToolUse'

/* ─────────────────────────── cevaplar ─────────────────────────── */

export type Response =
  /** `line` bos string ise HICBIR SEY basilmaz. */
  | { readonly t: 'render'; readonly line: string; readonly phase: string; readonly reason: string | null }
  | { readonly t: 'ok' }
  | { readonly t: 'health'; readonly info: HealthInfo }
  | { readonly t: 'error'; readonly code: string }

export interface HealthInfo {
  readonly version: string
  /** Daemon'in KENDI bildirdigi pid. Pidfile'a guvenilmez (pid geri donusumlu). */
  readonly pid: number
  readonly uptimeMs: number
  readonly phase: string
  readonly activeSession: string | null
  readonly openTurns: number
  readonly queuedImpressions: number
  readonly adsCached: number
  readonly renderEnabled: boolean
  readonly authenticated: boolean
  readonly paused: boolean
  readonly lastServerContactMs: number | null
  readonly lastError: string | null
}

export type { TermShape }

export const encode = (v: Request | Response): string => JSON.stringify(v) + '\n'

/** Bozuk satiri atmak, patlamaktan iyidir — bu yol her saniye kat ediliyor. */
export function decode<T>(line: string): T | null {
  try { return JSON.parse(line) as T } catch { return null }
}
