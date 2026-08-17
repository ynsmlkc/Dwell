#!/usr/bin/env node
/**
 * Sunucu giris noktasi — gelistirme.
 *
 * Su an her sey BELLEKTE: ledger, kampanyalar, gosterimler. Postgres
 * arayuzun arkasina sonra girecek (`LedgerStore` zaten soyut).
 *
 * Amac: daemon'in gercek bir sunucuya baglanabilmesi. Kampanyalar elle
 * tanimli (ADR-009: MVP'de admin-only), reklamveren bakiyesi elle yatirilmis
 * (ADR-021: yatirma akisi sonra).
 */

import { serve } from '@hono/node-server'
import { systemClock, cryptoIdGenerator, stroops, FALLBACK_CONFIG } from '@dwell/protocol'
import type { RemoteConfig } from '@dwell/protocol'
import { createApp } from './http/app.js'
import { hashToken } from './http/auth.js'
import { WalletAuth, serverKeypair, horizonSigners } from './http/wallet-auth.js'
import { Sep10, NETWORKS } from '@dwell/payments'
import { Pipeline } from './pipeline.js'
import { Ledger } from './ledger/ledger.js'
import type { Campaign } from './ads/selector.js'
import { accountId } from './ledger/accounts.js'
import { openDb, MEMORY, vacuumExpired } from './store/db.js'
import {
  SqliteLedgerStore, SqliteTokenStore, SqlitePayoutStore,
  SqliteImpressionMirror, walletPersistence,
} from './store/persistent.js'
import { PayoutRunner, schedulePayouts } from './payouts/runner.js'
import { StellarRail, HORIZON as HORIZON_URLS, TESTNET_USDC } from '@dwell/payments'
import { WalletStore } from '@dwell/payments'

const PORT = Number(process.env['PORT'] ?? 8787)
// Yerelde YALNIZCA loopback. Konteynerde 0.0.0.0 gerekiyor ve orada
// `HOST` acikca veriliyor (Dockerfile). Varsayilani 0.0.0.0 yapmak,
// gelistirirken sunucuyu farkinda olmadan tum yerel aga acardi.
const HOST = process.env['HOST'] ?? '127.0.0.1'

/**
 * Gelistirme token'i.
 *
 * Uretimde OLUSTURULMAZ. Sabit degeri bu dosyada yaziyor ve repo herkese
 * acik: uretimde de eklenseydi, repoyu okuyan herkesin elinde gecerli bir
 * token olurdu ve istedigi kadar gosterim bildirebilirdi.
 *
 * Uretimde token'lar yalnizca `dwell login` ile, cuzdan imzasi karsiliginda
 * uretilir.
 */
const IS_PROD = process.env['DWELL_ENV'] === 'production'
const DEV_TOKEN = IS_PROD ? null : (process.env['DWELL_DEV_TOKEN'] ?? 'dwl_dev_token_0123456789abcdef0123')
const DEV_PUBLISHER = 'dev-publisher'
const DEV_ADVERTISER = 'dev-advertiser'

const clock = systemClock
const ids = cryptoIdGenerator(clock)
const log = (m: string): void => { process.stdout.write(`${new Date().toISOString()} ${m}\n`) }

/* ─────────────────────────── defter ─────────────────────────── */

/**
 * Kalici depolama.
 *
 * `DWELL_DB` bir Railway diskini gostermeli (`/data/dwell.db`). Verilmezse
 * BELLEKTE calisir ve her yeniden baslatmada her sey silinir — gelistirmede
 * istenen budur, uretimde felakettir. Bu yuzden uretimde gurultulu uyariyor.
 */
const DB_PATH = process.env['DWELL_DB'] ?? MEMORY
if (DB_PATH === MEMORY && process.env['DWELL_ENV'] === 'production') {
  log('⚠⚠ DWELL_DB TANIMSIZ — veriler BELLEKTE, her deploy\'da bakiyeler SILINIR')
}
const db = openDb(DB_PATH)

const ledger = new Ledger(
  new SqliteLedgerStore(db, clock, () => ids.impressionId()),
  clock,
  () => ids.impressionId(),
)

// ADR-021: reklamverenin parasi defterde gorunmeli. Uretimde cuzdandan
// yatirma akisi bunu yazacak; simdilik elle.
//
// `topupId` sabit oldugu icin idempotent: defter zaten yazilmissa ikinci
// kez eklemez. Yoksa her yeniden baslatmada 100.000 USDC daha basardik.
ledger.deposit({
  advertiserId: DEV_ADVERTISER,
  amount: stroops(1_000_000_000_000n),          // 100.000 USDC
  topupId: 'dev-seed',
})

