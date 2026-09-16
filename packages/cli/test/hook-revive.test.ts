/**
 * `SessionStart` hook'u olu daemon'i canlandirir mi?
 *
 * Gercekte yasandi: dwelld reboot'ta ya da carptiginda kimse onu geri
 * acmiyordu — hook yalnizca "canliysa haber ver" modundaydi ve soket olu
 * bulununca sessizce vazgeciyordu (bkz. `shim/hook.ts` `tryRevive`).
 *
 * Bu test gercek `dist/hook.mjs`'i, hicbir daemon calismazken, `SessionStart`
 * olayiyla calistirir ve az sonra sokete gercekten cevap veren yeni bir
 * daemon'in ayakta oldugunu dogrular.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import * as dc from '../src/cli/daemon-control.js'

const run = promisify(execFile)
const HOOK = resolve(import.meta.dirname, '../dist/hook.mjs')

let dir = ''
let spawnedPid: number | null = null

afterEach(async () => {
  if (spawnedPid !== null) { try { process.kill(spawnedPid, 'SIGKILL') } catch { /* zaten olu */ } }
  spawnedPid = null
  if (dir) rmSync(dir, { recursive: true, force: true })
})

async function runHook(event: string, socket: string, home: string) {
  const child = run(process.execPath, [HOOK, event], {
    env: { ...process.env, DWELL_SOCKET: socket, DWELL_HOME: home },
    encoding: 'utf8',
  })
  child.child.stdin?.end(JSON.stringify({ session_id: 's1' }))
  await child
}

describe('SessionStart hook — olu daemon canlandirma', () => {
  it('daemon calismazken SessionStart onu arka planda baslatir', async () => {
    dir = mkdtempSync(join(tmpdir(), 'dwell-revive-'))
    const home = join(dir, '.dwell')
    const sock = join(home, 'dwelld.sock')

    expect(await dc.isAlive(sock, 200)).toBe(false)

    await runHook('SessionStart', sock, home)

    // Fire-and-forget: daemon'in ayaga kalkmasi icin kisa bir sure taniriz.
    const deadline = Date.now() + 8_000
    let alive = false
    while (Date.now() < deadline && !alive) {
      alive = await dc.isAlive(sock, 200)
      if (!alive) await new Promise((r) => setTimeout(r, 100))
    }
    expect(alive).toBe(true)

    const health = await dc.ask({ t: 'health' }, sock)
    if (health?.t === 'health') spawnedPid = health.info.pid
  }, 10_000)

  it('SessionStart DISINDAKI olaylar canlandirmaz — sadece haber vermeyi dener', async () => {
    dir = mkdtempSync(join(tmpdir(), 'dwell-revive-'))
    const home = join(dir, '.dwell')
    const sock = join(home, 'dwelld.sock')

    await runHook('UserPromptSubmit', sock, home)

    await new Promise((r) => setTimeout(r, 500))
    expect(await dc.isAlive(sock, 200)).toBe(false)
  })
})
