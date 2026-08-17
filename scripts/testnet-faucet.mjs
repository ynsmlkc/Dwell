#!/usr/bin/env node
/**
 * Testnet USDC havuzu — test hesaplarini fonlamak icin.
 *
 * Circle'in musluğu ReCAPTCHA ile korunuyor ve otomatiklestirilemez (ki
 * dogrusu da bu — musluk kurumasin diye konmus). Onun yerine bir kez
 * alinan USDC'yi DOLASIMDA tutuyoruz:
 *
 *     havuz → test reklamvereni → kasa → (odeme) → test yayincisi → havuz
 *
 * Odeme cikan test yayincisindan parayi geri topluyoruz, boylece ayni USDC
 * defalarca kullanilabiliyor. Sizinti yalnizca platform payi: her turda
 * harcananin yarisi kasada kaliyor ve geri alinmiyor — cunku o para
 * defterde bir yukumluluk, zincirden cekmek solvency'yi bozardi.
 *
 *   node scripts/testnet-faucet.mjs balance
 *   node scripts/testnet-faucet.mjs new-advertiser 2
 *   node scripts/testnet-faucet.mjs reclaim <SECRET>
 *
 * Anahtar `.testnet-faucet.json` icinde, git'e girmiyor.
 */

import { Keypair, Horizon, TransactionBuilder, Operation, Asset, BASE_FEE, Networks } from '@stellar/stellar-sdk'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const KOK = join(dirname(fileURLToPath(import.meta.url)), '..')
const DOSYA = join(KOK, '.testnet-faucet.json')

const HZ = new Horizon.Server('https://horizon-testnet.stellar.org')
const USDC = new Asset('USDC', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5')

/* ─────────────────────────── yardimcilar ─────────────────────────── */

async function gonder(kp, build) {
  const acc = await HZ.loadAccount(kp.publicKey())
  const tx = build(new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET }))
    .setTimeout(90).build()
  tx.sign(kp)
  return HZ.submitTransaction(tx)
}

async function usdcBakiye(address) {
  try {
    const acc = await HZ.loadAccount(address)
    const b = acc.balances.find((x) => x.asset_code === 'USDC' && x.asset_issuer === USDC.getIssuer())
    return b ? b.balance : null          // `null` = trustline yok
  } catch {
    return undefined                     // hesap yok
  }
}

/** Hesabi kurar: friendbot ile XLM, sonra USDC trustline. */
async function hazirla(kp) {
  const mevcut = await usdcBakiye(kp.publicKey())
  if (mevcut === undefined) {
    await fetch(`https://friendbot.stellar.org?addr=${kp.publicKey()}`)
    await new Promise((r) => setTimeout(r, 2500))
  }
  if ((await usdcBakiye(kp.publicKey())) === null) {
    await gonder(kp, (tb) => tb.addOperation(Operation.changeTrust({ asset: USDC })))
  }
}

function havuz() {
  if (!existsSync(DOSYA)) {
    console.error(
      `Havuz kurulmamis. Once bir kez tohumla:\n` +
      `  node scripts/testnet-faucet.mjs init\n` +
      `Sonra cikan adrese faucet.circle.com'dan (Stellar) USDC gonder.`,
    )
    process.exit(1)
  }
  return Keypair.fromSecret(JSON.parse(readFileSync(DOSYA, 'utf8')).secret)
}

/* ─────────────────────────── komutlar ─────────────────────────── */

const [komut, ...arg] = process.argv.slice(2)

if (komut === 'init') {
  if (existsSync(DOSYA)) {
    const kp = havuz()
    console.log('zaten var:', kp.publicKey())
  } else {
    const kp = Keypair.random()
    writeFileSync(DOSYA, JSON.stringify({ secret: kp.secret(), address: kp.publicKey() }, null, 2), { mode: 0o600 })
    await hazirla(kp)
    console.log('havuz olusturuldu:', kp.publicKey())
    console.log('faucet.circle.com → Stellar → bu adresi yapistir')
  }
} else if (komut === 'balance') {
  const kp = havuz()
  console.log(`havuz ${kp.publicKey()}`)
  console.log(`  USDC ${(await usdcBakiye(kp.publicKey())) ?? '(trustline yok)'}`)
} else if (komut === 'new-advertiser') {
  // Yeni test reklamvereni: hesap + trustline + USDC.
  const tutar = arg[0] ?? '2'
  const kp = havuz()
  const yeni = Keypair.random()
  await hazirla(yeni)
  await gonder(kp, (tb) => tb.addOperation(Operation.payment({
    destination: yeni.publicKey(), asset: USDC, amount: tutar,
  })))
  console.log(JSON.stringify({ address: yeni.publicKey(), secret: yeni.secret(), usdc: tutar }))
} else if (komut === 'new-publisher') {
  // Test yayincisi: trustline SART, yoksa odeme alamaz.
  const yeni = Keypair.random()
  await hazirla(yeni)
  console.log(JSON.stringify({ address: yeni.publicKey(), secret: yeni.secret() }))
} else if (komut === 'reclaim') {
  // Test hesabindaki USDC'yi havuza geri al.
  const kp = havuz()
  const kaynak = Keypair.fromSecret(arg[0])
  const bakiye = await usdcBakiye(kaynak.publicKey())
  if (!bakiye || Number(bakiye) === 0) {
    console.log('geri alinacak USDC yok')
  } else {
    await gonder(kaynak, (tb) => tb.addOperation(Operation.payment({
      destination: kp.publicKey(), asset: USDC, amount: bakiye,
    })))
    console.log(`${bakiye} USDC havuza dondu`)
  }
} else {
  console.log(`kullanim:
  init                     havuzu olustur (bir kez)
  balance                  havuzdaki USDC
  new-advertiser [tutar]   fonlanmis test reklamvereni  → JSON
  new-publisher            trustline'li test yayincisi  → JSON
  reclaim <SECRET>         hesaptaki USDC'yi havuza al`)
}
