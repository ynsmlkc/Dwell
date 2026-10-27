/**
 * `settings.json`'a yazilan komut satiri ve onun gercekten calisip
 * calismadiginin kaniti.
 *
 * Claude Code statusLine'i ve hook'lari bir KABUK uzerinden calistirir:
 * macOS/Linux'ta `sh -c`, Windows'ta Git Bash — Git Bash YOKSA PowerShell.
 * Yani Windows'ta ayni metin iki farkli dilde gecerli olmak zorunda.
 * (`cmd` Claude Code tarafindan kullanilmiyor ama komut onda da calisiyor;
 * kullanici elle denediginde yaniltmasin.)
 *
 * Uc kabugu birden bozan tek sey: komutun ILK parcasinin tirnakli olmasi.
 * PowerShell'de `"C:/Program Files/nodejs/node.exe" x.mjs` bir komut degil,
 * ardindan beklenmeyen bir belirtec gelen bir STRING'dir (ParserError).
 * `& "..."` PowerShell'i duzeltir ama bash'te `&` arka plan, cmd'de komut
 * ayiricidir. Arguman tirnaklamak ise uc kabukta da sorunsuz.
 *
 * Kural bu yuzden: program parcasi bosluksuz ve tirnaksiz; argumanlar
 * gerekirse cift tirnakli. Ters bolu Git Bash'te kacis karakteri oldugu icin
 * Windows yollari ileri boluyle yazilir (Node ikisini de kabul eder).
 */

import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { join, posix, win32 } from 'node:path'

const hasSpace = (s: string): boolean => /\s/.test(s)
const fwd = (p: string): string => p.replace(/\\/g, '/')
/**
 * Cift tirnak icinde bile bash ve PowerShell'in yorumladigi karakterler
 * (`$`, backtick), cmd'nin `%`'si ve tirnagin kendisi. Bunlari tasiyan bir
 * yol tirnaklanarak kurtarilamaz.
 */
const unsafeInQuotes = (s: string): boolean => /[$`"%]/.test(s)

export interface CommandEnv {
  readonly platform: NodeJS.Platform
  readonly execPath: string
  /** PATH'teki `node`'un mutlak yolu; yoksa `null`. */
  readonly nodeOnPath: string | null
  /** Windows 8.3 kisa adi (`C:\PROGRA~1\...`); alinamazsa `null`. */
  readonly shortPath: (p: string) => string | null
  readonly sameFile: (a: string, b: string) => boolean
}

export interface BuiltCommand {
  readonly command: string
  /** Komut uretildi ama her kabukta calismayabilir — `doctor` gosterir. */
  readonly warning: string | null
}

/**
 * `node <script> [extra...]` komutunu, Claude Code'un kullanabilecegi her
 * kabukta gecerli olacak sekilde kurar.
 */
export function buildNodeCommand(script: string, extra: readonly string[], env: CommandEnv): BuiltCommand {
  if (env.platform !== 'win32') {
    // `sh -c`: tirnakli program da gecerli. Bosluksuz yolda cikti eskisiyle
    // BIREBIR ayni — mevcut kurulumlar "baskasinin" gorunmesin.
    const q = (p: string): string => (hasSpace(p) ? `"${p}"` : p)
    return { command: [env.execPath, script, ...extra].map(q).join(' '), warning: null }
  }

  const prog = windowsProgram(env)
  const args: string[] = []
  let warning = prog.warning
  for (const a of [script, ...extra]) {
    const r = windowsArg(a, env)
    args.push(r.arg)
    warning ??= r.warning
  }
  return { command: [prog.program, ...args].join(' '), warning }
}

/**
 * Program parcasi — tirnaksiz olmak ZORUNDA. Secim sirasi, en az kirilgandan:
 *
 *   1. `process.execPath` zaten bosluksuz → oldugu gibi. Kurulumu yapan
 *      Node'un TAM KENDISI; PATH degisse de ayni kalir.
 *   2. PATH'teki `node` AYNI dosya → `node`. Varsayilan kurulumun
 *      ("C:\Program Files\nodejs") durumu bu.
 *   3. 8.3 kisa adi (`C:/PROGRA~1/nodejs/node.exe`) → yine ayni ikili,
 *      PATH'ten bagimsiz. Birim 8.3 adi uretmiyorsa yok.
 *   4. PATH'te BASKA bir `node` → onu kullan. Shim'ler bagimliliksiz,
 *      kucuk ESM dosyalari; Node 20+ olan her surumle calisir. Uyari
 *      verilir cunku PATH'teki surum degisirse davranis da degisebilir.
 *   5. Hicbiri → tirnakli tam yol. Git Bash'te calisir, PowerShell'de
 *      CALISMAZ; `doctor` bunu kirmizi gosterir.
 */
function windowsProgram(env: CommandEnv): { program: string; warning: string | null } {
  if (!hasSpace(env.execPath)) return { program: fwd(env.execPath), warning: null }
  if (env.nodeOnPath && env.sameFile(env.nodeOnPath, env.execPath)) return { program: 'node', warning: null }
  const short = env.shortPath(env.execPath)
  if (short && !hasSpace(short)) return { program: fwd(short), warning: null }
  if (env.nodeOnPath) {
    return {
      program: 'node',
      warning: `using the node on PATH (${env.nodeOnPath}), not the one that ran \`dwell init\` (${env.execPath})`,
    }
  }
  return {
    program: `"${fwd(env.execPath)}"`,
    warning: 'node is not on PATH and its path has spaces: this works under Git Bash only, '
      + 'not PowerShell. Add Node to PATH and run `dwell doctor --fix`.',
  }
}

