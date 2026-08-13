#!/usr/bin/env node
/**
 * Kivilcim 1 — olcum raporu.  ATILACAK KOD.
 *
 * §12.1'in bitti kriterini uretir:
 *   1. statusLine cagri sikligi — BEKLERKEN yenileniyor mu?
 *   2. Hook envanteri — hangileri atesleniyor, payload'da ne var
 *   3. Bekleme suresi histogrami — >=10sn oranı = envanterin gercek boyutu
 *   4. $/gelistirici/ay projeksiyonu  ← asil cikti
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out')
const readJsonl = (f) => existsSync(f)
  ? readFileSync(f, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } })
  : []

const sl = readJsonl(join(OUT, 'statusline.jsonl')).sort((a, b) => a.ts - b.ts)
const hooks = readJsonl(join(OUT, 'hooks.jsonl')).sort((a, b) => a._ts - b._ts)

if (!sl.length && !hooks.length) {
  console.error('✗ Hic veri yok. install.mjs calistirilip yeni bir oturumda calisildi mi?')
  process.exit(1)
}

const H = (t) => console.log(`\n${'─'.repeat(70)}\n${t}\n${'─'.repeat(70)}`)
const pct = (n, d) => d ? `%${(100 * n / d).toFixed(1)}` : '—'

/* ── 1. statusLine sikligi ── */
H('1  statusLine cagri sikligi')

if (!sl.length) {
  console.log('  Hic cagrilmamis. statusLine kurulmadi ya da calismadi.')
} else {
  const gaps = sl.slice(1).map((r, i) => r.ts - sl[i].ts).filter((g) => g >= 0)
  const sorted = [...gaps].sort((a, b) => a - b)
  const q = (p) => sorted.length ? sorted[Math.floor(sorted.length * p)] : 0
  const spanMin = (sl.at(-1).ts - sl[0].ts) / 60000

  console.log(`  Toplam cagri     : ${sl.length}`)
  console.log(`  Sure             : ${spanMin.toFixed(1)} dakika`)
  console.log(`  Ortalama siklik  : ${(sl.length / Math.max(spanMin, 0.01)).toFixed(1)} cagri/dakika`)
  console.log(`  Aralik p50/p90   : ${q(0.5)}ms / ${q(0.9)}ms`)
  // Math.max(...gaps) 175k elemanda stack'i patlatiyor — reduce sart.
  const maxGap = gaps.reduce((m, g) => (g > m ? g : m), 0)
  console.log(`  En uzun sessizlik: ${(maxGap / 1000).toFixed(1)}sn`)

  const sessions = new Set(sl.map((r) => r.session))
  console.log(`  Oturum sayisi    : ${sessions.size}`)

  // Birlesik zaman cizgisi yaniltici: N oturum paralel calisirsa siklik
  // N katina cikar. Asil soru OTURUM BASINA siklik.
  console.log('\n  Oturum basina (en aktif 5):')
  const perSession = [...sessions].map((s) => {
    const rows = sl.filter((r) => r.session === s)
    const span = (rows.at(-1).ts - rows[0].ts) / 60000
    return { s, n: rows.length, span, rate: rows.length / Math.max(span, 0.01) }
  }).sort((a, b) => b.n - a.n).slice(0, 5)
  for (const p of perSession) {
    console.log(`    ${p.s.slice(0, 8)}  ${String(p.n).padStart(6)} cagri  ${p.span.toFixed(0).padStart(4)}dk  ${p.rate.toFixed(1).padStart(5)} cagri/dk`)
  }
  console.log(`  COLUMNS geldi mi : ${sl.at(-1).columns !== '?' ? `evet (${sl.at(-1).columns})` : 'HAYIR — genislik bilinemiyor'}`)
}

/* ── 2. hook envanteri ── */
H('2  Hook envanteri')

const byEvent = {}
for (const h of hooks) (byEvent[h.hook_event_name ?? '?'] ??= []).push(h)
if (!hooks.length) console.log('  Hic hook ateslenmemis.')
for (const [ev, list] of Object.entries(byEvent)) {
  const keys = [...new Set(list.flatMap((x) => Object.keys(x)))].filter((k) => k !== '_ts')
  console.log(`  ${ev.padEnd(16)} ${String(list.length).padStart(4)} kez   alanlar: ${keys.join(', ')}`)
}

/* ── 3. bekleme penceresi histogrami ── */
H('3  Bekleme penceresi histogrami  (PreToolUse → PostToolUse)')

const open = new Map()
const waits = []
for (const h of hooks) {
  const key = `${h.session_id ?? '?'}|${h.tool_name ?? '?'}`
  if (h.hook_event_name === 'PreToolUse') open.set(key, h._ts)
  else if (h.hook_event_name === 'PostToolUse' && open.has(key)) {
    waits.push({ ms: h._ts - open.get(key), tool: h.tool_name ?? '?', start: open.get(key), end: h._ts })
    open.delete(key)
  }
}

const BUCKETS = [[0, 1], [1, 3], [3, 5], [5, 10], [10, 30], [30, 60], [60, Infinity]]
const qualifying = waits.filter((w) => w.ms >= 10_000)

