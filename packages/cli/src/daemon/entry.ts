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

/** Gelistirme reklamlari. Uretimde `/v1/ads/next`'ten gelecek. */
const DEV_ADS: AdPayload[] = [
  { campaignId: 'dev-1', nonce: '0'.repeat(32), nonceExpiresAt: 9e12,
    creative: { brand: 'Firecrawl', text: 'docs to LLM-ready markdown', cta: 'firecrawl.dev' } },
  { campaignId: 'dev-2', nonce: '1'.repeat(32), nonceExpiresAt: 9e12,
    creative: { brand: 'Resend', text: 'email API for developers', cta: 'resend.com' } },
  { campaignId: 'dev-3', nonce: '2'.repeat(32), nonceExpiresAt: 9e12,
    creative: { brand: 'Neon', text: 'serverless Postgres', cta: 'neon.tech' } },
]

const log = (m: string): void => {
  process.stdout.write(`${new Date().toISOString()} ${m}\n`)
}

const SERVER = process.env['DWELL_SERVER'] ?? ''
const TOKEN = process.env['DWELL_TOKEN'] ?? ''

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

log(SERVER ? `dwelld basladi — sunucu: ${SERVER}` : 'dwelld basladi — yerel reklamlar (sunucu yok)')

// Temiz kapanis: soket dosyasi geride kalmasin, yoksa bir sonraki baslatma
// "zaten calisiyor" sanir.
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    log(`${sig} — kapaniyor`)
    void daemon.stop().then(() => process.exit(0))
  })
}
