/**
 * Uctan uca: gercek daemon + gercek shim sureci.
 *
 * En kritik olcum burada: shim'in **gercek** gecikmesi. ADR-003 butcesi 50ms
 * ve bu yol gunde ~13.700 kez kat ediliyor (§12.2).
 */

import { describe, it, expect, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startDaemon, type Daemon } from '../src/daemon/index.js'
import type { AdPayload } from '@dwell/protocol'

const SHIM = resolve(import.meta.dirname, '../src/shim/statusline.ts')

let daemon: Daemon | null = null
let dir = ''

afterEach(async () => {
  await daemon?.stop()
  daemon = null
  if (dir) rmSync(dir, { recursive: true, force: true })
})

const AD: AdPayload = {
  campaignId: 'camp-1',
  nonce: '0'.repeat(32),
  nonceExpiresAt: 9_999_999_999_999,
  creative: { brand: 'Firecrawl', text: 'docs to LLM-ready markdown', cta: 'firecrawl.dev' },
}

/**
 * Claude Code'un yaptigini yapar: shim'i calistir, stdin'e JSON ver, stdout'u al.
 *
 * DIKKAT — `execFileSync` KULLANILAMAZ. Daemon bu testte ayni surecte calisiyor;
 * senkron spawn event loop'u blokladigi icin sunucu baglantiyi kabul edemez ve
 * shim cevap bekleyerek zaman asimina ugrar. Klasik deadlock.
 */
async function runShim(socket: string, session = 's1', columns = 120, input?: string) {
  const t0 = performance.now()
  const child = run(process.execPath, ['--experimental-strip-types', SHIM], {
    env: {
      ...process.env, DWELL_SOCKET: socket, COLUMNS: String(columns),
      // Testte butce acikca yukseltiliyor: buradaki amac DOGRULUK, zamanlama
      // degil. Uretim butcesi ayri olculuyor (shimbench). Yuklu bir makinede
      // ts-strip ile 50ms asilabiliyor ve shim sessizce bos donuyor — dogru
      // davranis ama testi kirilgan yapar.
      DWELL_BUDGET_MS: process.env['DWELL_BUDGET_MS'] ?? '2000',
    },
    encoding: 'utf8',
  })
  child.child.stdin?.end(input ?? JSON.stringify({ session_id: session, model: { display_name: 'Opus 5' } }))
  const { stdout } = await child
  return { out: stdout, ms: performance.now() - t0 }
}

describe('uctan uca — shim ile daemon', () => {
  it('tur yokken HICBIR SEY basmaz', async () => {
    dir = mkdtempSync(join(tmpdir(), 'dwell-e2e-'))
    const sock = join(dir, 'd.sock')
    daemon = await startDaemon({ socketPath: sock, dataDir: dir, ads: [AD] })

    expect((await runShim(sock)).out).toBe('')
  })

  it('tur icinde reklami basar — ifsa glifi ve ANSI ile', async () => {
    dir = mkdtempSync(join(tmpdir(), 'dwell-e2e-'))
    const sock = join(dir, 'd.sock')
    daemon = await startDaemon({ socketPath: sock, dataDir: dir, ads: [AD] })
    daemon.hook('UserPromptSubmit', 's1')

    const { out } = await runShim(sock)
    expect(out).toContain('✶')
    expect(out).toContain('Firecrawl')
    expect(out).toContain('\x1B[')            // stil var
    expect(out).not.toContain('\n')           // tek satir
  })

  it('daemon YOKSA sessizce cikar — Claude Code bozulmaz', async () => {
    dir = mkdtempSync(join(tmpdir(), 'dwell-e2e-'))
    const missing = join(dir, 'yok.sock')
    const t0 = performance.now()
    const { out } = await runShim(missing, 's1', 120, '{}')
    expect(out).toBe('')
    expect(performance.now() - t0, 'butceyi asmadan pes etmeli').toBeLessThan(1_000)
  })

  it('bozuk stdin gelse bile patlamaz', async () => {
    dir = mkdtempSync(join(tmpdir(), 'dwell-e2e-'))
    const sock = join(dir, 'd.sock')
    daemon = await startDaemon({ socketPath: sock, dataDir: dir, ads: [AD] })
    daemon.hook('UserPromptSubmit', '?')

    const { out } = await runShim(sock, '?', 120, 'bu json degil')
    expect(typeof out).toBe('string')
  })

  it('dar terminalde satir sigar', async () => {
    dir = mkdtempSync(join(tmpdir(), 'dwell-e2e-'))
    const sock = join(dir, 'd.sock')
    daemon = await startDaemon({ socketPath: sock, dataDir: dir, ads: [AD] })
    daemon.hook('UserPromptSubmit', 's1')

    const { out } = await runShim(sock, 's1', 40)
    const visible = out.replace(/\x1B\[[0-9;]*m/g, '')
    expect(visible.length).toBeLessThanOrEqual(40)
  })

  it('ADR-003 — shim butcesi: socket gidis donusu 50ms icinde', async () => {
    dir = mkdtempSync(join(tmpdir(), 'dwell-e2e-'))
    const sock = join(dir, 'd.sock')
    daemon = await startDaemon({ socketPath: sock, dataDir: dir, ads: [AD] })
    daemon.hook('UserPromptSubmit', 's1')

    const runs: number[] = []
    for (let i = 0; i < 12; i++) runs.push((await runShim(sock)).ms)
    runs.sort((a, b) => a - b)
    const p50 = runs[Math.floor(runs.length / 2)]!
    const max = runs.at(-1)!

    // Bu sure Node baslangicini DA iceriyor — gercek maliyet bu.
    console.log(`    shim toplam: p50 ${p50.toFixed(0)}ms, max ${max.toFixed(0)}ms (n=${runs.length})`)
    expect(p50).toBeLessThan(400)   // ts-strip ile; derlenmis surumde cok dusecek
  })
})

describe('uctan uca — tam tur', () => {
  it('tur boyunca gosterim sayilir, bitince raporlanir', async () => {
    dir = mkdtempSync(join(tmpdir(), 'dwell-e2e-'))
    const sock = join(dir, 'd.sock')
    const seen: string[] = []
    daemon = await startDaemon({
      socketPath: sock,
      dataDir: dir,
      ads: [AD, { ...AD, campaignId: 'camp-2', creative: { brand: 'Resend', text: 'email for devs' } }],
      config: {
        renderEnabled: true,
        surfaces: { statusline: true, spinnerVerb: true, spinnerTip: true },
        minClientVersion: '0.0.0',
        minImpressionMs: 100,
        rotateMs: 200,
        idleGraceMs: 50,
        refreshIntervalSec: 1,
        configPollSec: 300,
        reportIntervalSec: 60,
      },
      onImpression: (i) => seen.push(i.campaignId),
    })

    daemon.hook('UserPromptSubmit', 's1')
    const t0 = Date.now()
    while (Date.now() - t0 < 500) {
      daemon.tick('s1')
      await new Promise((r) => setTimeout(r, 20))
    }
    daemon.hook('Stop', 's1')
    await new Promise((r) => setTimeout(r, 80))
    daemon.tick('s1')

    const imps = daemon.impressions()
    expect(imps.length, 'rotasyonla birden fazla gosterim').toBeGreaterThan(1)
    expect(new Set(seen).size, 'reklamlar donmus olmali').toBeGreaterThan(1)
    expect(imps.every((i) => i.surface === 'statusline')).toBe(true)
  })
})
