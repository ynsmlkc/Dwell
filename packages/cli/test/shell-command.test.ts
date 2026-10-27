/**
 * `settings.json`'a yazilan komut satiri.
 *
 * Claude Code komutlari macOS/Linux'ta `sh -c`, Windows'ta Git Bash ile —
 * Git Bash YOKSA PowerShell ile — calistirir. PowerShell'de tirnakla
 * baslayan komut bir string'dir: `"C:/Program Files/nodejs/node.exe" x.mjs`
 * ParserError verir ve hicbir hook, hicbir statusLine calismaz. Gercek bir
 * Windows 10 makinesinde (Git yok) bulundu; `dwell doctor` her seyi yesil
 * gosteriyordu.
 */

import { describe, it, expect } from 'vitest'
import {
  buildNodeCommand, splitCommand, sameShimCommand, findOnPath, type CommandEnv,
} from '../src/command-line.js'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PF_NODE = 'C:\\Program Files\\nodejs\\node.exe'
const HOOK = 'C:\\Users\\90542\\AppData\\Roaming\\npm\\node_modules\\dwellsh\\dist\\hook.mjs'
const SPACED_HOOK = 'C:\\Users\\Ali Veli\\AppData\\Roaming\\npm\\node_modules\\dwellsh\\dist\\hook.mjs'

const win = (over: Partial<CommandEnv> = {}): CommandEnv => ({
  platform: 'win32',
  execPath: PF_NODE,
  nodeOnPath: PF_NODE,
  shortPath: () => null,
  sameFile: (a, b) => a.toLowerCase() === b.toLowerCase(),
  ...over,
})

/** Komutun ilk parcasi tirnakli olamaz — PowerShell'i bozan tek sey bu. */
const firstTokenUnquoted = (cmd: string): boolean => !cmd.trimStart().startsWith('"')

describe('buildNodeCommand — macOS / Linux', () => {
  const posix: CommandEnv = {
    platform: 'darwin', execPath: '/usr/local/bin/node', nodeOnPath: '/usr/local/bin/node',
    shortPath: () => null, sameFile: (a, b) => a === b,
  }

  it('bosluksuz yolda cikti ESKISIYLE birebir ayni', () => {
    expect(buildNodeCommand('/a/dist/hook.mjs', [], posix).command).toBe('/usr/local/bin/node /a/dist/hook.mjs')
  })

  it('bosluklu yollar tirnaklanir (sh -c icin gecerli)', () => {
    const r = buildNodeCommand('/Users/Ali Veli/x.mjs', [], { ...posix, execPath: '/Users/Ali Veli/.nvm/node' })
    expect(r.command).toBe('"/Users/Ali Veli/.nvm/node" "/Users/Ali Veli/x.mjs"')
    expect(r.warning).toBeNull()
  })
})

