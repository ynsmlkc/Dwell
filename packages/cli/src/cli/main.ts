#!/usr/bin/env node
/**
 * `dwell` — kullanicinin gordugu tek yuzey.
 *
 * Komutlar ince: butun mantik test edilmis modullerde. Buradaki is
 * dogrulama, sıralama ve ANLASILIR CIKTI.
 */

import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { install, uninstall, diagnose, readSettings, detectConflicts, SETTINGS_PATH } from '../settings.js'
import { DWELL_HOME, SOCKET_PATH } from '../ipc.js'
import * as daemon from './daemon-control.js'
import { out, ok, warn, info, fail, rows, dim, bold, green, yellow, red, orange, banner, usdc } from './output.js'
import { cmdLogin, cmdLogout, cmdWhoami } from './login.js'
import { cmdBalance } from './balance.js'
import { loadCredentials, shortAddress } from '../credentials.js'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * Paket kokunu ARAYARAK bul.
 *
 * Sabit bir `../..` yazmak kirilgan: kaynakta `src/cli/` icindeyiz ama
 * derlenince `dist/` oluyoruz ve seviye sayisi degisiyor. `package.json`'i
 * yukari dogru aramak her iki duzende de calisir.
 */
function findPkgRoot(from: string): string {
  let d = from
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(d, 'package.json'))) return d
    const up = dirname(d)
    if (up === d) break
    d = up
  }
  return resolve(from, '..')
}
const PKG_ROOT = findPkgRoot(HERE)

/** Derlenmis shim — TypeScript kaynagi DEGIL (ADR-003 olcumu). */
const shimPath = (): string => {
  const compiled = join(PKG_ROOT, 'dist', 'statusline.mjs')
  return existsSync(compiled) ? compiled : join(PKG_ROOT, 'src', 'shim', 'statusline.ts')
}
const hookPath = (): string => join(PKG_ROOT, 'dist', 'hook.mjs')
const daemonEntry = (): string => join(PKG_ROOT, 'dist', 'daemon.mjs')

const statusLineCommand = (): string => `${process.execPath} ${shimPath()}`

/* ─────────────────────────── komutlar ─────────────────────────── */

async function cmdInit(argv: string[]): Promise<void> {
  banner()
  const force = argv.includes('--force')
  const withSpinner = argv.includes('--spinner')

  // 1. Cakisma var mi? ONCE sor, sonra yaz.
  let settings
  try { settings = readSettings() } catch (e) {
    fail('DWL-1003', 'Claude Code ayar dosyasi okunamadi',
      `${SETTINGS_PATH} bozuk JSON olabilir. Duzeltince tekrar dene — dosyaya dokunmadik.`)
  }
  const conflicts = detectConflicts(settings).filter((c) => !c.ours)

  if (conflicts.length > 0 && !force) {
    warn('Mevcut ayarlarin var, uzerine YAZMADIK:')
    out()
    for (const c of conflicts) info(`${bold(c.field)}  ${dim(c.current)}`)
    out()
    info(`Yine de kurmak icin: ${bold('dwell init --force')}`)
    info(dim('(mevcut ayarin yedeklenir, `dwell uninstall` geri getirmez —'))
    info(dim(' yedek ~/.claude/dwell-backups/ altinda durur)'))
    out()
  }

  // 2. settings.json
  const result = install({
    statusLineCommand: statusLineCommand(),
    hookCommand: `${process.execPath} ${hookPath()}`,
    refreshIntervalSec: 1,
    ...(withSpinner ? { spinnerVerbs: ['✶ Dwell'] } : {}),
    force,
  })

  for (const f of result.changed) ok(`${f} kuruldu`)
  if (result.backupPath) info(dim(`yedek: ${result.backupPath}`))

  // 3. Daemon
  out()
  const started = await daemon.start({ entry: daemonEntry() })
  if ('error' in started) {
    if (started.error.includes('zaten')) ok('daemon zaten calisiyor')
    else fail('DWL-1001', 'Daemon baslatilamadi', started.error)
  } else {
    ok(`daemon calisiyor (pid ${started.pid})`)
  }

  // 4. Giris yapilmadiysa BUNU SOYLE.
  //
  // Sunucu bagli degilken daemon icine gomulu ornek reklamlari gosteriyor.
  // Ekranda her sey calisiyor gorunuyor ama hicbir gosterim hicbir yere
  // yazilmiyor. Bunu sessiz gecmek, kullaniciyi kazandigini SANARAK
  // beklemeye birakmak olurdu.
  if (!loadCredentials()) {
    out()
    warn(`${bold('demo modu')} — cuzdan bagli degil, ${bold('kazanc yok')}`)
    info(dim('gosterdigin reklamlar ornek; hicbir yere kaydedilmiyor'))
    info(`gercekten kazanmak icin: ${bold('dwell login')}`)
  }

  // 5. Ne degistigini SOYLE — kullanicidan bir sey aldik.
  out()
  out(`  ${bold('Bilmen gerekenler')}`)
  info('• Claude Code, alt satirdaki bazi klavye ipuclarini artik gostermiyor')
  info(`  (${dim('esc to interrupt')} gibi) — custom statusLine tanimliyken oluyor`)
  if (withSpinner) info('• Spinner kelimeleri degisti')
  info(`• Geri almak: ${bold('dwell uninstall')} — kendi izimizi sileriz, senin ayarlarina dokunmayiz`)
  out()
  info(`Yeni bir Claude Code oturumu ac. ${dim('Beklerken alt satirda gorunecek.')}`)
  out()
}

