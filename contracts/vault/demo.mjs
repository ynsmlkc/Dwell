#!/usr/bin/env node
/**
 * Vault kontratinin GERCEK testnet kaniti — deposit -> release -> withdraw.
 *
 * `spikes/stellar-payout/run.mjs` ile ayni desen: kendi asset'imizi
 * basiyoruz (Circle'in testnet USDC'si otomatik alinamiyor, NEXT.md'de
 * zaten notlu), tek amac zincirin GERCEKTEN donmesini kanitlamak.
 *
 * Burada uretilen anahtarlar TEK KULLANIMLIK, disposable testnet
 * kimlikleri — projenin kalici `.testnet-faucet.json` anahtariyla
 * KARISTIRILMAMALI, o hicbir zaman buraya yazilmaz/loglanmaz.
 *
 * Kullanim: node demo.mjs
 */
import { Keypair, Networks, TransactionBuilder, Operation, Asset, Horizon } from '@stellar/stellar-sdk'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HORIZON = 'https://horizon-testnet.stellar.org'
const FRIENDBOT = 'https://friendbot.stellar.org'
const NETWORK = Networks.TESTNET
const FEE = '1000'
const EXPLORER = 'https://stellar.expert/explorer/testnet'
const KOK = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CARGO_BIN = join(process.env.HOME, '.cargo', 'bin')