if (!waits.length) {
  console.log('  Eslesen Pre/Post cifti yok.')
} else {
  for (const [lo, hi] of BUCKETS) {
    const n = waits.filter((w) => w.ms >= lo * 1000 && w.ms < hi * 1000).length
    const label = hi === Infinity ? `${lo}sn+` : `${lo}-${hi}sn`
    console.log(`  ${label.padEnd(10)} ${'█'.repeat(Math.round(40 * n / waits.length)).padEnd(40)} ${String(n).padStart(4)}  ${pct(n, waits.length)}`)
  }
  console.log(`\n  Toplam bekleme  : ${waits.length}`)
  console.log(`  >=10sn olanlar  : ${qualifying.length}  (${pct(qualifying.length, waits.length)})   ← ENVANTERIN GERCEK BOYUTU`)

  const byTool = {}
  for (const w of qualifying) byTool[w.tool] = (byTool[w.tool] ?? 0) + 1
  const top = Object.entries(byTool).sort((a, b) => b[1] - a[1]).slice(0, 5)
  if (top.length) console.log(`  En cok bekleten : ${top.map(([t, n]) => `${t}(${n})`).join(', ')}`)
}

/* ── 4. KRITIK: statusLine BEKLERKEN yenileniyor mu? ── */
H('4  statusLine bekleme sirasinda yenileniyor mu?   ← ACIK SORU #1')

if (!sl.length || !qualifying.length) {
  console.log('  Karar verilemedi — yeterli veri yok.')
} else {
  let withRefresh = 0, totalInside = 0
  for (const w of qualifying) {
    const inside = sl.filter((r) => r.ts > w.start + 500 && r.ts < w.end - 500).length
    totalInside += inside
    if (inside > 0) withRefresh++
  }
  const ratio = withRefresh / qualifying.length
  console.log(`  >=10sn beklemelerin ${pct(withRefresh, qualifying.length)}'inde statusLine yenilendi`)
  console.log(`  Bekleme basina ortalama yenileme: ${(totalInside / qualifying.length).toFixed(1)}`)
  console.log()
  if (ratio > 0.8) {
    console.log('  ✓ SONUC: refreshInterval calisiyor. 10sn kurali ve sure olcumu')
    console.log('    statusLine uzerinden yapilabilir. ADR-001 dogrulandi.')
  } else if (ratio > 0.2) {
    console.log('  ⚠ SONUC: kismen yenileniyor. refreshInterval degerini dusur ve tekrar ol.')
  } else {
    console.log('  ✗ SONUC: BEKLERKEN YENILENMIYOR. Sure olcumu hook\'lara devredilmeli')
    console.log('    (Pre/PostToolUse zaman farki), statusLine sadece render olur.')
    console.log('    ADR-001 ve ADR-003 buna gore revize edilecek.')
  }
}

/* ── 5. para ── */
H('5  $/gelistirici/ay projeksiyonu   ← §12.1 BITTI KRITERI')

if (!waits.length) {
  console.log('  Hesaplanamadi.')
} else {
  const spanH = (Math.max(sl.at(-1)?.ts ?? 0, hooks.at(-1)?._ts ?? 0)
               - Math.min(sl[0]?.ts ?? Infinity, hooks[0]?._ts ?? Infinity)) / 3_600_000
  const perHour = qualifying.length / Math.max(spanH, 0.01)

  console.log(`  Olcum suresi          : ${spanH.toFixed(2)} saat`)
  console.log(`  Nitelikli gosterim/sa : ${perHour.toFixed(1)}`)
  console.log()
  console.log('  Gunluk aktif kodlama saatine gore aylik kazanc (22 is gunu, %50 pay):')
  console.log()
  console.log('    saat/gun │  CPM $10    CPM $20    CPM $30')
  console.log('    ─────────┼──────────────────────────────────')
  for (const hpd of [2, 4, 6, 8]) {
    const impMonth = perHour * hpd * 22
    const row = [10, 20, 30].map((cpm) => `$${(impMonth * cpm / 1000 * 0.5).toFixed(2)}`.padStart(9)).join(' ')
    console.log(`    ${String(hpd).padStart(6)}   │ ${row}   (${Math.round(impMonth)} gosterim)`)
  }
  console.log()
  console.log('  Referans: gozlenen piyasada terminal CPM tabani ~$31, tepe teklif ~$111.')
  console.log('  Bu tablodaki sayilar $2/ay civarinda kaliyorsa degistirilecek olan')
  console.log('  10sn kurali degil, IS MODELIDIR (§12.1).')
}

/* ── kaydet ── */
const report = { generatedAt: new Date().toISOString(), statusLineCalls: sl.length, hookEvents: hooks.length, waits: waits.length, qualifying: qualifying.length, waitsRaw: waits }
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2))
console.log(`\n  Ham veri: ${join(OUT, 'report.json')}`)
console.log('  Bu ciktiyi PROJECT.md §12.1 altina tablo olarak yapistir.\n')
