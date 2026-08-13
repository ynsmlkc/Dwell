#!/usr/bin/env node
/**
 * Kivilcim 2 — Stellar batch odeme kanit script'i.  ATILACAK KOD.
 *
 * Kanitlamaya calistigi 5 sey (hepsi PROJECT.md §8'deki tuzaklara karsilik gelir):
 *
 *   1. Tuzak #1 — tek bir hedefin trustline'i yoksa TUM transaction patlar.
 *   2. Tuzak #7 — patlayan transaction yine de bir hash uretir. "settled" demek
 *                 icin `successful === true` bakmak ZORUNLU.
 *   3. op_index  — hangi hedefin patlattigini ancak operation indeksinden bulursun.
 *                 Bu yuzden payout_items.op_index kolonu zorunlu.
 *   4. ADR-006   — ucret operation basina. Batch ucret KAZANDIRMAZ.
 *   5. stroops   — bigint -> SDK amount string donusumu float'a dusmeden yapilir.
 *
 * Kullanim:  npm install && npm run spike
 */

import {
  Keypair, Networks, TransactionBuilder, Operation, Asset, Horizon,
} from '@stellar/stellar-sdk'

const HORIZON = 'https://horizon-testnet.stellar.org'
const FRIENDBOT = 'https://friendbot.stellar.org'
const NETWORK = Networks.TESTNET
const FEE_PER_OP = '1000'          // cömert bid — surge sigortasi ucuz (§8 tuzak #13)
const EXPLORER = 'https://stellar.expert/explorer/testnet'

const server = new Horizon.Server(HORIZON)

/* ─────────────────────────── yardimcilar ─────────────────────────── */

const log = (...a) => console.log(...a)
const head = (t) => log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`)
const short = (pk) => `${pk.slice(0, 6)}…${pk.slice(-4)}`

/**
 * ADR-005: tutarlar bigint stroop (1e-7). SDK ise ondalikli STRING istiyor
 * ve 7 haneden fazla ondalikta exception atiyor.
 * Number(v)/1e7 YASAK: 2^53 stroop ustunde precision kaybeder ve
 * "float yasak" kuralini cigner. Saf bigint aritmetigi:
 */
export function stroopsToAmount(stroops) {
  if (typeof stroops !== 'bigint') throw new TypeError('bigint bekleniyor')
  if (stroops <= 0n) throw new RangeError('amount > 0 olmali — 0 tek basina tum tx\'i gecersiz kilar')
  const neg = stroops < 0n
  const v = neg ? -stroops : stroops
  const whole = v / 10_000_000n
  const frac = (v % 10_000_000n).toString().padStart(7, '0').replace(/0+$/, '')
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`
}

async function friendbot(pk, label) {
  for (let i = 1; i <= 4; i++) {
    const r = await fetch(`${FRIENDBOT}?addr=${pk}`)
    if (r.ok) { log(`  ✓ ${label.padEnd(14)} ${short(pk)} fonlandi`); return }
    if (i === 4) throw new Error(`friendbot ${label} icin basarisiz: ${r.status}`)
    await new Promise((res) => setTimeout(res, 1500 * i))
  }
}

async function submit(tx, { expectFailure = false } = {}) {
  try {
    const res = await server.submitTransaction(tx)
    return { ok: true, hash: res.hash, successful: res.successful, raw: res }
  } catch (e) {
    const extras = e?.response?.data?.extras
    if (!extras && !expectFailure) throw e
    return {
      ok: false,
      hash: e?.response?.data?.hash ?? null,
      txCode: extras?.result_codes?.transaction ?? '?',
      opCodes: extras?.result_codes?.operations ?? [],
      resultXdr: extras?.result_xdr ?? null,
    }
  }
}

/* ─────────────────────────── 1. hesaplar ─────────────────────────── */

head('1/6  Testnet hesaplari aciliyor (friendbot)')

const issuer = Keypair.random()        // sahte "USDC" ihracci — sadece bu spike icin
const payout = Keypair.random()        // platformun odeme yapan hesabi
const pubs = [
  { name: 'publisher-1', kp: Keypair.random(), trustline: true },
  { name: 'publisher-2', kp: Keypair.random(), trustline: true },
  { name: 'publisher-3', kp: Keypair.random(), trustline: true },
  { name: 'publisher-4', kp: Keypair.random(), trustline: false }, // ← kasten bozuk
]

