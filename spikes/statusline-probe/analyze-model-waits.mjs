#!/usr/bin/env node
/**
 * DUZELTME — bekleme penceresinin dogru tanimi.
 *
 * Ilk analiz `PreToolUse → PostToolUse` farkini "bekleme" sayiyordu.
 * O TOOL CALISMA SURESI ve %96'si 1 saniyenin altinda — cunku Read, Grep,
 * Edit gibi araclar hizli.
 *
 * Kullanicinin ekranda "Germinating… (1m 32s)" gorurken bekledigi sey MODEL.
 * Model beklemesi hook'lar arasindaki BOSLUKTA:
 *
 *   PostToolUse[i]  →  PreToolUse[i+1]     model bir sonraki adimi dusunuyor
 *   PostToolUse[son] →  Stop               model nihai cevabi yaziyor
 *   SessionStart    →  ilk PreToolUse      ilk dusunme
 *
 * Envanter iste bu bosluklardadir.
 */

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out')
const readJsonl = (f) => existsSync(f)
  ? readFileSync(f, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } })
  : []

const hooks = readJsonl(join(OUT, 'hooks.jsonl')).sort((a, b) => a._ts - b._ts)
const sl = readJsonl(join(OUT, 'statusline.jsonl')).sort((a, b) => a.ts - b.ts)

const H = (t) => console.log(`\n${'─'.repeat(70)}\n${t}\n${'─'.repeat(70)}`)
const pct = (n, d) => (d ? `%${(100 * n / d).toFixed(1)}` : '—')

/* ── oturum bazinda olay zinciri ── */
const bySession = new Map()
for (const h of hooks) {
  const s = h.session_id ?? '?'
  if (!bySession.has(s)) bySession.set(s, [])
  bySession.get(s).push(h)
}

/** Model dusunme pencereleri. */
const modelWaits = []
/** Tool calisma sureleri — karsilastirma icin. */
const toolRuns = []

for (const [session, evts] of bySession) {
  for (let i = 0; i < evts.length - 1; i++) {
    const a = evts[i], b = evts[i + 1]
    const gap = b._ts - a._ts
    if (gap < 0) continue

    if (a.hook_event_name === 'PreToolUse' && b.hook_event_name === 'PostToolUse') {
      toolRuns.push({ ms: b.duration_ms ?? gap, tool: a.tool_name, session })
      continue
    }
    // PostToolUse → PreToolUse   veya   PostToolUse → Stop   veya
    // SessionStart → PreToolUse  = model calisiyor
    const isModelGap =
      (a.hook_event_name === 'PostToolUse' && (b.hook_event_name === 'PreToolUse' || b.hook_event_name === 'Stop')) ||
      (a.hook_event_name === 'SessionStart' && b.hook_event_name === 'PreToolUse') ||
      (a.hook_event_name === 'Stop' && b.hook_event_name === 'PreToolUse')

    if (isModelGap) {
      // 5 dakikadan uzun bosluk = kullanici gitmis, model beklemesi degil
      if (gap <= 5 * 60_000) modelWaits.push({ ms: gap, from: a.hook_event_name, to: b.hook_event_name, start: a._ts, end: b._ts, session })
    }
  }
}

const hist = (rows, label) => {
  const B = [[0, 1], [1, 3], [3, 5], [5, 10], [10, 30], [30, 60], [60, 120], [120, Infinity]]
  console.log(`  ${label}  (n=${rows.length})`)
  for (const [lo, hi] of B) {
    const n = rows.filter((w) => w.ms >= lo * 1000 && w.ms < hi * 1000).length
    const name = hi === Infinity ? `${lo}sn+` : `${lo}-${hi}sn`
    console.log(`    ${name.padEnd(9)} ${'█'.repeat(Math.round(38 * n / Math.max(rows.length, 1))).padEnd(38)} ${String(n).padStart(4)}  ${pct(n, rows.length)}`)
  }
}

H('TOOL CALISMA SURESI  (ilk analizin "bekleme" sandigi sey)')
hist(toolRuns, 'PreToolUse → PostToolUse')

H('MODEL BEKLEME SURESI  (kullanicinin gercekten bekledigi sey)')
hist(modelWaits, 'hook\'lar arasi bosluk')

const qual = modelWaits.filter((w) => w.ms >= 10_000)
const total = modelWaits.reduce((s, w) => s + w.ms, 0)
console.log(`\n  Toplam model beklemesi : ${(total / 60000).toFixed(1)} dakika`)
console.log(`  >=10sn olanlar         : ${qual.length}  (${pct(qual.length, modelWaits.length)})`)
console.log(`  >=10sn'lerin toplami   : ${(qual.reduce((s, w) => s + w.ms, 0) / 60000).toFixed(1)} dakika`)
if (modelWaits.length) {
  const sorted = [...modelWaits].map((w) => w.ms).sort((a, b) => a - b)
  const q = (p) => sorted[Math.floor(sorted.length * p)] ?? 0
  console.log(`  p50 / p90 / max        : ${(q(0.5) / 1000).toFixed(1)}sn / ${(q(0.9) / 1000).toFixed(1)}sn / ${(sorted.at(-1) / 1000).toFixed(1)}sn`)
}

/* ── statusLine bu pencerelerde yenileniyor mu? ── */
H('statusLine model beklemesi sirasinda yenileniyor mu?   ← ACIK SORU #1')

if (!qual.length) {
  console.log('  >=10sn pencere yok — 5sn ustu ile bakiliyor:')
}
const probe = (qual.length ? qual : modelWaits.filter((w) => w.ms >= 5000))
if (!probe.length) {
  console.log('  Yeterli veri yok.')
} else {
  let withRefresh = 0, inside = 0
  for (const w of probe) {
    const n = sl.filter((r) => r.session === w.session && r.ts > w.start + 500 && r.ts < w.end - 500).length
    inside += n
    if (n > 0) withRefresh++
  }
  console.log(`  Incelenen pencere      : ${probe.length}`)
  console.log(`  Icinde yenileme olan   : ${withRefresh}  (${pct(withRefresh, probe.length)})`)
  console.log(`  Pencere basina ortalama: ${(inside / probe.length).toFixed(1)} yenileme`)
  const avgSec = probe.reduce((s, w) => s + w.ms, 0) / probe.length / 1000
  console.log(`  Ortalama pencere       : ${avgSec.toFixed(1)}sn → beklenen ~${(avgSec / 1.8).toFixed(1)} yenileme`)
}

/* ── maliyet ── */
H('MALIYET — statusLine kac kez calisiyor?')
const spanMin = (sl.at(-1).ts - sl[0].ts) / 60000
const sessions = new Set(sl.map((r) => r.session)).size
console.log(`  ${sl.length.toLocaleString()} cagri / ${spanMin.toFixed(0)} dk / ${sessions} oturum`)
console.log(`  Oturum basina          : ${(sl.length / sessions / spanMin).toFixed(1)} cagri/dk  (~${(60 / (sl.length / sessions / spanMin)).toFixed(1)} saniyede bir)`)
console.log(`  Gunluk (tek oturum)    : ~${Math.round(sl.length / sessions / spanMin * 60 * 8).toLocaleString()} process spawn / 8 saatlik gun`)
console.log('\n  Bu, ADR-003\'un <50ms butcesinin neden pazarlik konusu olmadigini gosteriyor.')