/* ─────────────────────────── kampanyalar ─────────────────────────── */

const campaigns: Campaign[] = [
  { id: 'c-firecrawl', advertiserId: DEV_ADVERTISER, bidCpm: stroops(300_000_000n), revShareBps: 5000,
    creative: { brand: 'Firecrawl', text: 'docs to LLM-ready markdown', cta: 'firecrawl.dev' },
    status: 'active', frequencyCap: 1 },
  { id: 'c-resend', advertiserId: DEV_ADVERTISER, bidCpm: stroops(250_000_000n), revShareBps: 5000,
    creative: { brand: 'Resend', text: 'email API for developers', cta: 'resend.com' },
    status: 'active', frequencyCap: 1 },
  { id: 'c-neon', advertiserId: DEV_ADVERTISER, bidCpm: stroops(200_000_000n), revShareBps: 5000,
    creative: { brand: 'Neon', text: 'serverless Postgres', cta: 'neon.tech' },
    status: 'active', frequencyCap: 1 },
]

/* ─────────────────────────── boru hatti ─────────────────────────── */

const config: RemoteConfig = {
  ...FALLBACK_CONFIG,
  renderEnabled: true,
  surfaces: { statusline: true, spinnerVerb: true, spinnerTip: true },
  minClientVersion: '0.0.0',
  minImpressionMs: 10_000,
  rotateMs: 20_000,
  idleGraceMs: 4_000,
  refreshIntervalSec: 1,
  configPollSec: 60,
  reportIntervalSec: 30,
}

const mirror = new SqliteImpressionMirror(db)

const pipeline = new Pipeline({
  clock, ids, ledger,
  persist: {
    loadImpressions: () => mirror.loadImpressions(),
    saveImpression: (i) => mirror.saveImpression(i),
    loadDeliveries: () => mirror.loadDeliveries(),
    saveDelivery: (d) => mirror.saveDelivery(d),
  },
  campaigns: () => campaigns,
  minImpressionMs: config.minImpressionMs,
  minClientVersion: config.minClientVersion,
  // Gelistirmede 24 saat beklemek isi imkansiz kilar; uretimde 24 saat
  // (§9 katman 2 — zincir ustu odeme geri alinamaz).
  pendingMs: Number(process.env['DWELL_PENDING_MS'] ?? 30_000),
  dailyCap: 400,
})

const tokens = new SqliteTokenStore(db)

/* ─────────────────── cuzdanla giris ─────────────────── */

const HORIZON = process.env['DWELL_HORIZON'] ?? HORIZON_URLS.testnet
const HOME_DOMAIN = process.env['DWELL_HOME_DOMAIN'] ?? `${HOST}:${PORT}`

const sep10Keypair = serverKeypair()
const walletAuth = new WalletAuth({
  clock, ids,
  sep10: new Sep10({
    serverKeypair: sep10Keypair,
    homeDomain: HOME_DOMAIN,
    webAuthDomain: HOME_DOMAIN,
    networkPassphrase: NETWORKS.testnet,
  }, clock),
  loadSigners: horizonSigners(HORIZON),
  hashToken,
  issueToken: ({ publisherId, tokenHash, scopes }) => {
    const tokenId = ids.impressionId()
    tokens.add({
      id: tokenId, publisherId, tokenHash, scopes,
      clientVersion: null, revokedAt: null, lastSeenAt: null,
    })
    log(`giris: ${publisherId.slice(0, 8)}…${publisherId.slice(-4)}`)
    return { tokenId }
  },
})

if (DEV_TOKEN) {
  tokens.add({
    id: 'dev-token', publisherId: DEV_PUBLISHER, tokenHash: hashToken(DEV_TOKEN),
    scopes: ['report:impressions', 'read:balance'],
    clientVersion: null, revokedAt: null, lastSeenAt: null,
  })
}

/* ─────────────────────── odeme ─────────────────────── */

const PAYOUT_THRESHOLD = stroops(10_000_000n)          // $1
const payouts = new SqlitePayoutStore(db)
const wallets = new WalletStore({
  clock,
  holdMs: Number(process.env['DWELL_WALLET_HOLD_MS'] ?? 0),   // uretimde 72 saat
  notify: (n) => log(`cuzdan ${n.kind}: ${n.publisherId.slice(0, 8)}… → ${n.newAddress.slice(0, 8)}…`),
  persist: walletPersistence(db),
})

/**
 * Sicak cuzdan.
 *
 * Anahtar YOKSA odeme turu hic baslatilmaz — sahte bir rayla "odedik" demek,
 * odememekten kotudur: kullanici odendigini sanir ve beklemeyi birakir.
 */