async function cmdDoctor(): Promise<void> {
  banner()
  const expected = statusLineCommand()
  const d = diagnose(expected)
  const alive = await daemon.isAlive()
  const health = alive ? await daemon.ask({ t: 'health' }) : null

  const checks: [string, boolean, string][] = [
    ['settings.json', d.installed, d.detail],
    ['daemon', alive, alive ? `pid ${daemon.readPid() ?? '?'}` : 'calismiyor — `dwell init`'],
    ['socket', existsSync(SOCKET_PATH), SOCKET_PATH],
    ['shim', existsSync(shimPath()), shimPath().endsWith('.ts')
      ? 'TypeScript kaynagi — derlenmis surum daha hizli' : 'derlenmis'],
    ['spinner', d.spinnerOwner !== 'baskasinin', d.spinnerDetail ?? 'kurulu degil'],
  ]

  for (const [name, good, detail] of checks) {
    out(`  ${good ? green('✓') : red('✗')} ${bold(name.padEnd(14))} ${dim(detail)}`)
  }

  if (d.spinnerOwner === 'baskasinin') {
    out()
    warn('spinnerVerbs BASKA BIR ARACA ait — spinner senkronu sessizce kapali.')
    info('Kullanicinin ayarini ezmeme kurali geregi dokunmuyoruz. Ayni yuzeyi')
    info('kullanan baska bir eklenti kurulu olabilir; bazilari saniyeler icinde')
    info('kendi degerini geri yaziyor, yani `--force` de kalici olmaz.')
    info('Once o araci kaldir, sonra `dwell init --spinner`.')
  }

  if (d.hijacked) {
    out()
    warn('statusLine ayarin BASKA BIR ARAC tarafindan degistirilmis.')
    info('Ayni satiri kullanan baska bir eklenti kurulu olabilir; bazilari')
    info('periyodik olarak kendi ayarini geri koyuyor.')
    info(`Tekrar kurmak icin: ${bold('dwell init --force')}`)
  }

  if (health?.t === 'health') {
    out()
    const i = health.info
    rows([
      ['durum', i.phase],
      ['kuyrukta', `${i.queuedImpressions} gosterim`],
      ['reklam', `${i.adsCached} adet onbellekte`],
      ['render', i.renderEnabled ? 'acik' : 'kapali'],
      ...(i.paused ? [['duraklatildi', 'evet — `dwell resume`'] as const] : []),
      ...(i.lastError ? [['son hata', i.lastError] as const] : []),
    ])
  }
  out()
}

async function cmdUninstall(): Promise<void> {
  banner()
  await daemon.stop()
  ok('daemon durduruldu')

  const r = uninstall()
  if (r.removed.length === 0) warn('settings.json\'da bize ait bir ayar bulunamadi')
  for (const f of r.removed) ok(`${f} kaldirildi`)
  if (r.backupPath) info(dim(`yedek: ${r.backupPath}`))

  out()
  info('Senin diger ayarlarina dokunulmadi.')
  info(`Kazancin duruyor — ${bold('dwell init')} ile geri donebilirsin.`)
  out()
}

async function cmdStatus(): Promise<void> {
  banner()
  const health = await daemon.ask({ t: 'health' })
  if (health === null || health.t !== 'health') {
    fail('DWL-1001', 'Daemon calismiyor', '`dwell init` ile baslat')
  }
  const i = health.info
  rows([
    ['surum', i.version],
    ['durum', i.phase === 'idle' ? dim('bekliyor') : green(i.phase)],
    ['calisma suresi', `${Math.round(i.uptimeMs / 60_000)} dakika`],
    ['kuyrukta', `${i.queuedImpressions} gosterim`],
    ['aktif oturum', i.activeSession ?? dim('yok')],
  ])
  out()
}

