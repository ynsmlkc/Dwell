/**
 * settings.json yonetimi testleri.
 *
 * Buradaki her test bir soruya cevap veriyor: "kullanicinin ayarlarina
 * zarar verdik mi?"
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  install, uninstall, readSettings, detectConflicts, diagnose,
  MARKER, TURN_HOOKS, type ClaudeSettings,
} from '../src/settings.js'

let dir = ''
let path = ''
let t = 1_700_000_000_000
const now = () => (t += 1000)

const OPTS = {
  statusLineCommand: '/usr/local/bin/dwell-statusline',
  hookCommand: '/usr/local/bin/dwell-hook',
  refreshIntervalSec: 1,
  now,
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dwell-set-'))
  path = join(dir, 'settings.json')
  t = 1_700_000_000_000
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const write = (s: ClaudeSettings) => writeFileSync(path, JSON.stringify(s, null, 2))
const read = (): ClaudeSettings => JSON.parse(readFileSync(path, 'utf8'))

describe('kurulum', () => {
  it('bos makineye kurar', () => {
    const r = install(OPTS, path)
    expect(r.changed).toContain('statusLine')
    expect(read().statusLine?.command).toBe(OPTS.statusLineCommand)
    expect(read().statusLine?.refreshInterval).toBe(1)
  })

  it('yalnizca TUR hook\'larini ekler — PreToolUse/PostToolUse YOK', () => {
    // Tool calisma suresi bekleme degil (§12.2); sayaca dokunmayan hook'lari
    // kurmak kullanicinin her tool cagrisini bosuna yavaslatirdi.
    install(OPTS, path)
    expect(Object.keys(read().hooks ?? {}).sort()).toEqual([...TURN_HOOKS].sort())
    expect(read().hooks).not.toHaveProperty('PreToolUse')
  })

  it('KULLANICININ diger ayarlarina dokunmaz', () => {
    write({ theme: 'dark', model: 'opus', permissions: { allow: ['Bash'] } })
    install(OPTS, path)
    const s = read()
    expect(s.theme).toBe('dark')
    expect(s.model).toBe('opus')
    expect(s.permissions).toEqual({ allow: ['Bash'] })
  })

  it('MEVCUT hook\'lari korur', () => {
    write({ hooks: { UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: '/benim/script.sh' }] }] } })
    install(OPTS, path)
    const list = read().hooks!['UserPromptSubmit']!
    expect(list).toHaveLength(2)
    expect(JSON.stringify(list)).toContain('/benim/script.sh')
  })

  it('iki kez kurmak yinelenen hook uretmez', () => {
    install(OPTS, path)
    install(OPTS, path)
    expect(read().hooks!['Stop']).toHaveLength(1)
  })

  it('her yazmadan once yedek alir', () => {
    write({ theme: 'dark' })
    const r = install(OPTS, path)
    expect(r.backupPath).toBeTruthy()
    expect(JSON.parse(readFileSync(r.backupPath!, 'utf8')).theme).toBe('dark')
  })
})

describe('cakisma — baskasinin statusLine\'i', () => {
  const RAKIP = { type: 'command' as const, command: '/baska/arac/statusline.sh' }

  it('UZERINE YAZMAZ, atlar ve bildirir', () => {
    write({ statusLine: RAKIP })
    const r = install(OPTS, path)

    expect(r.changed).not.toContain('statusLine')
    expect(r.skipped.map((s) => s.field)).toContain('statusLine')
    expect(read().statusLine?.command, 'dokunulmamis olmali').toBe(RAKIP.command)
  })

  it('cakismaya ragmen hook\'lar kurulur — kismi kurulum mumkun', () => {
    write({ statusLine: RAKIP })
    const r = install(OPTS, path)
    expect(r.changed.some((c) => c.startsWith('hooks.'))).toBe(true)
  })

  it('force ile uzerine yazar — kullanici acikca onaylamis olmali', () => {
    write({ statusLine: RAKIP })
    install({ ...OPTS, force: true }, path)
    expect(read().statusLine?.command).toBe(OPTS.statusLineCommand)
  })

  it('KENDI ayarimiz cakisma sayilmaz', () => {
    install(OPTS, path)
    const r = install(OPTS, path)
    expect(r.skipped).toHaveLength(0)
  })

  it('spinnerVerbs cakismasi ayri degerlendirilir', () => {
    write({ spinnerVerbs: { mode: 'replace', verbs: ['✶ Rakip'] } })
    const r = install({ ...OPTS, spinnerVerbs: ['✶ Firecrawl'] }, path)
    expect(r.skipped.map((s) => s.field)).toContain('spinnerVerbs')
    expect(read().spinnerVerbs?.verbs).toEqual(['✶ Rakip'])
  })
})

describe('kaldirma', () => {
  it('kendi izini siler', () => {
    install({ ...OPTS, spinnerVerbs: ['✶ Firecrawl'] }, path)
    const r = uninstall(path, now)

    expect(read().statusLine).toBeUndefined()
    expect(read().spinnerVerbs).toBeUndefined()
    expect(read().hooks).toBeUndefined()
    expect(r.removed).toContain('statusLine')
  })

  it('KULLANICININ hook\'unu birakmaz gitmez', () => {
    write({ hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: '/benim/script.sh' }] }] } })
    install(OPTS, path)
    uninstall(path, now)

    const list = read().hooks!['Stop']!
    expect(list).toHaveLength(1)
    expect(JSON.stringify(list)).toContain('/benim/script.sh')
  })

  it('YEDEKTEN DONMEZ — kurulumdan sonraki degisiklikler korunur', () => {
    // Yedege donmek kullanicinin aradan gecen surede yaptigi degisiklikleri
    // silerdi; bu, bizim eklediklerimizi birakmaktan daha kotu.
    install(OPTS, path)
    const s = read(); s.theme = 'light'; writeFileSync(path, JSON.stringify(s))

    uninstall(path, now)
    expect(read().theme, 'kullanicinin sonraki degisikligi durmali').toBe('light')
  })

  it('baskasinin statusLine\'ina dokunmaz', () => {
    write({ statusLine: { type: 'command', command: '/baska/arac.sh' } })
    install(OPTS, path)          // cakisma → atlandi
    uninstall(path, now)
    expect(read().statusLine?.command).toBe('/baska/arac.sh')
  })

  it('kurulmamisken kaldirmak zararsiz', () => {
    expect(() => uninstall(path, now)).not.toThrow()
  })

  it('kurulum → kaldirma dosyayi ILK HALINE dondurur', () => {
    const orijinal: ClaudeSettings = {
      theme: 'dark',
      hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: '/benim.sh' }] }] },
    }
    write(orijinal)
    install(OPTS, path)
    uninstall(path, now)
    expect(read()).toEqual(orijinal)
  })
})

describe('bozuk dosya', () => {
  it('okunamazsa DOKUNMAZ — tum ayarlari kaybetmektense hata ver', () => {
    writeFileSync(path, '{ bu bozuk json')
    expect(() => install(OPTS, path)).toThrow(/okunamadi/)
    expect(readFileSync(path, 'utf8')).toBe('{ bu bozuk json')
  })
})

describe('doctor — kurulum saglam mi', () => {
  it('saglam kurulumu tanir', () => {
    install(OPTS, path)
    expect(diagnose(OPTS.statusLineCommand, path)).toMatchObject({ installed: true, hijacked: false })
  })

  it('BASKA BIR ARAC ayarimizi degistirmisse tespit eder', () => {
    // Ayni yuzey icin yarisan bir eklenti periyodik olarak kendi ayarini
    // geri koyabiliyor. Kullanici "Dwell calismiyor" der, sebebini bilemez.
    install(OPTS, path)
    const s = read()
    s.statusLine = { type: 'command', command: '/rakip/statusline.sh' }
    writeFileSync(path, JSON.stringify(s))

    const d = diagnose(OPTS.statusLineCommand, path)
    expect(d.installed).toBe(false)
    expect(d.hijacked, 'ele gecirilme tespit edilmeli').toBe(true)
    expect(d.detail).toContain('/rakip/statusline.sh')
  })

  it('eski surumden kalma kurulumu ayirt eder', () => {
    install({ ...OPTS, statusLineCommand: '/eski/yol' }, path)
    const d = diagnose(OPTS.statusLineCommand, path)
    expect(d.hijacked, 'bu ele gecirme degil').toBe(false)
    expect(d.detail).toMatch(/eski surumden/)
  })

  it('hic kurulmamissa dogru soyler', () => {
    expect(diagnose(OPTS.statusLineCommand, path).detail).toMatch(/settings.json yok/)
  })
})

describe('yedek birikimi', () => {
  it('son 10 yedek tutulur', () => {
    write({ theme: 'dark' })
    for (let i = 0; i < 15; i++) install(OPTS, path)
    const backups = readdirSync(join(dir, 'dwell-backups'))
    expect(backups.length).toBeLessThanOrEqual(10)
  })
})
