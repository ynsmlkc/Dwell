#!/usr/bin/env node
/**
 * Testnet'te bir reklamveren kurar: giris yapar, butce yatirir, kampanya acar.
 *
 * Amaci para kazanmak degil — testnet USDC'nin degeri yok. Amaci ZINCIRIN
 * KENDILIGINDEN donmesi: butce yatar, reklam gosterilir, kazanc deftere
 * yazilir, esik gecilince odeme zincire cikar. Bugune kadar bu adimlarin
 * her biri tek tek kanitlandi ama hepsi elle tetiklenmisti.
 *
 * Reklamveren kimligi faucet cuzdani. Ayri bir cuzdan uretmiyoruz: para
 * GONDEREN ADRESE gore eslesiyor (ADR-021), yani butceyi yatiran cuzdan ile
 * giris yapan cuzdan AYNI olmak zorunda.
 *
 *   node scripts/test-campaign.mjs            # durumu goster
 *   node scripts/test-campaign.mjs --apply    # gercekten kur
 */

import {
  Keypair, Horizon, TransactionBuilder, Transaction, Operation,
  Asset, BASE_FEE, Networks,
} from '@stellar/stellar-sdk'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const KOK = join(dirname(fileURLToPath(import.meta.url)), '..')
const API = process.env.DWELL_SERVER ?? 'https://dwellserver-production.up.railway.app'
const HORIZON = 'https://horizon-testnet.stellar.org'
const USDC = new Asset('USDC', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5')
const UYGULA = process.argv.includes('--apply')

const server = new Horizon.Server(HORIZON)
const kp = Keypair.fromSecret(JSON.parse(readFileSync(join(KOK, '.testnet-faucet.json'), 'utf8')).secret)

const log = (...a) => console.log(...a)
const usd = (s) => '$' + (Number(BigInt(s)) / 1e7).toFixed(2)

async function api(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`${path} → ${res.status} ${JSON.stringify(data)}`)
  return data
}

/**
 * SEP-10 girisi.
 *
 * Imzalanan islemin `sequence`'i sifir; aga gonderilmesi protokol geregi
 * imkansiz. Yani bu imza para hareket ettiremez, yalnizca adresin bize ait
 * oldugunu kanitlar.
 */
async function login(role) {
  const ch = await api('/v1/auth/challenge', { method: 'POST', body: { address: kp.publicKey() } })
  const tx = new Transaction(ch.transaction, ch.network_passphrase)
  tx.sign(kp)
  const { token } = await api('/v1/auth/verify', {
    method: 'POST',
    body: { address: kp.publicKey(), transaction: tx.toXDR(), role },
  })
  return token
}

/** Butceyi sicak cuzdana yollar. Eslesme gonderen adrese gore. */
async function yatir(hedef, tutar) {
  const acc = await server.loadAccount(kp.publicKey())
  const tx = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.payment({ destination: hedef, asset: USDC, amount: tutar }))
    .setTimeout(120)
    .build()
  tx.sign(kp)
  const r = await server.submitTransaction(tx)
  return r.hash
}

/* ──────────────────────────────────────────────────────────── */

const acc = await server.loadAccount(kp.publicKey())
const bakiye = acc.balances.find((b) => b.asset_code === 'USDC')?.balance ?? '0'

log('\n  reklamveren  ' + kp.publicKey())
log('  butce        ' + bakiye + ' USDC\n')

const token = await login('advertiser')
const me = await api('/v1/advertiser/me', { token })

log('  sunucudaki bakiye   ' + usd(me.balanceStroops))
log('  harcanabilir        ' + usd(me.spendableStroops))
log('  kampanya sayisi     ' + me.campaigns.length)
log('  yatirma adresi      ' + (me.deposit?.address ?? '(kapali)'))

if (!UYGULA) {
  log('\n  (kuru calisma — gercekten kurmak icin --apply)\n')
  process.exit(0)
}

/* ── butce yatir ── */

const yatirilacak = (Math.floor(Number(bakiye) * 100) / 100).toFixed(2)
if (Number(yatirilacak) > 0) {
  log('\n  ' + yatirilacak + ' USDC yatiriliyor…')
  const hash = await yatir(me.deposit.address, yatirilacak)
  log('  tx  ' + hash)

  // Sunucu Horizon'u tariyor; kredi aninda gelmiyor.
  log('  defterde gorunmesi bekleniyor…')
  for (let i = 1; i <= 40; i++) {
    await new Promise((r) => setTimeout(r, 5000))
    const m = await api('/v1/advertiser/me', { token })
    if (BigInt(m.balanceStroops) > BigInt(me.balanceStroops)) {
      log('  ✓ yazildi — bakiye ' + usd(m.balanceStroops))
      break
    }
    if (i === 40) log('  ! 3 dakikada yazilmadi; tarayici gecikmis olabilir')
  }
}

/* ── kampanya ── */

/**
 * Reklam metni. Bunun bir reklam OLDUGU ve testnet oldugu satirin kendisinde
 * yaziyor: statusline'da kaynagi belirsiz bir satir gostermek, reklami
 * icerik gibi sunmak olurdu.
 */
const kampanya = {
  brand: 'Dwell',
  // Satir sinirinin 80 karakter oldugunu unutma: marka ve alan adi da
  // ayni satira giriyor, yalnizca bu metin degil.
  text: 'Test campaign — proving the payout loop on testnet',
  cta: 'dwell.sh',
  // CPM = bin gosterim basina. 5 USDC/1000 → gosterim basina 0,005 USDC,
  // yarisi yayinciya: 0,0025 USDC. Esigi makul surede gecirir.
  bidCpmStroops: String(5n * 10_000_000n),
}

const c = await api('/v1/advertiser/campaigns', { method: 'POST', token, body: kampanya })
log('\n  ✓ kampanya acildi  ' + c.id)
log('    ' + kampanya.brand + ' — ' + kampanya.text)
log('    teklif  ' + usd(kampanya.bidCpmStroops) + ' / 1000 gosterim\n')
