/**
 * `dwell pause` — gercekten duraklatiyor mu.
 *
 * Denetimde bulundu: komut "duraklatildi" yaziyordu ama hicbir sey
 * yapmiyordu. Kullanici durdurdugunu sanip reklamlar donmeye devam
 * ediyordu. Bir arayuzun yapabilecegi en kotu sey, olmayan bir seyi
 * olmus gibi gostermek.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startDaemon } from '../src/daemon/index.js'
import { ask } from '../src/cli/daemon-control.js'
import { FALLBACK_CONFIG } from '@dwell/protocol'
import type { AdPayload } from '@dwell/protocol'

const ADS: AdPayload[] = [{
  campaignId: 'c1', nonce: '0'.repeat(32), nonceExpiresAt: 9e12,
  creative: { brand: 'X', text: 'y', cta: 'x.com' },
}]

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

async function kur() {
  const dir = mkdtempSync(join(tmpdir(), 'dwell-pause-'))
  dirs.push(dir)
  const socketPath = join(dir, 's.sock')
  const daemon = await startDaemon({
    ads: ADS, socketPath, syncSpinner: false,
    config: { ...FALLBACK_CONFIG, renderEnabled: true, surfaces: { statusline: true, spinnerVerb: true, spinnerTip: true }, minImpressionMs: 1000, rotateMs: 20_000, idleGraceMs: 4_000 },
  })
  return { daemon, socketPath, dir }
}

/** Tur ac, sonra tik at — reklam gelir mi? */
async function reklamVarMi(socketPath: string): Promise<boolean> {
  await ask({ t: 'hook', event: 'UserPromptSubmit', session: 's1' }, socketPath)
  const r = await ask({ t: 'tick', session: 's1', columns: 100 }, socketPath)
  return !!(r && r.t === 'render' && r.line.length > 0)
}

describe('duraklatma', () => {
  it('duraklatinca reklam GERCEKTEN durur', async () => {
    const { daemon, socketPath } = await kur()
    try {
      expect(await reklamVarMi(socketPath), 'once gelmeli').toBe(true)

      const res = await ask({ t: 'pause', on: true }, socketPath)
      expect(res?.t).toBe('ok')

      expect(await reklamVarMi(socketPath), 'duraklatinca gelmemeli').toBe(false)
    } finally { await daemon.stop() }
  })

  it('devam ettirince geri gelir', async () => {
    const { daemon, socketPath } = await kur()
    try {
      await ask({ t: 'pause', on: true }, socketPath)
      expect(await reklamVarMi(socketPath)).toBe(false)

      await ask({ t: 'pause', on: false }, socketPath)
      expect(await reklamVarMi(socketPath)).toBe(true)
    } finally { await daemon.stop() }
  })

  /**
   * En onemlisi. Yalnizca bellekte tutsaydik `dwell restart` sessizce
   * devam ettirirdi — kullanici durdurdugunu bilir, reklamlar doner.
   */
  it('duraklatma YENIDEN BASLATMADAN sonra da surer', async () => {
    const { daemon, socketPath, dir } = await kur()
    await ask({ t: 'pause', on: true }, socketPath)
    await daemon.stop()

    expect(existsSync(join(dir, 'paused')), 'diske yazilmali').toBe(true)

    const yeni = await startDaemon({
      ads: ADS, socketPath, syncSpinner: false,
      config: { ...FALLBACK_CONFIG, renderEnabled: true, surfaces: { statusline: true, spinnerVerb: true, spinnerTip: true }, minImpressionMs: 1000, rotateMs: 20_000, idleGraceMs: 4_000 },
    })
    try {
      expect(await reklamVarMi(socketPath), 'hala duraklatilmis olmali').toBe(false)
      const h = await ask({ t: 'health' }, socketPath)
      expect(h?.t === 'health' && h.info.paused).toBe(true)
    } finally { await yeni.stop() }
  })

  it('devam ettirilince disktekI isaret silinir', async () => {
    const { daemon, socketPath, dir } = await kur()
    try {
      await ask({ t: 'pause', on: true }, socketPath)
      expect(existsSync(join(dir, 'paused'))).toBe(true)
      await ask({ t: 'pause', on: false }, socketPath)
      expect(existsSync(join(dir, 'paused'))).toBe(false)
    } finally { await daemon.stop() }
  })
})
