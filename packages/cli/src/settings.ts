/**
 * Claude Code `settings.json` yonetimi — §6.1.
 *
 * Bu dosya kullanicinin kendi konfigurasyonu. Sessizce ezmek affedilmez;
 * `dwell uninstall` her seyi ILK HALINE dondurebilmek zorunda.
 *
 * Tasarim kurallari:
 *   • Yalnizca KENDI alanlarimiza dokunuruz, dosyanin geri kalanina asla
 *   • Mevcut bir `statusLine` varsa UZERINE YAZMAYIZ — uyarir, sorariz
 *   • Kaldirma yedekten degil, kendi izimizi silerek yapilir: aradan gecen
 *     surede kullanici baska ayarlar degistirmis olabilir
 *   • Her yazmadan once zaman damgali yedek alinir
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

export const CLAUDE_DIR = process.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude')
export const SETTINGS_PATH = join(CLAUDE_DIR, 'settings.json')

/** Bizim yazdigimiz her seye bu iz konur — kaldirirken bunu arariz. */
export const MARKER = '__dwell'

export interface StatusLineSetting {
  type: 'command'
  command: string
  refreshInterval?: number
  [MARKER]?: true
}

export interface HookEntry {
  matcher?: string
  hooks: { type: 'command'; command: string }[]
  [MARKER]?: true
}

export interface ClaudeSettings {
  statusLine?: StatusLineSetting
  spinnerVerbs?: { mode: 'append' | 'replace'; verbs: string[]; [MARKER]?: true }
  hooks?: Record<string, HookEntry[]>
  [k: string]: unknown
}

export interface Conflict {
  readonly field: string
  readonly current: string
  /** Bizim yazdigimiz bir sey mi, baskasinin mi? */
  readonly ours: boolean
}

export function readSettings(path = SETTINGS_PATH): ClaudeSettings {
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ClaudeSettings
  } catch (e) {
    // Bozuk bir settings.json'u ezmek felakettir — kullanici tum ayarlarini
    // kaybeder. Okuyamiyorsak DOKUNMUYORUZ.
    throw new Error(`settings.json okunamadi (bozuk JSON olabilir): ${path}`)
  }
}

/** Cakisma var mi? `dwell init` bunu ONCE sorar. */
export function detectConflicts(s: ClaudeSettings): Conflict[] {
  const out: Conflict[] = []
  if (s.statusLine) {
    out.push({
      field: 'statusLine',
      current: s.statusLine.command,
      ours: s.statusLine[MARKER] === true,
    })
  }
  if (s.spinnerVerbs) {
    out.push({
      field: 'spinnerVerbs',
      current: `${s.spinnerVerbs.mode}: ${s.spinnerVerbs.verbs.join(', ').slice(0, 40)}`,
      ours: s.spinnerVerbs[MARKER] === true,
    })
  }
  return out
}

/** Yedek adlandirmasi icin. Testte sabit, uretimde gercek saat. */
export type NowFn = () => number

export interface InstallOptions {
  readonly statusLineCommand: string
  readonly hookCommand: string
  readonly refreshIntervalSec: number
  /** Spinner katmani opsiyonel — ADR-001'de "kaybedilebilir eklenti". */
  readonly spinnerVerbs?: readonly string[]
  /** Cakisma varsa bile uzerine yaz. Kullanici acikca onaylamis olmali. */
  readonly force?: boolean
  readonly now?: NowFn
}

export interface InstallResult {
  readonly changed: readonly string[]
  readonly skipped: readonly Conflict[]
  readonly backupPath: string | null
}

/** Tur takibi icin gereken hook'lar. `PreToolUse`/`PostToolUse` YOK. */
export const TURN_HOOKS = ['UserPromptSubmit', 'Stop', 'SessionStart'] as const