/** Argumanlar tirnaklanabilir; yalnizca tirnagin kurtaramadigi karakterlerde kisa ada duseriz. */
function windowsArg(a: string, env: CommandEnv): { arg: string; warning: string | null } {
  const p = fwd(a)
  if (!hasSpace(p) && !unsafeInQuotes(p)) return { arg: p, warning: null }
  if (!unsafeInQuotes(p)) return { arg: `"${p}"`, warning: null }
  const short = env.shortPath(a)
  if (short && !hasSpace(short) && !unsafeInQuotes(short)) return { arg: fwd(short), warning: null }
  return {
    arg: `"${p}"`,
    warning: `the path ${a} contains $, \`, % or " — a shell may rewrite it. `
      + 'Reinstall Dwell under a plainer path.',
  }
}

/* ─────────────────────────── gercek ortam ─────────────────────────── */

/** PATH'te bir programi arar — `which`/`where` karsiligi, kabuk calistirmadan. */
export function findOnPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const path = env['PATH'] ?? env['Path'] ?? ''
  // Hedef platformun ayraci — ana makinenin (`path.delimiter`) degil.
  const sep = platform === 'win32' ? ';' : ':'
  const exts = platform === 'win32'
    ? (env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : ['']
  for (const dir of path.split(sep).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = (platform === 'win32' ? win32.join : posix.join)(dir.replace(/^"|"$/g, ''), name + ext)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/** Windows 8.3 kisa adi. `cmd`'nin `%~sI`'si; 8.3 kapaliysa uzun adi doner → `null`. */
export function windowsShortPath(p: string): string | null {
  if (process.platform !== 'win32' || !existsSync(p)) return null
  const r = spawnSync('cmd.exe', ['/d', '/s', '/c', `"for %I in ("${p}") do @echo %~sI"`], {
    encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true, timeout: 5_000,
  })
  const out = r.status === 0 ? (r.stdout ?? '').trim() : ''
  return out && !hasSpace(out) ? out : null
}

/** Iki yol ayni dosya mi — 8.3 adlarini ve buyuk/kucuk harfi cozerek. */
export function sameFile(a: string, b: string): boolean {
  const norm = (p: string): string => {
    let r = p
    try { r = realpathSync.native(p) } catch { /* yoksa oldugu gibi */ }
    return process.platform === 'win32' ? r.toLowerCase() : r
  }
  return norm(a) === norm(b)
}

export function currentCommandEnv(): CommandEnv {
  return {
    platform: process.platform,
    execPath: process.execPath,
    nodeOnPath: findOnPath('node'),
    shortPath: windowsShortPath,
    sameFile,
  }
}

/* ─────────────────────────── esdegerlik ─────────────────────────── */

/** Cift tirnaklari anlayan basit bolucu — bizim urettigimiz bicim icin yeterli. */
export function splitCommand(cmd: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(cmd)) !== null) out.push(m[1] ?? m[2]!)
  return out
}

