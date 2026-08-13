/**
 * Shim ile daemon arasindaki yerel protokol.
 *
 * Newline ile ayrilmis JSON, unix domain socket uzerinden. Tek istek/tek cevap.
 * Basit tutuluyor cunku bu yol gunde ~13.700 kez kat ediliyor ve toplam
 * butcesi 50 milisaniye (ADR-003).
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

export const DWELL_HOME = process.env['DWELL_HOME'] ?? join(homedir(), '.dwell')
export const SOCKET_PATH = join(DWELL_HOME, 'dwelld.sock')

/** Shim'in toplam butcesi. Asarsa bos doner — gec bir reklam, reklamdan kotudur. */
export const SHIM_BUDGET_MS = 50

/* ─────────────────────────── istekler ─────────────────────────── */

export type Request =
  /** statusLine tikladi: hem render karari iste hem zamani ilerlet. */
  | { readonly t: 'tick'; readonly session: string; readonly columns: number }
  /** Hook olayi bildir. */
  | { readonly t: 'hook'; readonly event: HookEvent; readonly session: string; readonly promptId?: string }
  /** Saglik ve teshis — `dwell doctor` / `dwell status`. */
  | { readonly t: 'health' }

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

export const encode = (v: Request | Response): string => JSON.stringify(v) + '\n'

/** Bozuk satiri atmak, patlamaktan iyidir — bu yol her saniye kat ediliyor. */
export function decode<T>(line: string): T | null {
  try { return JSON.parse(line) as T } catch { return null }
}
