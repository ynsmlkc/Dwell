/**
 * Daemon yasam dongusu testleri.
 *
 * Buradaki en onemli test bir GUVENLIK testi: bayat bir pidfile yuzunden
 * masum bir sureci oldurmemek.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let dir = ''
let innocent: ChildProcess | null = null

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dwell-pid-'))
  process.env['DWELL_HOME'] = join(dir, '.dwell')
  process.env['DWELL_SOCKET'] = join(dir, '.dwell', 'dwelld.sock')
})

afterEach(() => {
  innocent?.kill('SIGKILL')
  innocent = null
  rmSync(dir, { recursive: true, force: true })
  delete process.env['DWELL_HOME']
  delete process.env['DWELL_SOCKET']
})

// Yollar cagri aninda hesaplandigi icin modulu bir kez import etmek yeterli.
import * as dc from '../src/cli/daemon-control.js'
const fresh = async () => dc

describe('bayat pidfile — masum surec oldurulmez', () => {
  it('daemon calismiyorken stop() KIMSEYI oldurmez', async () => {
    const dc = await fresh()

    // Gercek, yasayan bir surec baslat ve pid'ini pidfile'a yaz.
    // Senaryo: onceki bir `dwell init` daemon'i baslatamadi ama pidfile
    // birakti; isletim sistemi o pid'i bu surece yeniden atadi.
    innocent = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore' })
    await new Promise((r) => setTimeout(r, 200))
    const pid = innocent.pid!
    expect(pid).toBeGreaterThan(0)

    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(dir, '.dwell'), { recursive: true })
    writeFileSync(dc.pidPath(), String(pid))

    await dc.stop()
    await new Promise((r) => setTimeout(r, 300))

    // Masum surec YASIYOR olmali.
    let alive = true
    try { process.kill(pid, 0) } catch { alive = false }
    expect(alive, 'bayat pidfile masum sureci oldurmemeli').toBe(true)
  })

  it('bayat pidfile temizlenir', async () => {
    const dc = await fresh()
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(dir, '.dwell'), { recursive: true })
    writeFileSync(dc.pidPath(), '999999')

    await dc.stop()
    expect(existsSync(dc.pidPath()), 'bayat dosya silinmeli').toBe(false)
  })

  it('pidfile yoksa stop() zararsiz', async () => {
    const dc = await fresh()
    await expect(dc.stop()).resolves.toBe(false)
  })
})

describe('basarisiz baslatma', () => {
  it('daemon acilamazsa pidfile BIRAKILMAZ', async () => {
    // Pidfile birakmak, bir sonraki `uninstall`in rastgele bir pid'i
    // oldurmesine yol acar.
    const dc = await fresh()
    const bozuk = join(dir, 'bozuk.mjs')
    writeFileSync(bozuk, 'throw new Error("acilamadim")')

    const r = await dc.start({ entry: bozuk, waitMs: 1_500 })
    expect('error' in r).toBe(true)
    expect(existsSync(dc.pidPath()), 'basarisiz baslatma iz birakmamali').toBe(false)
  })

  it('hata mesaji log dosyasini gosterir', async () => {
    const dc = await fresh()
    const bozuk = join(dir, 'bozuk.mjs')
    writeFileSync(bozuk, 'throw new Error("acilamadim")')
    const r = await dc.start({ entry: bozuk, waitMs: 1_000 })
    if ('error' in r) expect(r.error).toContain('daemon.log')
  })
})

describe('canlilik kontrolu', () => {
  it('daemon yokken isAlive false', async () => {
    const dc = await fresh()
    expect(await dc.isAlive(join(dir, 'yok.sock'), 300)).toBe(false)
  })
})