const server = new Horizon.Server(HORIZON)
const log = (...a) => console.log(...a)
const head = (t) => log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`)
const short = (pk) => `${pk.slice(0, 6)}…${pk.slice(-4)}`

async function friendbot(pk, label) {
  for (let i = 1; i <= 4; i++) {
    const r = await fetch(`${FRIENDBOT}?addr=${pk}`)
    if (r.ok) { log(`  ✓ ${label.padEnd(12)} ${short(pk)} fonlandi`); return }
    if (i === 4) throw new Error(`friendbot ${label} icin basarisiz: ${r.status}`)
    await new Promise((res) => setTimeout(res, 1500 * i))
  }
}

/** Faucet anahtari yalnizca burada, bellekte cozulur — hicbir yere yazilmaz/loglanmaz. */
function faucetKeypair() {
  const secret = JSON.parse(readFileSync(join(KOK, '.testnet-faucet.json'), 'utf8')).secret
  return Keypair.fromSecret(secret)
}

/**
 * `secret` STELLAR_ACCOUNT env degiskeni ile geciriliyor, CLI argumani
 * OLARAK DEGIL — argv `ps`'te gorunur, env degiskeni daha az acik bir yuzey.
 * `--source-account` flag'i BURADA HIC verilmiyor: verilirse env'i ezip
 * yalnizca public key'i kullanmaya calisiyor ve imza anahtari bulamiyor.
 */
function stellarCli(args, secret) {
  const env = { ...process.env, PATH: `${CARGO_BIN}:${process.env.PATH}` }
  if (secret) env.STELLAR_ACCOUNT = secret
  return execFileSync('stellar', args, { env, encoding: 'utf8' }).trim()
}

/* ─────────────────────── 1. hesaplar + asset ─────────────────────── */

head('1/5  Testnet hesaplari (friendbot) + tek kullanimlik test asset\'i')

const issuer = Keypair.random()
const advertiser = Keypair.random()
const publisher = Keypair.random()
const platform = Keypair.random()
await friendbot(issuer.publicKey(), 'issuer')
await friendbot(advertiser.publicKey(), 'advertiser')
await friendbot(publisher.publicKey(), 'publisher')
await friendbot(platform.publicKey(), 'platform')

const ASSET = new Asset('VAULTT', issuer.publicKey())
log(`\n  Asset: ${ASSET.getCode()}:${short(ASSET.getIssuer())}`)
log('  NOT: gercek dagitimda Circle testnet USDC kullanilir (bkz. NEXT.md §3).')

// advertiser + publisher + platform trustline acar (release'in SAC transfer'i
// icin sart — classic Payment'taki ayni kural, SAC'ta da gecerli).
for (const [name, kp] of [['advertiser', advertiser], ['publisher', publisher], ['platform', platform]]) {
  const acc = await server.loadAccount(kp.publicKey())
  const tx = new TransactionBuilder(acc, { fee: FEE, networkPassphrase: NETWORK })
    .addOperation(Operation.changeTrust({ asset: ASSET }))
    .setTimeout(180).build()
  tx.sign(kp)
  await server.submitTransaction(tx)
  log(`  ✓ ${name.padEnd(12)} trustline acildi`)
}
// advertiser'a 1000 birim gonderilir
{
  const acc = await server.loadAccount(issuer.publicKey())
  const tx = new TransactionBuilder(acc, { fee: FEE, networkPassphrase: NETWORK })
    .addOperation(Operation.payment({ destination: advertiser.publicKey(), asset: ASSET, amount: '1000' }))
    .setTimeout(180).build()
  tx.sign(issuer)
  await server.submitTransaction(tx)
  log('  ✓ advertiser hesabinda 1000 VAULTT')
}

/* ─────────────────────── 2. SAC adresi ─────────────────────── */

head('2/5  Asset\'in SAC (Soroban) sarmalayicisi deploy ediliyor')
// `contract id asset` yalnizca adresi HESAPLAR, zincirde ORNEKLEMEZ —
// deposit sirasinda "instance yok" hatasi tam bunun icin cikiyordu.
// `contract asset deploy` hem hesaplar hem zincirde gercekten olusturur.
const tokenId = stellarCli([
  'contract', 'asset', 'deploy', '--asset', `${ASSET.getCode()}:${ASSET.getIssuer()}`, '--network', 'testnet',
], issuer.secret())
log(`  SAC token id: ${tokenId}`)

/* ─────────────────────── 3. kontrat deploy ─────────────────────── */

head('3/5  dwell_vault deploy — admin = proje faucet cuzdani, pay %50/%50')
const wasmPath = join(KOK, 'contracts', 'vault', 'target', 'wasm32v1-none', 'release', 'dwell_vault.wasm')
const faucet = faucetKeypair()
const contractId = stellarCli([
  'contract', 'deploy',
  '--wasm', wasmPath,
  '--network', 'testnet',
  '--', '--admin', faucet.publicKey(), '--token', tokenId,
  '--platform', platform.publicKey(), '--publisher_bps', '5000',
], faucet.secret())
log(`  Contract ID: ${contractId}`)
log(`  Platform adresi: ${platform.publicKey()}`)
log(`  ${EXPLORER}/contract/${contractId}`)

/* ─────────────────────── 4. deposit + release ─────────────────────── */

head('4/5  deposit(advertiser, 400) -> release(advertiser, publisher, 150) — %50/%50 boler')

const invoke = (fn, args, secret) => stellarCli([
  'contract', 'invoke', '--id', contractId, '--network', 'testnet', '--send=yes', '--', fn, ...args,
], secret)

// SAC tutarlari, projenin geri kalaninda oldugu gibi, TAM SAYI stroop
// (1e-7) — ondalikli deger degil. 40 VAULTT = 400_000_000 stroop.
// (Ilk denemede bunu unutup ham "400" gecirdik: kontrat dogru calisti,
// ama fiilen 0.00000400 VAULTT tasidi — kontrat degil, cagrinin birimi
// yanlisti. ADR-005'teki "para tam sayidir" kuralinin zincir tarafindaki
// karsiligi tam da bu.)
const VAULTT_DEPOSIT = 400_000_000n
const VAULTT_RELEASE = 150_000_000n

const depositOut = invoke('deposit', ['--advertiser', advertiser.publicKey(), '--amount', String(VAULTT_DEPOSIT)], advertiser.secret())
log(`  deposit sonucu (kalan bakiye, stroop): ${depositOut}`)

const releaseOut = invoke('release', [
  '--advertiser', advertiser.publicKey(), '--publisher', publisher.publicKey(), '--amount', String(VAULTT_RELEASE),
], faucet.secret())
log(`  release sonucu (kalan bakiye, stroop): ${releaseOut}`)

/* ─────────────────────── 5. dogrulama ─────────────────────── */

head('5/5  Zincirden dogrulama')
const balOut = invoke('balance', ['--advertiser', advertiser.publicKey()], faucet.secret())
log(`  vault.balance(advertiser) = ${balOut} stroop  (beklenen: ${VAULTT_DEPOSIT - VAULTT_RELEASE})`)

async function classicBalance(pk, retries = 3) {
  for (let i = 1; i <= retries; i++) {
    try {
      const acc = await server.loadAccount(pk)
      return acc.balances.find((b) => b.asset_code === 'VAULTT')?.balance ?? '0'
    } catch (e) {
      if (i === retries) throw e
      await new Promise((res) => setTimeout(res, 1000 * i))
    }
  }
}

const pubBal = await classicBalance(publisher.publicKey())
log(`  publisher classic cuzdan bakiyesi = ${pubBal} VAULTT  (beklenen: 7.5000000 — %50 pay)`)
const platBal = await classicBalance(platform.publicKey())
log(`  platform classic cuzdan bakiyesi  = ${platBal} VAULTT  (beklenen: 7.5000000 — %50 pay)`)

log(`\n  Kontrat: ${EXPLORER}/contract/${contractId}`)
log(`  Advertiser: ${EXPLORER}/account/${advertiser.publicKey()}`)
log(`  Publisher: ${EXPLORER}/account/${publisher.publicKey()}`)
log(`  Platform: ${EXPLORER}/account/${platform.publicKey()}`)
