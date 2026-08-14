/**
 * Daemon yasam dongusu — baslat, durdur, canli mi.
 *
 * Daemon arka planda ayri bir surec olarak calisir ve terminal kapansa bile
 * yasar. Bu yuzden pidfile ve detached spawn.
 */

import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { connect } from 'node:net'
import { encode, type Request, type Response } from '../ipc.js'

/**
 * Yollar CAGRI ANINDA hesaplanir, modul yuklenirken degil.
 *
 * Modul seviyesinde sabitlemek env degiskenlerini import aninda dondurur;
 * hem test edilemez hale gelir hem de `DWELL_HOME`'u sonradan degistiren
 * her cagiran sessizce yanlis dizine yazar.
 */
const home = (): string =>
  process.env['DWELL_HOME'] ?? join(process.env['HOME'] ?? '', '.dwell')

export const pidPath = (): string => join(home(), 'daemon.pid')
export const logPath = (): string => join(home(), 'daemon.log')
const defaultSocket = (): string => process.env['DWELL_SOCKET'] ?? join(home(), 'dwelld.sock')

/**
 * Daemon ayakta mi?
 *
 * Pidfile'a GUVENMIYORUZ: surec carpmis olabilir ve dosya kalmis olabilir.
 * Tek gecerli kanit soketten cevap gelmesi.
 */
export async function isAlive(socketPath = defaultSocket(), timeoutMs = 1_000): Promise<boolean> {
  return (await ask({ t: 'health' }, socketPath, timeoutMs)) !== null
}

export function ask(req: Request, socketPath = defaultSocket(), timeoutMs = 2_000): Promise<Response | null> {
  return new Promise((resolve) => {
    const sock = connect(socketPath)
    let settled = false
    const done = (v: Response | null) => {
      if (settled) return
      settled = true
      sock.destroy()
      resolve(v)
    }

    sock.setTimeout(timeoutMs, () => done(null))
    sock.on('error', () => done(null))

    // 'close' ve 'end' ELE ALINMAK ZORUNDA.
    //
    // Daemon'a SIGTERM gonderdikten hemen sonra baglanti kurulabiliyor ama
    // daemon cevap veremeden soketi kapatiyor. O durumda 'error' ATESLENMEZ,
    // yalnizca 'close' gelir. Dinlemezsek promise hicbir zaman cozulmez;
    // soket de kapali oldugu icin event loop'u tutan bir sey kalmaz ve Node
    // ISINI BITIRMEDEN, kod 0 ile sessizce cikar.
    //
    // Belirtisi: `dwell uninstall` banner'i basip duruyordu, ayarlar
    // silinmiyordu, cikis kodu 0'di. Ucte bir tekrarlanan bir yaristi.
    sock.on('close', () => done(null))
    sock.on('end', () => done(null))

    sock.on('connect', () => sock.write(encode(req)))
    let buf = ''
    sock.on('data', (d) => {
      buf += d.toString('utf8')
      const nl = buf.indexOf('\n')
      if (nl === -1) return
      try { done(JSON.parse(buf.slice(0, nl)) as Response) } catch { done(null) }
    })
  })
}

export interface StartOptions {
  readonly entry: string
  readonly env?: Record<string, string>
  readonly waitMs?: number
}

/** Daemon'i arka planda baslatir ve ayaga kalkmasini bekler. */
export async function start(opts: StartOptions): Promise<{ pid: number } | { error: string }> {
  if (await isAlive()) return { error: 'daemon zaten calisiyor' }

  mkdirSync(home(), { recursive: true, mode: 0o700 })
  // Log dosyasina yaz: detached surecin ciktisi kaybolmasin, `dwell doctor`
  // sorun cikinca buraya baksin.
  const logFd = openSync(logPath(), 'a', 0o600)

  const child = spawn(process.execPath, [opts.entry], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, ...opts.env },
  })
  child.unref()
  if (child.pid === undefined) return { error: 'surec baslatilamadi' }

  // Ayaga kalkmasini bekle — hemen doner ve "kuruldu" dersek, kullanici
  // calismayan bir daemon'la kalir.
  const deadline = Date.now() + (opts.waitMs ?? 5_000)
  while (Date.now() < deadline) {
    if (await isAlive()) {
      // Pidfile ANCAK daemon cevap verdikten sonra yazilir.
      //
      // Once yazmak TEHLIKELI: baslatma basarisiz olursa dosyada olu bir pid
      // kalir, isletim sistemi o pid'i baska bir surece yeniden atar ve
      // `dwell uninstall` masum bir sureci oldurur.
      writeFileSync(pidPath(), String(child.pid), { mode: 0o600 })
      return { pid: child.pid }
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  // Basarisiz baslatmadan geriye pidfile BIRAKMIYORUZ.
  try { unlinkSync(pidPath()) } catch { /* zaten yok */ }
  return { error: `daemon ${opts.waitMs ?? 5000}ms icinde yanit vermedi — ${logPath()}` }
}

/**
 * Daemon'i durdurur.
 *
 * ASLA pidfile'daki sayiya korlemesine `kill` gonderilmez. Pid geri
 * donusumludur: olu bir pid'i oldurmeye calismak, o numarayi devralmis
 * masum bir sureci oldurmek demektir.
 *
 * Bu yuzden once sokete soruyoruz. Cevap gelmiyorsa oldurulecek bir sey
 * yoktur; yalnizca bayat pidfile temizlenir.
 */
export async function stop(): Promise<boolean> {
  if (!(await isAlive())) {
    try { unlinkSync(pidPath()) } catch { /* yok */ }
    return false
  }

  // Pid'i DAEMON'IN KENDISINDEN aliyoruz, dosyadan degil.
  const health = await ask({ t: 'health' })
  const pid = health?.t === 'health' ? health.info.pid : readPid()
  if (pid === null || pid === undefined) return false

  try { process.kill(pid, 'SIGTERM') } catch { /* zaten olmus */ }

  for (let i = 0; i < 30; i++) {
    if (!(await isAlive())) break
    await new Promise((r) => setTimeout(r, 100))
  }
  try { unlinkSync(pidPath()) } catch { /* yok */ }
  return true
}

export function readPid(): number | null {
  if (!existsSync(pidPath())) return null
  const n = Number(readFileSync(pidPath(), 'utf8').trim())
  return Number.isInteger(n) && n > 0 ? n : null
}
