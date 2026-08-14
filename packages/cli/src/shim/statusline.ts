#!/usr/bin/env node
/**
 * statusLine shim — Claude Code'un `settings.json`'dan cagirdigi program.
 *
 * Gunde ~13.700 kez calisiyor (olcum: §12.2). Bu yuzden:
 *
 *   • `@dwell/protocol` IMPORT EDILMEZ — zod'u her tikta yuklemek israf.
 *     Yalnizca `node:net`. Butun is daemon'da.
 *   • Toplam butce 50ms. Asarsa BOS doner.
 *   • Daemon yoksa, socket yoksa, cevap gecikirse: **hicbir sey basmaz.**
 *     Hata mesaji da basmaz. Sessizlik dogru davranistir (ADR-003).
 *   • Cikis kodu her zaman 0. Claude Code'u asla bozmaz.
 *
 * Bos cikti = satir yok. Reklam yalnizca aktif tur icinde gelir (ADR-023).
 */

import { connect } from 'node:net'
import { writeSync } from 'node:fs'
import { termShape } from './term-shape.js'

const SOCKET = process.env['DWELL_SOCKET']
  ?? `${process.env['DWELL_HOME'] ?? `${process.env['HOME']}/.dwell`}/dwelld.sock`
const BUDGET_MS = Number(process.env['DWELL_BUDGET_MS'] ?? 50) || 50

/** Ne olursa olsun sessizce cik. */
function silent(): never {
  process.exit(0)
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

function main(): void {
  const timer = setTimeout(silent, BUDGET_MS)
  timer.unref()

  void readStdin().then((raw) => {
    let session = '?'
    try {
      const j = JSON.parse(raw) as { session_id?: string }
      if (typeof j.session_id === 'string') session = j.session_id
    } catch { /* payload bozuksa yine de dene */ }

    const columns = Number(process.env['COLUMNS'] ?? 80) || 80

    const sock = connect(SOCKET)
    sock.setNoDelay(true)
    sock.on('error', silent)          // daemon yok → sessizlik
    sock.on('timeout', silent)
    sock.setTimeout(BUDGET_MS)

    sock.on('connect', () => {
      sock.write(JSON.stringify({ t: 'tick', session, columns, shape: termShape() }) + '\n')
    })

    let buf = ''
    sock.on('data', (d) => {
      buf += d.toString('utf8')
      const nl = buf.indexOf('\n')
      if (nl === -1) return
      clearTimeout(timer)
      try {
        const res = JSON.parse(buf.slice(0, nl)) as { t?: string; line?: string }
        // Bos satir da gecerli bir cevaptir: "su an gosterme."
        if (res.t === 'render' && typeof res.line === 'string' && res.line !== '') {
          // `writeSync(1, ...)` — `process.stdout.write` DEGIL.
          //
          // statusLine ciktisi her zaman bir pipe'a gider ve pipe uzerinde
          // `process.stdout.write` ASENKRONDUR. Hemen ardindan gelen
          // `process.exit()` bekleyen chunk'lari duserir.
          //
          // Kisa satirlar pipe buffer'ina sigdigi icin pratikte calisir;
          // uzun bir satirda (genis terminal + uzun URL) YUK ALTINDA
          // RASTGELE kaybolur. Ayiklanmasi en zor hata sinifi: her seferinde
          // degil, bazen.
          writeSync(1, res.line)
        }
      } catch { /* bozuk cevap → sessizlik */ }
      sock.destroy()
      process.exit(0)
    })
  }).catch(silent)
}

main()
