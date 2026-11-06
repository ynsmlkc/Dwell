#!/usr/bin/env node
/**
 * Daemon giris noktasi — arka planda calisan surec.
 *
 * Su an reklamlar yerel bir listeden geliyor; sunucudan prefetch omurganin
 * son adiminda baglanacak. Yapi hazir: `ads` disaridan veriliyor.
 */

import { startDaemon } from './index.js'
import { FALLBACK_CONFIG } from '@dwell/protocol'
import type { AdPayload } from '@dwell/protocol'
import { loadCredentials, shortAddress } from '../credentials.js'

/**
 * Giris yapilmamisken gosterilen TEK satir. Reklam degil, durum bildirimi.
 *
 * Onceden uc ornek satir donuyordu ve kullanici programi calisir gorup
 * kazandigini saniyordu: bir makinede bir ay hicbir sey sayilmadi. Tek ve
 * degismeyen bir satir reklama benzemiyor, ne yapmasi gerektigini soyluyor.
 * Sunucuya baglanmadigi icin hicbir yere gitmez, kimseye fatura edilmez.
 */
const LOGGED_OUT_LINE: AdPayload[] = [
  { campaignId: 'not-logged-in', nonce: '0'.repeat(32), nonceExpiresAt: 9e12,
    creative: { brand: 'Dwell', text: 'not earning — connect your wallet', cta: 'dwell login' } },
]

const log = (m: string): void => {
  process.stdout.write(`${new Date().toISOString()} ${m}\n`)
}

// Once ortam degiskeni (gelistirme, CI), sonra `dwell login`'in yazdigi dosya.
// Ortamin oncelikli olmasi bilincli: bir seyi test ederken kayitli kimligi
// gecici olarak devre disi birakabilmek gerekiyor.
const creds = loadCredentials()
const SERVER = process.env['DWELL_SERVER'] ?? creds?.serverUrl ?? ''
const TOKEN = process.env['DWELL_TOKEN'] ?? creds?.token ?? ''

const daemon = await startDaemon({
  // Giris yoksa reklam da yok: yalnizca bildirim satiri.
  ...(SERVER ? { serverUrl: SERVER, token: TOKEN } : { ads: LOGGED_OUT_LINE }),
  syncSpinner: true,
  onLog: log,
  config: {
    ...FALLBACK_CONFIG,
    renderEnabled: true,
    surfaces: { statusline: true, spinnerVerb: true, spinnerTip: true },
    minImpressionMs: 10_000,
    rotateMs: 20_000,
    idleGraceMs: 4_000,
  },
  onImpression: (i) => log(
    `gosterim ${i.id} ${i.campaignId} ${i.durationMs}ms ` +
    (i.rejectedReason ? `RED: ${i.rejectedReason}` : 'sayildi'),
  ),
  onError: (e) => log(`hata: ${e instanceof Error ? e.message : String(e)}`),
})

log(
  SERVER
    ? `dwelld basladi — sunucu: ${SERVER}` +
      (creds ? ` · cuzdan: ${shortAddress(creds.publisherId)}` : ' · token: ortamdan')
    : 'dwelld basladi — giris yok, reklam gosterilmiyor (`dwell login`)',
)

// Temiz kapanis: soket dosyasi geride kalmasin, yoksa bir sonraki baslatma
// "zaten calisiyor" sanir.
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    log(`${sig} — kapaniyor`)
    void daemon.stop().then(() => process.exit(0))
  })
}
