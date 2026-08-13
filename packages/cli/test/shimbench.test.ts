import { describe, it, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startDaemon, type Daemon } from '../src/daemon/index.js'
import type { AdPayload } from '@dwell/protocol'

const run = promisify(execFile)
const AD: AdPayload = { campaignId:'c1', nonce:'0'.repeat(32), nonceExpiresAt:9e12,
  creative:{ brand:'Firecrawl', text:'docs to LLM-ready markdown' } }

let daemon: Daemon | null = null; let dir = ''
afterEach(async () => { await daemon?.stop(); daemon = null; if (dir) rmSync(dir,{recursive:true,force:true}) })

describe('shim maliyeti', () => {
  it('ts-strip vs duz JS', async () => {
    dir = mkdtempSync(join(tmpdir(),'dwell-bench-'))
    const sock = join(dir,'d.sock')
    daemon = await startDaemon({ socketPath: sock, dataDir: dir, ads:[AD] })
    daemon.hook('UserPromptSubmit','s1')

    const variants: [string, string[]][] = [
      ['ts-strip', ['--experimental-strip-types', resolve(import.meta.dirname, '../src/shim/statusline.ts')]],
      ['derlenmis', [resolve(import.meta.dirname, '../dist/statusline.mjs')]],
    ]
    for (const [name, args] of variants) {
      const t: number[] = []; let empty = 0; let overBudget = 0
      for (let i=0;i<20;i++){
        const t0=performance.now()
        const c = run(process.execPath, args, { env:{...process.env,DWELL_SOCKET:sock,COLUMNS:'120'}, encoding:'utf8' })
        c.child.stdin?.end(JSON.stringify({session_id:'s1'}))
        const { stdout } = await c
        const ms = performance.now() - t0
        t.push(ms); if (!stdout) empty++
        if (ms > 200) overBudget++
      }
      t.sort((a,b)=>a-b)
      console.log(`    ${name.padEnd(10)} p50 ${t[10]!.toFixed(0).padStart(3)}ms  p90 ${t[18]!.toFixed(0).padStart(3)}ms  max ${t.at(-1)!.toFixed(0).padStart(3)}ms  >200ms: ${String(overBudget).padStart(2)}/20`)
    }
  }, 60_000)
})