/**
 * Iki komut ayni shim'i ayni argumanlarla mi calistiriyor?
 *
 * `diagnose()` birebir metin karsilastirmasi yapiyordu: kullanici bozuk
 * komutu elle `node C:/.../statusline.mjs` diye duzeltince — calisan bir
 * kurulum — "eski surum kalintisi" deniyordu. Program `node` ise hangi
 * node oldugu onemli degil; script yolu ise 8.3 adi, bolu yonu ve harf
 * buyuklugu cozulerek karsilastirilir.
 */
export function sameShimCommand(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  if (a === b) return true
  const ta = splitCommand(a)
  const tb = splitCommand(b)
  if (ta.length !== tb.length || ta.length < 2) return false
  const isNode = (p: string): boolean => /(^|[\\/])node(\.exe)?$/i.test(p)
  if (!isNode(ta[0]!) || !isNode(tb[0]!)) return false
  const norm = (p: string): string => {
    let r = p
    try { r = realpathSync.native(p) } catch { /* yoksa oldugu gibi */ }
    r = fwd(r)
    return platform === 'win32' ? r.toLowerCase() : r
  }
  return ta.slice(1).every((x, i) => norm(x) === norm(tb[i + 1]!))
}

/* ─────────────────────────── gercekten calistir ─────────────────────────── */

export interface ShellProbe {
  readonly shell: string
  /** Claude Code bu makinede komutlari bu kabukla mi calistiriyor? */
  readonly usedByClaude: boolean
  readonly ok: boolean
  readonly detail: string
}

/** Claude Code'un Windows'ta kullanacagi Git Bash — yoksa `null`. */
export function findGitBash(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env['CLAUDE_CODE_GIT_BASH_PATH']
  if (explicit && existsSync(explicit)) return explicit
  for (const base of [env['ProgramFiles'], env['ProgramW6432'], env['LOCALAPPDATA'] && join(env['LOCALAPPDATA'], 'Programs')]) {
    if (!base) continue
    const p = join(base, 'Git', 'bin', 'bash.exe')
    if (existsSync(p)) return p
  }
  const git = findOnPath('git', env, 'win32')
  if (git) {
    // .../Git/cmd/git.exe → .../Git/bin/bash.exe
    const p = join(git, '..', '..', 'bin', 'bash.exe')
    if (existsSync(p)) return p
  }
  return null
}

/**
 * Komutu, Claude Code'un kullanabilecegi her kabukta GERCEKTEN calistirir.
 * Yesil "kuruldu" yetmiyor: komut PowerShell'de ParserError verirken
 * daemon, soket ve reklam onbellegi kusursuz gorunuyordu.
 */
export function probeCommand(command: string, stdin: string): ShellProbe[] {
  const run = (shell: string, file: string, args: string[], usedByClaude: boolean, verbatim = false): ShellProbe => {
    const r = spawnSync(file, args, {
      input: stdin, encoding: 'utf8', timeout: 15_000, windowsHide: true,
      windowsVerbatimArguments: verbatim,
    })
    if (r.error) return { shell, usedByClaude, ok: false, detail: r.error.message }
    const err = (r.stderr ?? '').trim()
    const ok = r.status === 0 && err === ''
    return {
      shell, usedByClaude, ok,
      detail: ok ? 'runs' : `exit ${r.status ?? r.signal}${err ? ` — ${err.split('\n')[0]!.slice(0, 160)}` : ''}`,
    }
  }

  if (process.platform !== 'win32') return [run('sh', '/bin/sh', ['-c', command], true)]

  const probes: ShellProbe[] = []
  const bash = findGitBash()
  if (bash) probes.push(run('Git Bash', bash, ['-c', command], true))
  // Git Bash yoksa Claude Code PowerShell kullanir. Ikisini de dene:
  // Windows PowerShell 5.1 her makinede var, pwsh (7) varsa o da.
  probes.push(run('PowerShell', 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], !bash))
  if (findOnPath('pwsh')) {
    probes.push(run('pwsh', 'pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], false))
  }
  probes.push(run('cmd', 'cmd.exe', ['/d', '/s', '/c', `"${command}"`], false, true))
  return probes
}