describe('buildNodeCommand — Windows', () => {
  it('bosluklu node yolu, PATH\'teki node AYNI dosya → `node`', () => {
    const r = buildNodeCommand(HOOK, [], win())
    expect(r.command).toBe('node C:/Users/90542/AppData/Roaming/npm/node_modules/dwellsh/dist/hook.mjs')
    expect(r.warning).toBeNull()
  })

  it('bosluksuz node yolu → tam yol, ileri boluyle', () => {
    const r = buildNodeCommand(HOOK, [], win({ execPath: 'C:\\nodejs\\node.exe', nodeOnPath: null }))
    expect(r.command.startsWith('C:/nodejs/node.exe ')).toBe(true)
  })

  it('PATH\'teki node FARKLI dosya → once 8.3 kisa adi (ayni ikili)', () => {
    const r = buildNodeCommand(HOOK, [], win({
      nodeOnPath: 'C:\\other\\node.exe',
      shortPath: (p) => (p === PF_NODE ? 'C:\\PROGRA~1\\nodejs\\node.exe' : null),
    }))
    expect(r.command.startsWith('C:/PROGRA~1/nodejs/node.exe ')).toBe(true)
    expect(r.warning).toBeNull()
  })

  it('8.3 yoksa PATH\'teki baska node — uyariyla', () => {
    const r = buildNodeCommand(HOOK, [], win({ nodeOnPath: 'C:\\other\\node.exe' }))
    expect(r.command.startsWith('node ')).toBe(true)
    expect(r.warning).toMatch(/node on PATH/)
  })

  it('hicbir care yoksa tirnakli yol ve ACIK uyari', () => {
    const r = buildNodeCommand(HOOK, [], win({ nodeOnPath: null }))
    expect(r.command.startsWith('"C:/Program Files/nodejs/node.exe" ')).toBe(true)
    expect(r.warning).toMatch(/PowerShell/)
  })

  it('bosluklu SCRIPT yolu cift tirnakli arguman olur; program tirnaksiz kalir', () => {
    const r = buildNodeCommand(SPACED_HOOK, ['Stop'], win())
    expect(r.command).toBe('node "C:/Users/Ali Veli/AppData/Roaming/npm/node_modules/dwellsh/dist/hook.mjs" Stop')
    expect(firstTokenUnquoted(r.command)).toBe(true)
    expect(r.warning).toBeNull()
  })

  it('tirnagin kurtaramadigi karakterde ($) 8.3 kisa ada duser', () => {
    const tuhaf = 'C:\\Users\\a$b\\x.mjs'
    const r = buildNodeCommand(tuhaf, [], win({ shortPath: (p) => (p === tuhaf ? 'C:\\Users\\AB~1\\x.mjs' : null) }))
    expect(r.command).toBe('node C:/Users/AB~1/x.mjs')
  })

  it('ters bolu hicbir yerde kalmaz — Git Bash onu kacis sayar', () => {
    for (const env of [win(), win({ nodeOnPath: null }), win({ execPath: 'C:\\n\\node.exe' })]) {
      expect(buildNodeCommand(SPACED_HOOK, [], env).command).not.toContain('\\')
    }
  })
})

describe('splitCommand / sameShimCommand', () => {
  it('cift tirnakli parcalari tek arguman sayar', () => {
    expect(splitCommand('node "C:/a b/x.mjs" Stop')).toEqual(['node', 'C:/a b/x.mjs', 'Stop'])
  })

  /** Elle `node ...` diye duzeltilmis calisan kurulum "eski surum" sayilmamali. */
  it('farkli node yazimi + ayni script ESDEGER', () => {
    expect(sameShimCommand(
      '"C:/Program Files/nodejs/node.exe" C:/Users/u/dist/hook.mjs Stop',
      'node C:\\Users\\U\\dist\\hook.mjs Stop', 'win32',
    )).toBe(true)
  })

  it('farkli script ya da farkli olay ESDEGER DEGIL', () => {
    expect(sameShimCommand('node /a/hook.mjs Stop', 'node /b/hook.mjs Stop', 'darwin')).toBe(false)
    expect(sameShimCommand('node /a/hook.mjs Stop', 'node /a/hook.mjs SessionStart', 'darwin')).toBe(false)
  })

  it('node olmayan program ESDEGER DEGIL (baskasinin araci)', () => {
    expect(sameShimCommand('python /a/hook.mjs', 'node /a/hook.mjs', 'darwin')).toBe(false)
  })
})

describe('findOnPath', () => {
  it('PATH\'teki ilk eslesmeyi bulur', () => {
    const d = mkdtempSync(join(tmpdir(), 'dwell-path-'))
    try {
      writeFileSync(join(d, 'node'), '')
      expect(findOnPath('node', { PATH: `/yok/burada:${d}` }, 'linux')).toBe(join(d, 'node'))
      expect(findOnPath('node', { PATH: '/yok/burada' }, 'linux')).toBeNull()
    } finally { rmSync(d, { recursive: true, force: true }) }
  })
})
