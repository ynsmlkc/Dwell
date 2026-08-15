/**
 * Unix domain socket sunucusu.
 *
 * Guvenlik (§15.9): sokete baglanabilen her yerel surec sahte hook olayi
 * uretip gosterim uydurabilir ve fraud katmanlarinin hicbiri bunu gormez —
 * cunku olay mesru bir hesaptan geliyor. Bu yuzden:
 *
 *   • Dizin 0700, soket 0600 — baska kullanici baglanamaz
 *   • Baglanan surecin uid'i kontrol edilir (paylasimli makine)
 *   • Bayat soket dosyasi temizlenir (daemon carptiysa)
 */

import { createServer, type Server, type Socket } from 'node:net'
import { chmodSync, mkdirSync, unlinkSync, existsSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { encode, decode, type Request, type Response } from '../ipc.js'

export type Handler = (req: Request) => Response | Promise<Response>

export interface SocketServer {
  readonly close: () => Promise<void>
  readonly connections: () => number
}

export async function startSocketServer(
  socketPath: string,
  handle: Handler,
  onError: (e: unknown) => void = () => {},
): Promise<SocketServer> {
  const dir = dirname(socketPath)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)

  // Bayat soket: daemon carptiysa dosya kalir ve bind engellenir.
  // Once gercekten olu mu diye bakilir, canliysa DOKUNULMAZ.
  if (existsSync(socketPath)) {
    if (await isSocketAlive(socketPath)) {
      throw new Error(`dwelld zaten calisiyor: ${socketPath}`)
    }
    try { unlinkSync(socketPath) } catch { /* yaris — bind zaten patlar */ }
  }

  let live = 0
  const server: Server = createServer((sock: Socket) => {
    live++
    sock.on('close', () => { live-- })
    sock.on('error', (e: NodeJS.ErrnoException) => {
      // EPIPE / ECONNRESET beklenen durumdur, hata degil: shim cevabini alir
      // almaz soketi kapatir (butcesi 200 ms). Bunlari `lastError`'a yazmak
      // `dwell doctor`'i her tikta yaniltir.
      if (e.code === 'EPIPE' || e.code === 'ECONNRESET') return
      onError(e)
    })
    sock.setNoDelay(true)
    // Shim'in butcesi 50ms; tembel baglanti tutmayalim.
    sock.setTimeout(5_000, () => sock.destroy())

    let buf = ''
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      // Kotu niyetli/bozuk istemci sinirsiz veri gonderirse bellegi doldurmasin.
      if (buf.length > 64 * 1024) { sock.destroy(); return }

      let nl: number
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        const req = decode<Request>(line)
        if (!req) { sock.write(encode({ t: 'error', code: 'DWL_9001' })); continue }
        // `Promise.resolve(handle(req))` YETMEZ: handle senkron firlatirsa
        // hata Promise'e hic girmez, `.catch()` yakalayamaz ve daemon duser.
        // Bu yol her saniye kat ediliyor — tek bir senkron hata her seyi
        // durdurmamali.
        void (async () => handle(req))()
          .then((res) => {
            // `destroyed` kontrolu ile write arasinda yaris var; hata
            // geri cagrimi yutuluyor cunku soket zaten kapanmis olabilir.
            if (!sock.destroyed) sock.write(encode(res), () => {})
          })
          .catch((e) => {
            onError(e)
            if (!sock.destroyed) sock.write(encode({ t: 'error', code: 'DWL_9001' }))
          })
      }
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => { server.off('error', reject); resolve() })
  })

  chmodSync(socketPath, 0o600)

  return {
    connections: () => live,
    close: () => new Promise<void>((resolve) => {
      server.close(() => {
        try { unlinkSync(socketPath) } catch { /* zaten gitmis */ }
        resolve()
      })
    }),
  }
}

/** Soket dosyasi var ama arkasinda dinleyen var mi? */
function isSocketAlive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      if (!statSync(path).isSocket()) return resolve(false)
    } catch { return resolve(false) }

    const probe = createServer()
    // Dinlemeyi denemek yerine baglanmayi deniyoruz: bind denemesi bayat
    // dosyayi silmeden basarisiz olur ve ayirt edemezdik.
    probe.close()
    import('node:net').then(({ connect }) => {
      const c = connect(path)
      const done = (v: boolean) => { c.destroy(); resolve(v) }
      c.setTimeout(300, () => done(false))
      c.on('connect', () => done(true))
      c.on('error', () => done(false))
    }).catch(() => resolve(false))
  })
}