export function install(opts: InstallOptions, path = SETTINGS_PATH): InstallResult {
  const now = opts.now ?? Date.now
  const settings = readSettings(path)
  const conflicts = detectConflicts(settings).filter((c) => !c.ours)
  const changed: string[] = []
  const skipped: Conflict[] = []

  const backupPath = existsSync(path) ? backup(path, now) : null

  // statusLine
  const slConflict = conflicts.find((c) => c.field === 'statusLine')
  if (slConflict && !opts.force) {
    skipped.push(slConflict)
  } else {
    settings.statusLine = {
      type: 'command',
      command: opts.statusLineCommand,
      refreshInterval: opts.refreshIntervalSec,
      [MARKER]: true,
    }
    changed.push('statusLine')
  }

  // spinnerVerbs — opsiyonel katman
  if (opts.spinnerVerbs && opts.spinnerVerbs.length > 0) {
    const svConflict = conflicts.find((c) => c.field === 'spinnerVerbs')
    if (svConflict && !opts.force) {
      skipped.push(svConflict)
    } else {
      settings.spinnerVerbs = { mode: 'replace', verbs: [...opts.spinnerVerbs], [MARKER]: true }
      changed.push('spinnerVerbs')
    }
  }

  // hook'lar — kullanicininkileri KORUYARAK, bizimkileri TAZELEYEREK.
  //
  // "Zaten var, atla" YETMEZ: surum yukseltmesinde ikili yolu degisir ve
  // eski komut oldugu yerde kalir. Kullanici `dwell init` calistirir,
  // "kuruldu" gorur, ama hook'lar olu bir dosyayi cagirmaya devam eder.
  settings.hooks ??= {}
  for (const event of TURN_HOOKS) {
    const list: HookEntry[] = (settings.hooks[event] ??= [])
    const wanted = `${opts.hookCommand} ${event}`
    const mine = list.findIndex((h) => h[MARKER] === true)
    const entry: HookEntry = { matcher: '', hooks: [{ type: 'command', command: wanted }], [MARKER]: true }

    if (mine === -1) {
      list.push(entry)
      changed.push(`hooks.${event}`)
    } else if (list[mine]!.hooks[0]?.command !== wanted) {
      list[mine] = entry
      changed.push(`hooks.${event} (guncellendi)`)
    }
  }

  writeSettings(settings, path)
  return { changed, skipped, backupPath }
}

/**
 * Kaldirma — YEDEKTEN DEGIL, kendi izimizi silerek.
 *
 * Yedege donmek yanlis olurdu: kurulumdan sonra kullanici baska ayarlar
 * degistirmis olabilir ve onlari geri almak, bizim eklediklerimizi
 * birakmaktan daha kotu.
 */
export function uninstall(path = SETTINGS_PATH, now: NowFn = Date.now): { removed: string[]; backupPath: string | null } {
  if (!existsSync(path)) return { removed: [], backupPath: null }

  const settings = readSettings(path)
  const backupPath = backup(path, now)
  const removed: string[] = []

  if (settings.statusLine?.[MARKER]) { delete settings.statusLine; removed.push('statusLine') }
  if (settings.spinnerVerbs?.[MARKER]) { delete settings.spinnerVerbs; removed.push('spinnerVerbs') }

  for (const [event, list] of Object.entries(settings.hooks ?? {})) {
    const kept = list.filter((h) => h[MARKER] !== true)
    if (kept.length === list.length) continue
    removed.push(`hooks.${event}`)
    if (kept.length === 0) delete settings.hooks![event]
    else settings.hooks![event] = kept
  }
  if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks

  writeSettings(settings, path)
  return { removed, backupPath }
}

/**
 * Kurulum saglam mi? `dwell doctor` bunu sorar.
 *
 * Ozellikle aradigi sey: ayarlarimizin BASKA BIR ARAC tarafindan
 * degistirilmis olmasi. Ayni yuzey icin yarisan baska bir eklenti,
 * periyodik olarak kendi ayarini geri koyabiliyor — kullanici "Dwell
 * calismiyor" der ve sebebini bilemez.
 */
export function diagnose(expectedCommand: string, path = SETTINGS_PATH): {
  installed: boolean
  hijacked: boolean
  detail: string
} {
  if (!existsSync(path)) return { installed: false, hijacked: false, detail: 'settings.json yok' }

  let settings: ClaudeSettings
  try { settings = readSettings(path) } catch (e) {
    return { installed: false, hijacked: false, detail: String(e instanceof Error ? e.message : e) }
  }

  const sl = settings.statusLine
  if (!sl) return { installed: false, hijacked: false, detail: 'statusLine tanimli degil' }

  if (sl[MARKER] && sl.command === expectedCommand) {
    return { installed: true, hijacked: false, detail: 'kurulum saglam' }
  }
  if (sl[MARKER] && sl.command !== expectedCommand) {
    return { installed: false, hijacked: false, detail: 'eski surumden kalma kurulum — `dwell init` tekrar calistir' }
  }
  return {
    installed: false,
    hijacked: true,
    detail: `statusLine baska bir araca ait: ${sl.command.slice(0, 60)}`,
  }
}

/* ── ic isler ── */

function writeSettings(s: ClaudeSettings, path: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 })
}

function backup(path: string, now: NowFn): string {
  const dir = join(dirname(path), 'dwell-backups')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-')
  let target = join(dir, `settings.${stamp}.json`)
  let n = 1
  while (existsSync(target)) target = join(dir, `settings.${stamp}.${n++}.json`)
  copyFileSync(path, target)
  prune(dir)
  return target
}

/** Yedekler sonsuza kadar birikmesin — son 10 tanesi yeter. */
function prune(dir: string, keep = 10): void {
  const files = readdirSync(dir).filter((f) => f.startsWith('settings.')).sort()
  for (const f of files.slice(0, Math.max(0, files.length - keep))) {
    try { unlinkSync(join(dir, f)) } catch { /* onemsiz */ }
  }
}
