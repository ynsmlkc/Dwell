/**
 * Kuyruk — sunucu yokken gosterim BIRIKTIRILMEZ.
 *
 * Gercek kurulumda bulundu: demo modunda calisan bir makinede 3.152
 * gosterim diske birikmisti. Kullanici giris yapinca hepsi sunucuya gitti
 * ve toptan reddedildi — kampanyalari sunucuda yok. Iki zarari vardi:
 * kullanicinin GERCEK kazanci o yiginin arkasinda siraya girdi, ve sunucu
 * tek kullanicidan binlerce gecersiz kayit aldi.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startDaemon } from '../src/daemon/index.js'
import { ask } from '../src/cli/daemon-control.js'
import { FALLBACK_CONFIG } from '@dwell/protocol'
import type { AdPayload } from '@dwell/protocol'

const ADS: AdPayload[] = [{
  campaignId: 'sample-1', nonce: '0'.repeat(32), nonceExpiresAt: 9e12,
  creative: { brand: 'Dwell', text: 'sample', cta: 'dwell login' },
}]
const CONFIG = {
  ...FALLBACK_CONFIG, renderEnabled: true,
  surfaces: { statusline: true, spinnerVerb: true, spinnerTip: true },
  minImpressionMs: 10, rotateMs: 20_000, idleGraceMs: 0,
}

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

/** Bir tur ac, yeterince goster, kapat — bir gosterim uretir. */
async function birGosterim(socketPath: string) {
  await ask({ t: 'hook', event: 'UserPromptSubmit', session: 's1' }, socketPath)
  await ask({ t: 'tick', session: 's1', columns: 100 }, socketPath)
  await new Promise((r) => setTimeout(r, 30))
  await ask({ t: 'tick', session: 's1', columns: 100 }, socketPath)
  await ask({ t: 'hook', event: 'Stop', session: 's1' }, socketPath)
  await ask({ t: 'health' }, socketPath)          // drain'i tetikle
}

describe('sunucusuz kuyruk', () => {
  it('sunucu yokken diske HICBIR SEY yazilmaz', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dwell-q-')); dirs.push(dir)
    const socketPath = join(dir, 's.sock')
    const daemon = await startDaemon({ ads: ADS, socketPath, dataDir: dir, syncSpinner: false, config: CONFIG })
    try {
      await birGosterim(socketPath)
      const h = await ask({ t: 'health' }, socketPath)
      expect(h?.t === 'health' && h.info.queuedImpressions).toBe(0)
      // Kuyruk dosyasi ya hic yok ya bos.
      const f = join(dir, 'impressions.jsonl')
      if (existsSync(f)) expect(readFileSync(f, 'utf8').trim()).toBe('')
    } finally { await daemon.stop() }
  })

  it('sunucu VARSA normal sekilde kuyruga girer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dwell-q-')); dirs.push(dir)
    const socketPath = join(dir, 's.sock')
    // Ag cagrilarini yutan sahte fetch: kuyruk dolsun, bosalmasin.
    const daemon = await startDaemon({
      socketPath, dataDir: dir, syncSpinner: false, config: CONFIG,
      serverUrl: 'https://sunucu.test', token: 'dwl_x',
      fetchImpl: (async () => new Response(null, { status: 503 })) as unknown as typeof fetch,
    })
    try {
      // Sunucudan reklam gelmedigi icin gosterim de olmayacak; burada
      // onemli olan kuyrugun VAR olmasi ve `sync` yolunun secilmesi.
      const h = await ask({ t: 'health' }, socketPath)
      expect(h?.t).toBe('health')
      expect(h?.t === 'health' && typeof h.info.queuedImpressions).toBe('number')
    } finally { await daemon.stop() }
  })
})
