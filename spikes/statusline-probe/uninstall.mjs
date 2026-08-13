#!/usr/bin/env node
/**
 * Kivilcim 1 — probe kaldirici.
 * settings.json'i yedekten BIREBIR geri yukler.
 *
 * Gercek `dwell uninstall` de bunu yapmak zorunda (§6.1 bitti kriteri):
 * kullanicinin ayarlari kurulum oncesi haline donmeli.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SETTINGS = join(homedir(), '.claude', 'settings.json')
const LATEST = join(HERE, 'out', 'settings.backup.latest.json')

if (!existsSync(LATEST)) {
  console.error(`✗ Yedek bulunamadi: ${LATEST}`)
  process.exit(1)
}

const backup = readFileSync(LATEST, 'utf8')
const current = readFileSync(SETTINGS, 'utf8')

writeFileSync(SETTINGS, backup)

const same = JSON.stringify(JSON.parse(backup)) === JSON.stringify(JSON.parse(current))
console.log(`✓ settings.json yedekten geri yuklendi.`)
console.log(same
  ? '  (Zaten ayniydi — degisiklik yoktu.)'
  : '  Probe ayarlari kaldirildi. Yeni bir oturumda dogrula.')
