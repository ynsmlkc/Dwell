#!/usr/bin/env node
/**
 * Hook shim — Claude Code'un tur olaylarinda cagirdigi program.
 *
 * `dwell-hook <EventName>` seklinde cagrilir; olay adi argumandan, oturum
 * kimligi stdin'deki JSON'dan gelir.
 *
 * MUTLAK KURAL: her zaman 0 ile cikar ve HICBIR SEY basmaz.
 *
 * Bir hook'un yavas olmasi veya non-zero donmesi kullanicinin tool
 * cagrisini bloklayabilir — ve bu aninda uninstall sebebidir. Daemon yoksa,
 * socket bozuksa, JSON bozuksa: sessizce cik.
 */
import { socketPathFor } from '../ipc.js'

import { connect } from 'node:net'
import { spawn } from 'node:child_process'
import { existsSync, openSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SOCKET = process.env['DWELL_SOCKET']
  ?? socketPathFor(process.env['DWELL_HOME'] ?? `${process.env['HOME']}/.dwell`)
const BUDGET_MS = Number(process.env['DWELL_HOOK_BUDGET_MS'] ?? 300) || 300

const quit = (): never => process.exit(0)

/**
 * `SessionStart`'ta soket olu bulunursa daemon'i FIRE-AND-FORGET yeniden
 * dener. Sonucunu beklemeyiz — beklemek MUTLAK KURAL'i (hemen cik) ihlal
 * eder. `startSocketServer` zaten canli bir daemon varsa ikinci kopyayi
 * kendisi reddediyor (bkz. `daemon/server.ts`), o yuzden bir yaristan
 * korkmuyoruz: en kotu ihtimalle bosa bir surec acilip aninda kapanir.
 *
 * Reboot'tan sonra veya daemon carptiginda kimse onu geri acmiyordu —
 * hook yalnizca "canliysa haber ver" moduna sessizce dusuyordu. Bu, o
 * boslugu kapatir.
 */
function tryRevive(): void {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    let pkgRoot = here
    for (let i = 0; i < 6; i++) {
      if (existsSync(join(pkgRoot, 'package.json'))) break
      pkgRoot = dirname(pkgRoot)
    }
    const entry = join(pkgRoot, 'dist', 'daemon.mjs')
    if (!existsSync(entry)) return

    const home = process.env['DWELL_HOME'] ?? `${process.env['HOME']}/.dwell`
    mkdirSync(home, { recursive: true, mode: 0o700 })
    const logFd = openSync(join(home, 'daemon.log'), 'a')
    const child = spawn(process.execPath, [entry], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
    })
    child.unref()
  } catch { /* canlandiramadik — bir sonraki SessionStart yine dener */ }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

function main(): void {
  const event = process.argv[2]
  if (!event) quit()

  const timer = setTimeout(quit, BUDGET_MS)
  timer.unref()

  void readStdin().then((raw) => {
    let session = '?'
    let promptId: string | undefined
    try {
      const j = JSON.parse(raw) as { session_id?: string; prompt_id?: string }
      if (typeof j.session_id === 'string') session = j.session_id
      if (typeof j.prompt_id === 'string') promptId = j.prompt_id
    } catch { /* bozuk payload — yine de olayi bildir */ }

    const sock = connect(SOCKET)
    sock.setNoDelay(true)
    sock.on('error', () => {
      if (event === 'SessionStart') tryRevive()
      quit()
    })
    sock.setTimeout(BUDGET_MS, quit)
    sock.on('connect', () => {
      sock.write(JSON.stringify({ t: 'hook', event, session, ...(promptId ? { promptId } : {}) }) + '\n')
      // Cevabi BEKLEMIYORUZ: hook'un isi bildirmek, sormak degil. Beklemek
      // kullanicinin tool cagrisini geciktirir.
      sock.end()
      clearTimeout(timer)
      quit()
    })
  }).catch(quit)
}

main()
