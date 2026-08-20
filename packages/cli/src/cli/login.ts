/**
 * `dwell login` / `logout` / `whoami` — ADR-010 (revize), ADR-014.
 *
 * Kimlik cuzdandir. GitHub yok, e-posta yok, sifre yok. `publisherId` dogrudan
 * Stellar adresinin kendisi: kazanci alacak adres ile kimlik ayni sey, ikisini
 * ayirmak gereksiz bir eslesme katmani olurdu.
 *
 * Akis:
 *   dwell login  → 127.0.0.1'de gecici sunucu + tarayici
 *   tarayici     → Freighter/LOBSTR ile imza
 *   yerel sunucu → Dwell sunucusuna proxy, token'i diske yazar
 *
 * Ozel anahtar HICBIR ZAMAN bu surece girmez. Terminale secret key sordurmak
 * en kolay yoldu ve kabul edilemezdi: kullanicidan cuzdanini teslim etmesini
 * isteyen bir arac, ne kadar iyi niyetli olursa olsun, phishing'i normallestirir.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  loadCredentials, saveCredentials, clearCredentials, credentialsPath, shortAddress,
} from '../credentials.js'
import { out, ok, warn, info, fail, dim, bold, green, orange } from './output.js'
import { loginPage } from './login-page.js'

const LOGIN_TIMEOUT_MS = 5 * 60_000

/**
 * Sunucu adresi.
 *
 * Kendi alan adimiz yok; barindiran platformun verdigi adres bu. Yayina
 * cikmadan once `api.dwell.dev` yaziyordu ve o adres HIC VAR OLMADI —
 * paket boyle yayinlansaydi `dwell login` herkeste "sunucuya ulasilamadi"
 * derdi ve kimse sebebini bulamazdi.
 *
 * Alan adi alindiginda burasi degisir; `--server` ile de ezilebiliyor.
 */
const DEFAULT_SERVER = 'https://dwellserver-production.up.railway.app'

/** Trustline kontrolu icin. Odeme rayiyla ayni varlik. */
const HORIZON = process.env['DWELL_HORIZON'] ?? 'https://horizon-testnet.stellar.org'
const USDC_ISSUER = process.env['DWELL_ASSET_ISSUER']
  ?? 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'

export interface LoginOptions {
  readonly serverUrl: string
  /** Tarayici acilmasin — CI ve baglantisiz ortamlar icin. */
  readonly noBrowser?: boolean
  readonly openImpl?: (url: string) => void
  readonly fetchImpl?: typeof fetch
}

export function parseLoginArgs(argv: readonly string[]): LoginOptions {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 ? argv[i + 1] : undefined
  }
  return {
    serverUrl: (flag('server') ?? process.env['DWELL_SERVER'] ?? DEFAULT_SERVER)
      .replace(/\/+$/, ''),
    noBrowser: argv.includes('--no-browser'),
  }
}

/* ─────────────────────────── login ─────────────────────────── */

/**
 * Giristen sonra daemon'i yeni kimlikle yeniden baslatan islev.
 *
 * Disaridan veriliyor cunku daemon'in dosya yolunu `main.ts` cozuyor;
 * burada cozmeye kalkmak iki yerde ayni mantigi tutmak olurdu.
 */
export type DaemonYeniden = () => Promise<{ pid: number } | { error: string } | null>

export async function cmdLogin(
  argv: readonly string[],
  daemonYeniden?: DaemonYeniden,
): Promise<void> {
  const opts = parseLoginArgs(argv)
  const existing = loadCredentials()
  if (existing && !argv.includes('--force')) {
    warn(`zaten giris yapilmis: ${bold(shortAddress(existing.publisherId))}`)
    info(`baska bir cuzdana gecmek icin ${dim('dwell login --force')}`)
    return
  }

  const result = await runLoginServer(opts)
  saveCredentials({
    serverUrl: opts.serverUrl,
    token: result.token,
    tokenId: result.tokenId,
    publisherId: result.publisherId,
    loggedInAt: Date.now(),
  })

  out()
  ok(`giris yapildi — ${bold(result.publisherId)}`)
  info(dim(`token ${credentialsPath()} icinde (yalnizca sen okuyabilirsin)`))
  out()
  info(`kazanc bu adrese gidecek. ${dim('dwell balance')} ile takip et.`)

  /**
   * Daemon'i BIZ yeniden baslatiyoruz.
   *
   * Kimlik dosyadan yalnizca ACILISTA okunuyor. Onceden burada "daemon
   * calisiyorsa `dwell restart` yap" diye bir dipnot vardi ve bu YETMIYOR:
   * kullanici cuzdanini degistirip yeniden giris yapiyor, ekranda "giris
   * yapildi" goruyor, reklam donmeye devam ediyor — ama kazanc ESKI
   * cuzdana yaziliyor. Fark etmesinin bir yolu yok.
   *
   * Kullaniciya birakilan bir adim degil; sessizce yanlis hesaba para
   * yazan bir durum. O yuzden otomatik.
   */
  if (daemonYeniden) await kimligiTazele(daemonYeniden)
}