await friendbot(issuer.publicKey(), 'issuer')
await friendbot(payout.publicKey(), 'payout')
for (const p of pubs) await friendbot(p.kp.publicKey(), p.name)

const ASSET = new Asset('DWELLT', issuer.publicKey())
log(`\n  Asset: ${ASSET.getCode()}:${short(ASSET.getIssuer())}`)
log('  NOT: gercek urunde Circle testnet USDC kullanilacak (§8 tuzak #8).')
log('       Burada kendi asset\'imiz, spike tek komutla calissin diye.')

/* ─────────────────────── 2. trustline'lar ────────────────────────── */

head('2/6  Trustline\'lar aciliyor — publisher-4 KASTEN atlaniyor')

for (const p of [...pubs.filter((x) => x.trustline), { name: 'payout', kp: payout }]) {
  const acc = await server.loadAccount(p.kp.publicKey())
  const tx = new TransactionBuilder(acc, { fee: FEE_PER_OP, networkPassphrase: NETWORK })
    .addOperation(Operation.changeTrust({ asset: ASSET }))
    .setTimeout(180)
    .build()
  tx.sign(p.kp)
  await submit(tx)
  log(`  ✓ ${p.name.padEnd(14)} trustline acildi`)
}
log(`  ✗ publisher-4    trustline YOK  ← batch'i patlatacak olan bu`)

/* ──────────────────── 3. payout hesabini fonla ───────────────────── */

head('3/6  Payout hesabina asset yukleniyor')

{
  const acc = await server.loadAccount(issuer.publicKey())
  const tx = new TransactionBuilder(acc, { fee: FEE_PER_OP, networkPassphrase: NETWORK })
    .addOperation(Operation.payment({
      destination: payout.publicKey(), asset: ASSET, amount: '1000',
    }))
    .setTimeout(180)
    .build()
  tx.sign(issuer)
  await submit(tx)
  log('  ✓ payout hesabinda 1000 DWELLT')
}

/* ───────────── 4. BATCH DENEMESI — 4 hedef, biri bozuk ───────────── */

head('4/6  Batch #1 — 4 hedef (biri trustline\'siz).  Beklenen: TAMAMEN PATLAR')

const amounts = [1_500_000n, 3_200_000n, 800_000n, 2_100_000n]   // stroop (1e-7)
amounts.forEach((s, i) => log(`  ${pubs[i].name}: ${s} stroop → "${stroopsToAmount(s)}" DWELLT`))

let acc = await server.loadAccount(payout.publicKey())
let b1 = new TransactionBuilder(acc, { fee: FEE_PER_OP, networkPassphrase: NETWORK })
for (const [i, p] of pubs.entries()) {
  b1 = b1.addOperation(Operation.payment({
    destination: p.kp.publicKey(), asset: ASSET, amount: stroopsToAmount(amounts[i]),
  }))
}
const tx1 = b1.setTimeout(180).build()
tx1.sign(payout)

// PROJECT.md §8 tuzak #9: submit ONCESI imzali envelope kaydedilir, retry'da
// asla yeniden insa edilmez.
//
// KRITIK: hash SUBMIT ETMEDEN yerel olarak hesaplanabilir. Yani "submit ettim
// ama cevap gelmedi" durumunda bile hash'i bilirsin ve mutabakat kurabilirsin.
// Horizon'un hata cevabindan hash beklemek YANLIS — bazen dondurmuyor.
const envelope1 = tx1.toXDR()
const hash1 = tx1.hash().toString('hex')
log(`\n  envelope_xdr kaydedildi (${envelope1.length} karakter) — retry ayni byte'lari gonderir`)
log(`  tx_hash SUBMIT ONCESI biliniyor: ${hash1}`)
log(`  toplam ucret: ${Number(FEE_PER_OP) * 4} stroop  (op basina ${FEE_PER_OP} × 4 op)`)

const r1 = await submit(tx1, { expectFailure: true })

