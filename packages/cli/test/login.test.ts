/**
 * `dwell login` — yerel imzalama akisi.
 *
 * Test edilen sey "tarayici acildi mi" degil; yerel sunucunun DISARIYA ne
 * verdigi. Bu surec kisa omurlu ama makinede bir port aciyor: ne servis
 * ettigi, kime servis ettigi ve neyi geri vermedigi onemli.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runLoginServer, parseLoginArgs } from '../src/cli/login.js'
import { saveCredentials, loadCredentials, clearCredentials } from '../src/credentials.js'

const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'dwell-login-'))
  dirs.push(d)
  return d
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

const GOOD = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF5'

/** Dwell sunucusunu taklit eder — cagrilari kaydeder. */
function fakeServer(over: { verify?: unknown; verifyStatus?: number } = {}) {
  const calls: { path: string; body: any }[] = []
  const impl = (async (url: any, init: any) => {
    const path = String(url)
    const body = JSON.parse(String(init.body))
    calls.push({ path, body })
    if (path.endsWith('/v1/auth/challenge')) {
      return new Response(JSON.stringify({
        transaction: 'AAAAfake', network_passphrase: 'Test SDF Network ; September 2015', expiresAt: 9e12,
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(
      JSON.stringify(over.verify ?? { token: 'dwl_gizli_token', tokenId: 't1', publisherId: GOOD }),
      { status: over.verifyStatus ?? 200, headers: { 'content-type': 'application/json' } },
    )
  }) as unknown as typeof fetch
  return { impl, calls }
}

/** Tarayicinin yapacagini yapar: sayfayi al, nonce ile POST at. */
async function browse(url: string) {
  const page = await fetch(url)
  const html = await page.text()
  const nonce = /const NONCE = "([0-9a-f]+)"/.exec(html)?.[1]
  // DIKKAT: varsayilan parametre `undefined`'da devreye girer. Nonce'suz
  // istegi test edebilmek icin acik bir `null` gerekiyor — bu tam olarak
  // testi ilk yazdigimda dusurdugum tuzak: `undefined` gecince nonce YINE
  // gidiyordu ve test guvenligi degil kendini dogruluyordu.
  const post = (path: string, body: unknown, useNonce: string | null | undefined = nonce) =>
    fetch(url.replace(/\/$/, '') + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(useNonce ? { 'x-dwell-nonce': useNonce } : {}) },
      body: JSON.stringify(body),
    })
  return { html, nonce, post, status: page.status }
}

/** Sunucuyu baslatir ve URL'sini verir — `openImpl` tarayici yerine gecer. */
function start(fetchImpl: typeof fetch) {
  let resolveUrl!: (u: string) => void
  const url = new Promise<string>((r) => { resolveUrl = r })
  const done = runLoginServer({
    serverUrl: 'https://api.example.test',
    fetchImpl,
    openImpl: (u) => resolveUrl(u),
  })
  // Reddedilirse test cokmesin; bilerek bitmeyen testler var.
  done.catch(() => {})
  return { url, done }
}

describe('runLoginServer', () => {
  it('imzalanmis XDR dogrulanınca token doner', async () => {
    const srv = fakeServer()
    const { url, done } = start(srv.impl)
    const u = await url

    const b = await browse(u)
    expect(b.status).toBe(200)
    expect(b.nonce).toMatch(/^[0-9a-f]{32}$/)

    await b.post('/challenge', { address: GOOD })
    const vr = await b.post('/verify', { address: GOOD, transaction: 'AAAAsigned' })
    expect(vr.status).toBe(200)

    const result = await done
    expect(result.token).toBe('dwl_gizli_token')
    expect(result.publisherId).toBe(GOOD)
    expect(srv.calls.map((c) => c.path.split('/v1')[1])).toEqual(['/auth/challenge', '/auth/verify'])
  })

  /**
   * En onemlisi. Sayfa tarayicida calisiyor; token'i oraya gondermek onu
   * eklentilerin, gecmisin ve kopyala-yapistir kazalarinin menziline sokardi.
   * Tarayicinin token'i BILMESI GEREKMIYOR — yalnizca CLI'nin bilmesi lazim.
   */
  it('token TARAYICIYA geri gonderilmez', async () => {
    const srv = fakeServer()
    const { url, done } = start(srv.impl)
    const b = await browse(await url)

    const vr = await b.post('/verify', { address: GOOD, transaction: 'AAAAsigned' })
    const body = await vr.text()

    expect(body).not.toContain('dwl_gizli_token')
    expect(JSON.parse(body)).toEqual({ publisherId: GOOD })
    expect((await done).token).toBe('dwl_gizli_token')     // CLI biliyor
  })

  it('nonce\'suz istek reddedilir', async () => {
    const srv = fakeServer()
    const { url } = start(srv.impl)
    const b = await browse(await url)

    const r = await b.post('/verify', { address: GOOD, transaction: 'x' }, null)
    expect(r.status).toBe(403)
    expect(srv.calls).toHaveLength(0)          // Dwell sunucusuna hic gidilmedi
  })

  it('yanlis nonce reddedilir', async () => {
    const srv = fakeServer()
    const { url } = start(srv.impl)
    const b = await browse(await url)

    const r = await b.post('/challenge', { address: GOOD }, 'f'.repeat(32))
    expect(r.status).toBe(403)
    expect(srv.calls).toHaveLength(0)
  })

  it('yalnizca 127.0.0.1 dinlenir — ag uzerinden erisilemez', async () => {
    const srv = fakeServer()
    const { url } = start(srv.impl)
    const u = await url
    expect(u).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
    expect(u).not.toContain('0.0.0.0')
  })

  it('sunucu dogrulamayi reddederse akis bitmez, hata sayfaya doner', async () => {
    const srv = fakeServer({ verify: { code: 'DWL_2002', message: 'imza dogrulanamadi' }, verifyStatus: 401 })
    const { url, done } = start(srv.impl)
    const b = await browse(await url)

    const r = await b.post('/verify', { address: GOOD, transaction: 'kotu' })
    expect(r.status).toBe(401)

    // Sunucu HALA acik: kullanici tekrar deneyebilmeli. Ilk hatada kapatmak,
    // yanlis cuzdani secen birini bastan basa zorlardi.
    const ikinci = await b.post('/challenge', { address: GOOD })
    expect(ikinci.status).toBe(200)

    let bitti = false
    void done.then(() => { bitti = true }, () => { bitti = true })
    await new Promise((r2) => setTimeout(r2, 30))
    expect(bitti).toBe(false)
  })

  it('sayfa disariya baglanti kuramaz (CSP)', async () => {
    const { url } = start(fakeServer().impl)
    const res = await fetch(await url)
    const csp = res.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("connect-src 'self'")
    await res.text()
  })

  it('devasa govde bellegi doldurmaz', async () => {
    const srv = fakeServer()
    const { url } = start(srv.impl)
    const b = await browse(await url)
    const r = await b.post('/challenge', { address: 'x'.repeat(300_000) })
    expect(r.status).toBe(500)
    expect(srv.calls).toHaveLength(0)
  })

  it('GET disi ve bilinmeyen yollar 404', async () => {
    const { url } = start(fakeServer().impl)
    const u = await url
    expect((await fetch(u + 'baska')).status).toBe(404)
  })
})

describe('parseLoginArgs', () => {
  it('--server bayragi ortam degiskenini ezer', () => {
    process.env['DWELL_SERVER'] = 'https://ortam.test'
    expect(parseLoginArgs(['--server', 'https://bayrak.test']).serverUrl).toBe('https://bayrak.test')
    expect(parseLoginArgs([]).serverUrl).toBe('https://ortam.test')
    delete process.env['DWELL_SERVER']
  })

  it('sondaki slash temizlenir — yoksa `//v1/...` olusur', () => {
    expect(parseLoginArgs(['--server', 'https://a.test///']).serverUrl).toBe('https://a.test')
  })

  it('--no-browser taninir', () => {
    expect(parseLoginArgs(['--no-browser']).noBrowser).toBe(true)
  })
})

describe('credentials', () => {
  it('dosya yalnizca sahibi tarafindan okunabilir (0600)', () => {
    const p = join(tmp(), 'creds.json')
    saveCredentials({ serverUrl: 'https://a.test', token: 'dwl_x', publisherId: GOOD, tokenId: 't', loggedInAt: 1 }, p)
    expect(statSync(p).mode & 0o777).toBe(0o600)
    expect(readFileSync(p, 'utf8')).toContain('dwl_x')
  })

  it('eksik alanli dosya "giris yapilmamis" sayilir', () => {
    const p = join(tmp(), 'creds.json')
    saveCredentials({ serverUrl: 'https://a.test', token: '', publisherId: GOOD, tokenId: 't', loggedInAt: 1 }, p)
    expect(loadCredentials(p)).toBeNull()
  })

  it('bozuk JSON cokmez, null doner', () => {
    const d = tmp()
    const p = join(d, 'creds.json')
    require('node:fs').writeFileSync(p, '{ yarim')
    expect(loadCredentials(p)).toBeNull()
  })

  it('olmayan dosya null doner, silme false', () => {
    const p = join(tmp(), 'yok.json')
    expect(loadCredentials(p)).toBeNull()
    expect(clearCredentials(p)).toBe(false)
  })

  it('gidis donus bozulmaz', () => {
    const p = join(tmp(), 'creds.json')
    const c = { serverUrl: 'https://a.test', token: 'dwl_x', publisherId: GOOD, tokenId: 't1', loggedInAt: 42 }
    saveCredentials(c, p)
    expect(loadCredentials(p)).toEqual(c)
    expect(clearCredentials(p)).toBe(true)
    expect(loadCredentials(p)).toBeNull()
  })
})
