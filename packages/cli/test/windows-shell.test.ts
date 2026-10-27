/**
 * Windows'a ozel: uretilen komutu GERCEK kabuklarda calistirir.
 *
 * Claude Code Windows'ta komutlari Git Bash ile, Git Bash yoksa PowerShell
 * ile calistiriyor. Eski komut (`"C:/Program Files/nodejs/node.exe" ...`)
 * PowerShell'de ParserError veriyordu; hicbir hook ve statusLine calismiyor,
 * `dwell doctor` ise yesil gosteriyordu.
 *
 * Her senaryoda komut `buildNodeCommand` ile uretilir ve bash, Windows
 * PowerShell 5.1, pwsh ve cmd'de calistirilir. Calistirilan script
 * argumanlarini ve stdin'i bir dosyaya yazar — "cikis kodu 0" yetmez, komutun
 * dogru argumanlarla GERCEKTEN calistigi kanitlanir.
 *
 * Yalnizca Windows'ta kosar (CI'da `windows-latest`).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, copyFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import {
  buildNodeCommand, findOnPath, findGitBash, sameFile, windowsShortPath, probeCommand, type CommandEnv,
} from '../src/command-line.js'

const onWindows = process.platform === 'win32'

let root = ''
let spacedNodeDir = ''
let spacedNode = ''
let plainScript = ''
let spacedScript = ''
let outFile = ''

beforeAll(() => {
  if (!onWindows) return
  root = mkdtempSync(join(tmpdir(), 'dwell-shell-'))
  // node.exe tek basina calisan bir ikili; kopyasi bosluklu bir yolda durur.
  spacedNodeDir = join(root, 'Program Files', 'nodejs')
  mkdirSync(spacedNodeDir, { recursive: true })
  spacedNode = join(spacedNodeDir, 'node.exe')
  copyFileSync(process.execPath, spacedNode)

  outFile = join(root, 'out.json')
  const probe = `import { writeFileSync } from 'node:fs'
let input = ''
for await (const c of process.stdin) input += c
writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({ args: process.argv.slice(2), input }))
`
  plainScript = join(root, 'dist', 'probe.mjs')
  spacedScript = join(root, 'Ali Veli', 'dist', 'probe.mjs')
  for (const p of [plainScript, spacedScript]) {
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, probe)
  }
})

afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }) })

interface Shell { name: string; run: (cmd: string, env: NodeJS.ProcessEnv) => ReturnType<typeof spawnSync> }

function shells(): Shell[] {
  const opts = (env: NodeJS.ProcessEnv) => ({ input: '{"session_id":"t"}', encoding: 'utf8' as const, env, timeout: 30_000 })
  const list: Shell[] = [
    { name: 'powershell', run: (c, e) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', c], opts(e)) },
    { name: 'cmd', run: (c, e) => spawnSync('cmd.exe', ['/d', '/s', '/c', `"${c}"`], { ...opts(e), windowsVerbatimArguments: true }) },
  ]
  if (findOnPath('pwsh')) {
    list.push({ name: 'pwsh', run: (c, e) => spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', c], opts(e)) })
  }
  const bash = findGitBash()
  if (bash) list.push({ name: 'git-bash', run: (c, e) => spawnSync(bash, ['-c', c], opts(e)) })
  return list
}

/** Senaryo: hangi node "kurulumu yapti", PATH'te ne var. */
function scenario(execPath: string, pathPrefix: string | null): { env: CommandEnv; procEnv: NodeJS.ProcessEnv } {
  const PATH = pathPrefix ? `${pathPrefix};${process.env['PATH']}` : process.env['PATH']
  const procEnv = { ...process.env, PATH }
  return {
    procEnv,
    env: {
      platform: 'win32', execPath,
      nodeOnPath: findOnPath('node', procEnv, 'win32'),
      shortPath: windowsShortPath, sameFile,
    },
  }
}

function runEverywhere(command: string, procEnv: NodeJS.ProcessEnv, expectArgs: string[]): void {
  for (const sh of shells()) {
    if (existsSync(outFile)) rmSync(outFile)
    const r = sh.run(command, procEnv)
    const ctx = `${sh.name}: ${command}\nexit ${r.status}\nstderr: ${String(r.stderr ?? '')}`
    expect(r.status, ctx).toBe(0)
    expect(existsSync(outFile), ctx).toBe(true)
    const got = JSON.parse(readFileSync(outFile, 'utf8')) as { args: string[]; input: string }
    expect(got.args, ctx).toEqual(expectArgs)
  }
}

describe.skipIf(!onWindows)('Windows: uretilen komut her kabukta calisir', () => {
  it('bosluklu node, PATH\'te AYNI node → `node`', () => {
    const { env, procEnv } = scenario(spacedNode, spacedNodeDir)
    const r = buildNodeCommand(plainScript, ['Stop'], env)
    expect(r.command.startsWith('node ')).toBe(true)
    expect(r.warning).toBeNull()
    runEverywhere(r.command, procEnv, ['Stop'])
  })

  it('bosluklu node, PATH\'te YOK → kisa ad ya da baska node; uyarisizsa her kabukta calisir', () => {
    const { env, procEnv } = scenario(spacedNode, null)
    const r = buildNodeCommand(plainScript, ['UserPromptSubmit'], env)
    expect(r.command.trimStart().startsWith('"')).toBe(false)
    runEverywhere(r.command, procEnv, ['UserPromptSubmit'])
  })

  it('bosluklu SCRIPT yolu (C:\\...\\Ali Veli\\...) her kabukta calisir', () => {
    const { env, procEnv } = scenario(spacedNode, spacedNodeDir)
    const r = buildNodeCommand(spacedScript, ['SessionStart'], env)
    expect(r.warning).toBeNull()
    runEverywhere(r.command, procEnv, ['SessionStart'])
  })

  it('bosluklu node VE bosluklu script', () => {
    const { env, procEnv } = scenario(spacedNode, spacedNodeDir)
    const r = buildNodeCommand(spacedScript, [], env)
    runEverywhere(r.command, procEnv, [])
  })

  /** Regresyon: eski bicim PowerShell'de GERCEKTEN bozuk — test bunu gormeli. */
  it('ESKI tirnakli bicim PowerShell\'de basarisiz; doctor\'un denemesi bunu yakalar', () => {
    const eski = `"${spacedNode.replace(/\\/g, '/')}" ${plainScript.replace(/\\/g, '/')}`
    const ps = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', eski], { encoding: 'utf8' })
    expect(ps.status).not.toBe(0)

    const p = probeCommand(eski, '{}').find((x) => x.shell === 'PowerShell')!
    expect(p.ok).toBe(false)
  })
})