if (r1.ok) {
  log('\n  ⚠ Beklenmedik: batch basarili oldu. Trustline kontrolunu gozden gecir.')
} else {
  log(`\n  ✗ PATLADI — transaction kodu: ${r1.txCode}`)
  log('\n  Operation bazinda sonuc:')
  r1.opCodes.forEach((code, i) => {
    const mark = code === 'op_success' ? '  ' : '← '
    log(`    op_index ${i}  ${pubs[i].name.padEnd(14)} ${code.padEnd(14)} ${mark}${code !== 'op_success' ? 'SUCLU' : ''}`)
  })
  const bad = r1.opCodes.findIndex((c) => c !== 'op_success')
  log(`\n  KANIT — tuzak #1: ${pubs[bad].name} yuzunden ${pubs.length - 1} masum publisher da odeme alamadi.`)
  log(`  KANIT — op_index: suclunun kim oldugu ancak indeks ${bad}'ten bulunabildi.`)
  log('           payout_items.op_index kolonu bu yuzden zorunlu.')
}

/* ──────────── 5. BATCH #2 — bozuk hedef dusuruldu ────────────────── */

head('5/6  Batch #2 — bozuk hedef dusuruldu, 3 hedef.  Beklenen: BASARILI')

const good = pubs.filter((p) => p.trustline)
acc = await server.loadAccount(payout.publicKey())
let b2 = new TransactionBuilder(acc, { fee: FEE_PER_OP, networkPassphrase: NETWORK })
good.forEach((p, i) => {
  b2 = b2.addOperation(Operation.payment({
    destination: p.kp.publicKey(), asset: ASSET, amount: stroopsToAmount(amounts[i]),
  }))
})
const tx2 = b2.setTimeout(180).build()
tx2.sign(payout)

const r2 = await submit(tx2)
log(`  hash: ${r2.hash}`)

/* ─────────────── 6. SETTLED kontrolu — tuzak #7 ──────────────────── */

head('6/6  "settled" kontrolu — tuzak #7')

async function isSettled(hash) {
  if (!hash) return { settled: false, reason: 'hash yok — hic submit edilmemis' }
  const rec = await server.transactions().transaction(hash).call()
  return {
    settled: rec.successful === true,
    reason: rec.successful ? 'successful === true' : 'ledger\'a girdi AMA successful === false',
    ledger: rec.ledger_attr ?? rec.ledger,
    feeCharged: rec.fee_charged,
  }
}

const s2 = await isSettled(r2.hash)
log(`  Batch #2 → settled: ${s2.settled}  (${s2.reason})`)
log(`            ledger ${s2.ledger}, tahsil edilen ucret ${s2.feeCharged} stroop`)

// Batch #1'i YEREL hesaplanan hash ile sorguluyoruz — Horizon'un hata cevabina
// guvenmiyoruz. Gercek urunde de mutabakat bu hash uzerinden kurulur.
try {
  const s1 = await isSettled(hash1)
  log(`\n  Batch #1 → settled: ${s1.settled}  (${s1.reason})`)
  log(`            ledger ${s1.ledger}, tahsil edilen ucret ${s1.feeCharged} stroop`)
  log('\n  KANIT — tuzak #7: patlayan transaction LEDGER\'A GIRDI. Hash\'i var,')
  log('           Horizon\'da goruntuleniyor, ucreti tahsil edildi — ama hicbir')
  log('           odeme gerceklesmedi. "ledger\'a girdi" ile "odendi" AYNI SEY DEGIL.')
  log('           settled = successful === true  ← tek dogru tanim.')
} catch (e) {
  if (e?.response?.status === 404) {
    log(`\n  Batch #1 → Horizon'da bulunamadi (404). Hic dahil edilmemis.`)
    log('           Bu durumda kural (tuzak #10): max_time gecene kadar AYNI')
    log('           envelope tekrar gonderilir; yeniden insa edilmez.')
  } else throw e
}

/* ───────────────────────────── ozet ──────────────────────────────── */

head('SONUC')
log(`  Basarili batch : ${EXPLORER}/tx/${r2.hash}`)
log(`  Patlayan batch : ${EXPLORER}/tx/${hash1}`)
log(`  Payout hesabi  : ${EXPLORER}/account/${payout.publicKey()}`)
log('\n  Odenen publisher\'lar:')
good.forEach((p, i) => log(`    ${p.name}  ${stroopsToAmount(amounts[i]).padStart(10)} DWELLT  ${EXPLORER}/account/${p.kp.publicKey()}`))
log(`\n  Odenemeyen: publisher-4 (trustline yok) — ADR-020 geregi bind asamasinda reddedilmeliydi.`)
log('')
