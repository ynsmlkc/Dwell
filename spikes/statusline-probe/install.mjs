#!/usr/bin/env node
/**
 * Kivilcim 1 — probe kurucusu.  ATILACAK KOD.
 *
 * ~/.claude/settings.json'a olcum probe'larini ekler.
 *
 * GUVENLIK KURALLARI (gercek `dwell init` de bunlara uyacak — §6.1):
 *   - Once ZAMAN DAMGALI YEDEK alinir.
 *   - Mevcut hook'lar KORUNUR; dizilere eklenir, uzerine yazilmaz.
 *   - Mevcut statusLine / spinnerVerbs varsa DOKUNULMAZ, uyari verilir.
 *   - uninstall.mjs yedekten birebir geri doner.
 *
 * Kullanim:
 *   node install.mjs            → statusLine + hook'lar
 *   node install.mjs --spinner  → ustune spinnerVerbs + spinnerTipsOverride
 */

import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SETTINGS = join(homedir(), '.claude', 'settings.json')
const WITH_SPINNER = process.argv.includes('--spinner')

const REFRESH_INTERVAL = 1   // saniye — ADR-001'deki iddiayi test ediyoruz

if (!existsSync(SETTINGS)) {
  console.error(`✗ ${SETTINGS} bulunamadi.`)
  process.exit(1)
}

const original = readFileSync(SETTINGS, 'utf8')
const cfg = JSON.parse(original)

// ── 1. yedek ──
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backup = join(HERE, 'out', `settings.backup.${stamp}.json`)
mkdirSync(join(HERE, 'out'), { recursive: true })
writeFileSync(backup, original)
writeFileSync(join(HERE, 'out', 'settings.backup.latest.json'), original)
console.log(`✓ Yedek alindi: ${backup}`)

// ── 2. script'leri calistirilabilir yap ──
for (const f of ['statusline.sh', 'hook.sh']) chmodSync(join(HERE, f), 0o755)

const statusScript = join(HERE, 'statusline.sh')
const hookScript = join(HERE, 'hook.sh')

// ── 3. statusLine ──
if (cfg.statusLine) {
  console.log('⚠ Mevcut statusLine var — DOKUNULMADI. Probe icin gecici olarak kaldir:')
  console.log(`  ${JSON.stringify(cfg.statusLine)}`)
} else {
  cfg.statusLine = { type: 'command', command: statusScript, refreshInterval: REFRESH_INTERVAL }
  console.log(`✓ statusLine eklendi (refreshInterval: ${REFRESH_INTERVAL}sn)`)
}

// ── 4. hook'lar — mevcutlari KORUYARAK ──
cfg.hooks ??= {}
const EVENTS = ['PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SessionStart']
let added = 0
for (const ev of EVENTS) {
  cfg.hooks[ev] ??= []
  const already = JSON.stringify(cfg.hooks[ev]).includes(hookScript)
  if (already) continue
  cfg.hooks[ev].push({ matcher: '', hooks: [{ type: 'command', command: hookScript }] })
  added++
}
console.log(`✓ ${added} hook event'i eklendi (mevcut hook'lar korundu)`)

// ── 5. spinner katmani (opsiyonel) ──
if (WITH_SPINNER) {
  if (cfg.spinnerVerbs) {
    console.log('⚠ Mevcut spinnerVerbs var — DOKUNULMADI.')
  } else {
    // ADR-013: spinner verb'u de ✶ ile baslar, organik cikti gibi gorunmez.
    cfg.spinnerVerbs = { mode: 'replace', verbs: ['✶ Firecrawl'] }
    console.log('✓ spinnerVerbs eklendi (mode: replace, tek verb)')
  }
  if (cfg.spinnerTipsOverride) {
    console.log('⚠ Mevcut spinnerTipsOverride var — DOKUNULMADI.')
  } else {
    cfg.spinnerTipsOverride = {
      excludeDefault: true,
      tips: ['✶ Firecrawl — docs to LLM-ready markdown · firecrawl.dev'],
    }
    console.log('✓ spinnerTipsOverride eklendi')
  }
}

writeFileSync(SETTINGS, JSON.stringify(cfg, null, 2) + '\n')

console.log(`
─────────────────────────────────────────────────────────────
  Kurulum tamam. Simdi:

  1. YENI bir Claude Code oturumu ac (bu oturum degil).
  2. En az 20-30 dakika normal calis. Uzun surecek isler yaptir
     (buyuk grep, test kosumu, cok dosyali degisiklik) — asil
     olculmek istenen o bekleme pencereleri.
  3. Su sorulara GOZLE bak ve not al:
       · Alt satirda reklam gorundu mu?
       · BEKLERKEN de duruyor mu, donuyor mu?${WITH_SPINNER ? `
       · Spinner "✶ Firecrawl…" diyor mu?
       · Alttaki "Tip:" satiri degisti mi?` : ''}
       · Footer'daki "esc to interrupt" kayboldu mu?
  4. Bitince:  node analyze.mjs
  5. Geri al:  node uninstall.mjs
─────────────────────────────────────────────────────────────
`)
