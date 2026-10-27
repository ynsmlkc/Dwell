/**
 * Windows'a ozel: GERCEK named pipe uzerinden daemon.
 *
 * Yalnizca Windows'ta kosar (CI'da `windows-latest`). Diger platformlarda
 * pipe yolu anlamsiz oldugu icin atlanir; yol hesabi `ipc.test.ts`'te her
 * platformda test ediliyor.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startSocketServer, type SocketServer } from '../src/daemon/server.js'
import { startDaemon, type Daemon } from '../src/daemon/index.js'
import { ask } from '../src/cli/daemon-control.js'
import { socketPathFor } from '../src/ipc.js'

const onWindows = process.platform === 'win32'

let servers: SocketServer[] = []
let daemon: Daemon | null = null
let dir = ''

afterEach(async () => {
  for (const s of servers) await s.close()
  servers = []
  await daemon?.stop()
  daemon = null
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(!onWindows)('Windows named pipe', () => {
  it('sunucu pipe uzerinde dinler ve cevap verir', async () => {
    dir = mkdtempSync(join(tmpdir(), 'dwell-win-'))
    const pipe = socketPathFor(dir)
    servers.push(await startSocketServer(pipe, () => ({ t: 'ok' })))
    expect(await ask({ t: 'health' }, pipe)).toEqual({ t: 'ok' })
  })

  it('ikinci kopya "already running" ile reddedilir', async () => {
    dir = mkdtempSync(join(tmpdir(), 'dwell-win-'))
    const pipe = socketPathFor(dir)
    servers.push(await startSocketServer(pipe, () => ({ t: 'ok' })))
    await expect(startSocketServer(pipe, () => ({ t: 'ok' }))).rejects.toThrow(/already running/)
  })

  it('kapatildiktan sonra ayni pipe tekrar acilir', async () => {
    dir = mkdtempSync(join(tmpdir(), 'dwell-win-'))
    const pipe = socketPathFor(dir)
    const first = await startSocketServer(pipe, () => ({ t: 'ok' }))
    await first.close()
    servers.push(await startSocketServer(pipe, () => ({ t: 'ok' })))
    expect(await ask({ t: 'health' }, pipe)).toEqual({ t: 'ok' })
  })

  it('daemon pipe ile ayaga kalkar, duraklatma veri dizinine yazilir', async () => {
    dir = mkdtempSync(join(tmpdir(), 'dwell-win-'))
    const socketPath = socketPathFor(dir)
    daemon = await startDaemon({ socketPath, dataDir: dir, ads: [], syncSpinner: false })
    const h = await ask({ t: 'health' }, socketPath)
    expect(h?.t).toBe('health')
    await ask({ t: 'pause', on: true }, socketPath)
    expect(existsSync(join(dir, 'paused'))).toBe(true)
  })
})