/**
 * Daemon'i yeni kimlikle yeniden baslatir ve sonucu kullaniciya bildirir.
 *
 * Ayri islev cunku `cmdLogin`'in tamami tarayici ve yerel sunucu
 * gerektiriyor; bu davranisin kendisi ise tek basina test edilebilmeli.
 */
export async function kimligiTazele(daemonYeniden: DaemonYeniden): Promise<void> {
  const r = await daemonYeniden()
  if (r === null) return                      // daemon zaten calismiyordu

  if ('error' in r) {
    // Basarisizlik SESSIZ GECILMEZ: kullanici ne yapacagini bilmeli, cunku
    // bu haliyle kazanci eski cuzdana yazilmaya devam eder.
    out()
    warn('daemon yeni kimlikle yeniden baslatilamadi')
    info(dim(r.error))
    info(`elle: ${bold('dwell restart')} — bunu yapmadan kazanc ESKI cuzdana yazilir`)
    return
  }
  ok(`daemon yeni kimlikle calisiyor (pid ${r.pid})`)
}

interface LoginResult {
  readonly token: string
  readonly tokenId: string
  readonly publisherId: string
}

/**
 * Tek kullanimlik yerel sunucu.
 *
 * Yalnizca 127.0.0.1'e baglanir — `0.0.0.0` olsa ayni agdaki herkes bu
 * sayfayi acip kendi cuzdanini baglayabilirdi. Ayrica her istek `nonce`
 * tasimak zorunda: makinede calisan baska bir program sayfanin adresini
 * tahmin etse bile isteklerini gecemez.
 */