let zamanlama: { stop: () => void } | null = null

const HOT_SECRET = process.env['DWELL_HOT_SECRET']
const payoutRunner = HOT_SECRET
  ? new PayoutRunner({
      clock, wallets, ledger, store: payouts,
      rail: new StellarRail({
        horizonUrl: HORIZON,
        networkPassphrase: NETWORKS.testnet,
        sourceSecret: HOT_SECRET,
        assetCode: process.env['DWELL_ASSET_CODE'] ?? TESTNET_USDC.code,
        assetIssuer: process.env['DWELL_ASSET_ISSUER'] ?? TESTNET_USDC.issuer,
      }),
      threshold: PAYOUT_THRESHOLD,
      newBatchId: () => `b-${ids.impressionId()}`,
      log,
    })
  : null

if (payoutRunner) {
  // Uretimde gunde bir. Gelistirmede kisa, yoksa hicbir seyi gozlemleyemezsin.
  const her = Number(process.env['DWELL_PAYOUT_INTERVAL_MS'] ?? 60_000)
  zamanlama = schedulePayouts(payoutRunner, her, log)
  // Yeniden baslatmada asili kalanlari coz — para `payouts_in_flight`'ta
  // sonsuza kadar beklemesin.
  void payoutRunner.resumeUnresolved().then((n) => {
    if (n > 0) log(`${n} asili batch cozuldu`)
  })
  log(`odeme turu her ${her / 1000}s · esik ${PAYOUT_THRESHOLD} stroop`)
} else {
  log('odeme KAPALI — DWELL_HOT_SECRET tanimli degil')
}

/* ─────────────────────── dogrulama job'i ─────────────────────── */

// Uretimde cron; burada basit bir aralik. Ledger'a yazan tek yer burasi.
setInterval(() => {
  const r = pipeline.runVerification()
  if (r.verified || r.rejected) {
    log(`dogrulama: ${r.verified} onayli, ${r.rejected} red, ${r.stillPending} bekliyor`)
    const problems = ledger.audit()
    if (problems.length > 0) log(`⚠ LEDGER INVARIANT IHLALI: ${problems.join('; ')}`)
  }
}, 10_000).unref()

/* ─────────────────────────── sunucu ─────────────────────────── */

const app = createApp({
  clock, ids, pipeline, ledger, tokens,
  config: () => config,
  walletAuth,
  ipSalt: process.env['DWELL_IP_SALT'] ?? 'dev-salt-degistir',
  payoutThreshold: PAYOUT_THRESHOLD,
  payouts,
})

const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  const bakiye = ledger.balance(accountId('advertiser', DEV_ADVERTISER))
  log(`dwell sunucusu http://${HOST}:${info.port}`)
  log(`${campaigns.length} kampanya · reklamveren bakiyesi ${bakiye} stroop`)
  if (DEV_TOKEN) log(`gelistirme token'i: ${DEV_TOKEN}`)
  else log("gelistirme token'i YOK (uretim) — giris yalnizca `dwell login` ile")
  log(`SEP-10 imzalama anahtari: ${sep10Keypair.publicKey()}`)
  log(`veritabani: ${DB_PATH === MEMORY ? 'BELLEK (kalici degil)' : DB_PATH}`)
  log(`${ledger.publishers().length} publisher · ${pipeline.impressions().length} gosterim yuklendi`)
})

// Olu kayitlari topla. Defter ASLA silinmez; yalnizca suresi gecmis reklam
// sunumlari ve 90 gunden eski karara baglanmis gosterimler.
setInterval(() => {
  const n = vacuumExpired(db, clock.now(), 90 * 86_400_000)
  if (n > 0) log(`temizlik: ${n} olu kayit silindi`)
}, 3600_000).unref()

/* ─────────────────── temiz kapanis ─────────────────── */

/**
 * Railway her deploy'da SIGTERM gonderir ve kisa bir sure sonra sureci
 * oldurur.
 *
 * Onemli olan: kapanirken YENI odeme turu BASLATMAMAK. Zincire gonderilmis
 * ama mutabakati yapilmamis bir batch, sunucu dustugunde `payouts_in_flight`
 * ta asili kalir. Kaybolmaz — `resumeUnresolved` acilista zincire sorup
 * cozuyor — ama hic olusturmamak daha iyi.
 */
let kapaniyor = false
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    if (kapaniyor) return
    kapaniyor = true
    log(`${sig} — kapaniyor`)
    zamanlama?.stop()
    server.close(() => { db.close(); process.exit(0) })
    // Acik baglantilar kapanmazsa da bekleme: platform zaten olduruyor.
    setTimeout(() => process.exit(0), 5_000).unref()
  })
}
