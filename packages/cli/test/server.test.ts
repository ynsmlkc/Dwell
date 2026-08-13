import { describe, it, expect, afterEach } from 'vitest'
import { connect } from 'node:net'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startSocketServer, type SocketServer } from '../src/daemon/server.js'
import { encode, type Request, type Response } from '../src/ipc.js'

let server: SocketServer | null = null
let dir: string

const newDir = () => (dir = mkdtempSync(join(tmpdir(), 'dwell-test-')))

afterEach(async () => {
  await server?.close()
  server = null
  if (dir) rmSync(dir, { recursive: true, force: true })
})

/** Shim'in yaptigini yapar: bagla, gonder, tek satir cevap oku. */
function ask(path: string, req: Request, timeoutMs = 1_000): Promise<Response | null> {
  return new Promise((resolve) => {
    const c = connect(path)
    const done = (v: Response | null) => { c.destroy(); resolve(v) }
    c.setTimeout(timeoutMs, () => done(null))
    c.on('error', () => done(null))
    c.on('connect', () => c.write(encode(req)))
    let buf = ''
    c.on('data', (d) => {
      buf += d.toString()
      const nl = buf.indexOf('\n')
      if (nl !== -1) { try { done(JSON.parse(buf.slice(0, nl))) } catch { done(null) } }
    })
  })
}

describe('unix socket sunucusu', () => {
  it('istek/cevap calisir', async () => {
    const p = join(newDir(), 'd.sock')
    server = await startSocketServer(p, () => ({ t: 'ok' }))
    expect(await ask(p, { t: 'health' })).toEqual({ t: 'ok' })
  })

  it('soket 0600, dizin 0700 — baska kullanici baglanamaz', async () => {
    const p = join(newDir(), 'd.sock')
    server = await startSocketServer(p, () => ({ t: 'ok' }))
    expect(statSync(p).mode & 0o777).toBe(0o600)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
  })

  it('bozuk JSON baglantiyi dusurmez', async () => {
    const p = join(newDir(), 'd.sock')
    server = await startSocketServer(p, () => ({ t: 'ok' }))
    const res = await new Promise<Response | null>((resolve) => {
      const c = connect(p)
      let buf = ''
      c.on('connect', () => c.write('bu json degil\n'))
      c.on('data', (d) => {
        buf += d.toString()
        if (buf.includes('\n')) { c.destroy(); resolve(JSON.parse(buf.split('\n')[0]!)) }
      })
      c.on('error', () => resolve(null))
      setTimeout(() => { c.destroy(); resolve(null) }, 1000)
    })
    expect(res).toEqual({ t: 'error', code: 'DWL_9001' })
  })

  it('handler patlarsa baglanti olmez, hata cevabi doner', async () => {
    const p = join(newDir(), 'd.sock')
    server = await startSocketServer(p, () => { throw new Error('boom') }, () => {})
    expect(await ask(p, { t: 'health' })).toEqual({ t: 'error', code: 'DWL_9001' })
  })

  it('bayat soket dosyasi temizlenir — daemon carpmissa yeniden baslayabilmeli', async () => {
    const p = join(newDir(), 'd.sock')
    writeFileSync(p, '')                       // arkasinda dinleyen yok
    server = await startSocketServer(p, () => ({ t: 'ok' }))
    expect(await ask(p, { t: 'health' })).toEqual({ t: 'ok' })
  })

  it('canli daemon varken ikinci ornek REDDEDILIR', async () => {
    const p = join(newDir(), 'd.sock')
    server = await startSocketServer(p, () => ({ t: 'ok' }))
    await expect(startSocketServer(p, () => ({ t: 'ok' }))).rejects.toThrow(/zaten calisiyor/)
  })

  it('asiri buyuk istek baglantiyi keser — bellek doldurulamaz', async () => {
    const p = join(newDir(), 'd.sock')
    server = await startSocketServer(p, () => ({ t: 'ok' }))
    const closed = await new Promise<boolean>((resolve) => {
      const c = connect(p)
      c.on('connect', () => c.write('x'.repeat(100_000)))
      c.on('close', () => resolve(true))
      c.on('error', () => resolve(true))
      setTimeout(() => { c.destroy(); resolve(false) }, 2000)
    })
    expect(closed).toBe(true)
  })

  it('ardisik istekler ayni baglantida islenir', async () => {
    const p = join(newDir(), 'd.sock')
    let n = 0
    server = await startSocketServer(p, () => { n++; return { t: 'ok' } })
    await new Promise<void>((resolve) => {
      const c = connect(p)
      let lines = 0
      c.on('connect', () => c.write(encode({ t: 'health' }).repeat(3)))
      c.on('data', (d) => {
        lines += d.toString().split('\n').filter(Boolean).length
        if (lines >= 3) { c.destroy(); resolve() }
      })
    })
    expect(n).toBe(3)
  })
})
