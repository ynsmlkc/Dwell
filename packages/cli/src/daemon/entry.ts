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
 * Giris yapilmamisken gosterilen ornek satirlar.
 *
 * Bunlar KENDIMIZI anlatiyor, baska markalari degil.
 *
 * Onceden burada Firecrawl, Resend ve Neon yaziyordu — gercek sirketler ve
 * hicbiri bize izin vermedi. Paket npm'de: kuran herkes o markalarin bize
 * para verdigini sanardi. Var olmayan bir musteri iliskisini ima etmek,
 * hem o sirketlere hem kullaniciya karsi durust degil.
 *
 * Ikinci fayda: demo artik gercekten ayirt ediliyor. Kullanici satiri
 * okudugu anda kazanmadigini ve ne yapmasi gerektigini biliyor — daha once
 * `dwell init` ciktisindaki uyariyi kacirdiysa burada yakaliyor.
 */
const DEV_ADS: AdPayload[] = [
  { campaignId: 'sample-1', nonce: '0'.repeat(32), nonceExpiresAt: 9e12,
    creative: { brand: 'Dwell', text: 'sample line — you are not earning yet', cta: 'dwell login' } },
  { campaignId: 'sample-2', nonce: '1'.repeat(32), nonceExpiresAt: 9e12,
    creative: { brand: 'Dwell', text: 'connect a wallet to show real ads', cta: 'dwell login' } },
  { campaignId: 'sample-3', nonce: '2'.repeat(32), nonceExpiresAt: 9e12,
    creative: { brand: 'Dwell', text: 'no server connected — nothing is recorded', cta: 'dwell login' } },
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
  // Sunucu adresi verilmisse oradan, yoksa yerel listeden (gelistirme).
  ...(SERVER ? { serverUrl: SERVER, token: TOKEN } : { ads: DEV_ADS }),
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
    : 'dwelld basladi — yerel reklamlar (sunucu yok, `dwell login` ile bagla)',
)

// Temiz kapanis: soket dosyasi geride kalmasin, yoksa bir sonraki baslatma
// "zaten calisiyor" sanir.
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    log(`${sig} — kapaniyor`)
    void daemon.stop().then(() => process.exit(0))
  })
}