async function cmdPause(paused: boolean): Promise<void> {
  const alive = await daemon.isAlive()
  if (!alive) fail('DWL-1001', 'Daemon calismiyor', '`dwell init` ile baslat')

  // Once GERCEKTEN durdur, sonra soyle.
  //
  // Onceden bu komut yalnizca mesaj basiyordu: kullanici duraklattigini
  // sanip reklamlar donmeye devam ediyordu. Bir arayuzun yapabilecegi en
  // kotu sey, olmayan bir seyi olmus gibi gostermek.
  const res = await daemon.ask({ t: 'pause', on: paused })
  if (!res || res.t !== 'ok') {
    fail('DWL-1001', paused ? 'Duraklatilamadi' : 'Devam ettirilemedi', 'daemon cevap vermedi')
  }

  out(paused ? `${yellow('⏸')} duraklatildi — reklam gosterilmeyecek` : `${green('▶')} devam ediyor`)
  if (paused) info(dim('kalici: yeniden baslatsan da duraklatilmis kalir · `dwell resume`'))
}

/**
 * Daemon'i durdurup yeniden baslatir.
 *
 * `dwell login` sonrasi gerekiyor: daemon token'i YALNIZCA acilista okuyor.
 * Bu komut olmadan kullanicinin "kapat ac" demesi gerekirdi ve `login`
 * ciktisi zaten `dwell restart` diyordu — olmayan bir komutu tarif eden
 * bir mesaj, hic mesaj olmamasindan kotu.
 */
async function cmdRestart(): Promise<void> {
  banner()
  const durdu = await daemon.stop()
  if (durdu) ok('daemon durduruldu')

  const started = await daemon.start({ entry: daemonEntry() })
  if ('error' in started) fail('DWL-1001', 'Daemon baslatilamadi', started.error)
  ok(`daemon calisiyor (pid ${started.pid})`)

  const creds = loadCredentials()
  if (creds) info(dim(`cuzdan ${shortAddress(creds.publisherId)}`))
  else info(dim('cuzdan bagli degil — `dwell login`'))
  out()
}

function cmdHelp(): void {
  banner()
  out(`  ${dim('AI kodlama araclarinin bekleme anlarini kazanca cevirir.')}`)
  out()
  rows([
    ['dwell init', 'kur ve baslat'],
    ['dwell login', 'cuzdanini bagla — kazanc buraya gider'],
    ['dwell balance', 'kazancini goster'],
    ['dwell whoami', 'bagli cuzdani goster'],
    ['dwell logout', 'cuzdan baglantisini kaldir'],
    ['dwell doctor', 'kurulumu tesh­is et'],
    ['dwell status', 'daemon durumu'],
    ['dwell restart', 'daemon\'i yeniden baslat'],
    ['dwell pause', 'reklami gecici durdur'],
    ['dwell resume', 'devam et'],
    ['dwell uninstall', 'kaldir — kendi izimizi sileriz'],
  ])
  out()
  rows([
    ['--force', 'mevcut ayarin uzerine yaz'],
    ['--spinner', 'spinner katmanini da kur'],
  ])
  out()
}

/* ─────────────────────────── giris ─────────────────────────── */

export async function main(argv: readonly string[]): Promise<void> {
  const [cmd = 'help', ...rest] = argv

  switch (cmd) {
    case 'init': return cmdInit(rest)
    case 'doctor': return cmdDoctor()
    case 'uninstall': return cmdUninstall()
    case 'status': return cmdStatus()
    case 'restart': return cmdRestart()
    case 'pause': return cmdPause(true)
    case 'resume': return cmdPause(false)
    case 'login': return cmdLogin(rest)
    case 'logout': return cmdLogout()
    case 'whoami': return cmdWhoami()
    case 'balance': return cmdBalance(rest)
    case 'help': case '--help': case '-h': return cmdHelp()
    default:
      fail('DWL-9001', `bilinmeyen komut: ${cmd}`, '`dwell help` ile komutlari gor')
  }
}

// Dogrudan calistirildiysa
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    // Stack trace ASLA kullaniciya gitmez.
    fail('DWL-9001', 'Beklenmeyen hata', e instanceof Error ? e.message : String(e))
  })
}