export function runLoginServer(opts: LoginOptions): Promise<LoginResult> {
  const nonce = randomBytes(16).toString('hex')
  const f = opts.fetchImpl ?? fetch
  // Port isletim sisteminden geliyor (0 = bos bir tane ver). Sayfada
  // gostermek icin yakaliyoruz; istekler zaten `listen`'dan sonra geliyor.
  let port = 0

  return new Promise<LoginResult>((resolve, reject) => {
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // Sunucuyu kapatmadan once cevabin gitmesini bekle; hemen kapatirsak
      // tarayici "basarili" ekranini goremeden baglanti duser.
      setTimeout(() => server.close(), 150).unref()
      fn()
    }

    const timer = setTimeout(() => {
      finish(() => reject(new Error('sure doldu — tarayicida islem tamamlanmadi')))
    }, LOGIN_TIMEOUT_MS)
    timer.unref()

    const json = (res: ServerResponse, code: number, body: unknown): void => {
      const s = JSON.stringify(body)
      res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) })
      res.end(s)
    }

    const server = createServer((req, res) => {
      void handle(req, res).catch((e: unknown) => {
        json(res, 500, { message: e instanceof Error ? e.message : String(e) })
      })
    })

    async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
      const url = req.url ?? '/'

      if (req.method === 'GET' && (url === '/' || url.startsWith('/?'))) {
        const html = loginPage({ nonce, port })
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-length': Buffer.byteLength(html),
          // Sayfa disariya hicbir sey yukleyemez; token buradan sizamaz.
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; " +
            "script-src 'unsafe-inline'; connect-src 'self'",
          'cache-control': 'no-store',
        })
        res.end(html)
        return
      }

      if (req.method !== 'POST') { json(res, 404, { message: 'yok' }); return }
      if (req.headers['x-dwell-nonce'] !== nonce) { json(res, 403, { message: 'gecersiz oturum' }); return }

      const body = await readJson(req)

      if (url === '/challenge') {
        const r = await f(`${opts.serverUrl}/v1/auth/challenge`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ address: body?.['address'] }),
        })
        json(res, r.status, await r.json().catch(() => ({ message: 'sunucu cevabi okunamadi' })))
        return
      }

      /**
       * Cuzdan USDC kabul ediyor mu?
       *
       * Sayfa Horizon'a DOGRUDAN gitmiyor: gitseydi CSP'de `connect-src`
       * disariya acilirdi ve sayfa istedigi yere baglanabilirdi. Proxy'den
       * gecince `'self'` kalabiliyor.
       */
      if (url === '/trustline') {
        const address = String(body?.['address'] ?? '')
        try {
          const r = await f(`${HORIZON}/accounts/${address}`, { signal: AbortSignal.timeout(8000) })
          if (!r.ok) { json(res, 200, { usdc: false, known: false }); return }
          const acc = (await r.json()) as { balances: { asset_code?: string; asset_issuer?: string }[] }
          const usdc = acc.balances.some(
            (b) => b.asset_code === 'USDC' && b.asset_issuer === USDC_ISSUER,
          )
          json(res, 200, { usdc, known: true })
        } catch {
          // Zincire ulasilamadi. "Yok" DEMIYORUZ — bilmedigimizi soyluyoruz;
          // olmayan bir sorunu bildirmek, olani kacirmak kadar kotu.
          json(res, 200, { usdc: false, known: false })
        }
        return
      }

      if (url === '/verify') {
        const r = await f(`${opts.serverUrl}/v1/auth/verify`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ address: body?.['address'], transaction: body?.['transaction'] }),
        })
        const payload = (await r.json().catch(() => null)) as LoginResult | null
        if (!r.ok || !payload?.token) {
          json(res, r.status === 200 ? 502 : r.status, payload ?? { message: 'dogrulama basarisiz' })
          return
        }
        // Token'i tarayiciya GERI GONDERME — sayfaya yalnizca adres doner.
        json(res, 200, { publisherId: payload.publisherId })
        finish(() => resolve(payload))
        return
      }

      json(res, 404, { message: 'yok' })
    }

    server.on('error', (e) => finish(() => reject(e)))

    // Port 0 = isletim sistemi bos bir port versin. Sabit port secmek,
    // makinede zaten calisan bir seyle carpismak demekti.
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (typeof addr === 'string' || addr === null) {
        finish(() => reject(new Error('yerel sunucu baslatilamadi')))
        return
      }
      port = addr.port
      const url = `http://127.0.0.1:${port}/`

      out()
      out(`  ${orange('◆')} ${bold('Cuzdanini bagla')}`)
      out()
      info(`tarayicida ac: ${green(url)}`)
      info(dim('5 dakika icinde tamamla · iptal icin Ctrl-C'))
      out()

      if (!opts.noBrowser) (opts.openImpl ?? openBrowser)(url)
    })
  })
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    // XDR buyuk olabilir ama sinirsiz degil. Sinir olmadan bir istek belligi
    // doldurabilir.
    if (size > 256 * 1024) throw new Error('govde cok buyuk')
    chunks.push(c as Buffer)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> }
  catch { return null }
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    // Tarayici acilamazsa SORUN DEGIL: URL zaten ekranda yazili.
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref()
  } catch { /* sessiz */ }
}

/* ─────────────────────────── logout / whoami ─────────────────────────── */

export function cmdLogout(): void {
  const c = loadCredentials()
  const removed = clearCredentials()
  if (!removed) { warn('zaten giris yapilmamis'); return }
  ok(`cikis yapildi${c ? ` — ${shortAddress(c.publisherId)}` : ''}`)
  // Token sunucuda HALA GECERLI. Iptal ucu yazilinca burada cagrilacak;
  // simdilik durumu gizlemek yerine soyluyoruz.
  info(dim('not: cihaz token\'i sunucuda hala gecerli — iptal ucu henuz yok'))
  info(dim('daemon calisiyorsa `dwell restart` ile durdur'))
}

export function cmdWhoami(): void {
  const c = loadCredentials()
  if (!c) fail('DWL-2001', 'Giris yapilmamis', '`dwell login` ile cuzdanini bagla')
  out()
  out(`  ${bold(c.publisherId)}`)
  info(dim(`sunucu ${c.serverUrl}`))
  info(dim(`giris ${new Date(c.loggedInAt).toLocaleString()}`))
  out()
}
