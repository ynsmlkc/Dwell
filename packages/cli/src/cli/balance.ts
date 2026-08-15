/**
 * `dwell balance` — kullanicinin parasini gosterir.
 *
 * Uc ayri sayi var ve UCU DE gosterilmek zorunda:
 *
 *   bekleyen    gosterim sayildi ama henuz dogrulanmadi. Ledger'da YOK,
 *               cunku dogrulanana kadar para degil. Kaybolabilir.
 *   odenebilir  dogrulandi, defterde duruyor. Bu para kullanicinin.
 *   yolda       zincire gonderildi, onay bekleniyor.
 *
 * Tek bir "bakiye" gostermek bunlari birlestirmek olurdu ve kullanici
 * "dun 5 dolarim vardi, bugun 3" dediginde hicbir aciklama olmazdi.
 *
 * Odeme neden yapilmadigi da HER ZAMAN yazilir (§6.5). "Bekle" demek yeterli
 * degil — neyin beklendigi soylenmeli, yoksa kullanici sistemin bozuk
 * oldugunu dusunur ve haklidir.
 */

import { loadCredentials } from '../credentials.js'
import { out, ok, warn, info, fail, dim, bold, green, yellow, usdc, banner, rows } from './output.js'

export interface BalanceResponse {
  readonly pendingStroops: string
  readonly payableStroops: string
  readonly inFlightStroops: string
  readonly lifetimeStroops: string
  readonly payoutThresholdStroops: string
  readonly recentPayouts: readonly {
    readonly txHash: string
    readonly amountStroops: string
    readonly at: number
    readonly state: string
  }[]
  readonly blockedReason: string | null
}

// Testnet — mainnet SOW kapsami disinda (§13). Ag degisirse burasi da degisir.
const EXPLORER = 'https://stellar.expert/explorer/testnet/tx'

export async function cmdBalance(
  argv: readonly string[] = [],
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const creds = loadCredentials()
  if (!creds) fail('DWL-2001', 'Giris yapilmamis', '`dwell login` ile cuzdanini bagla')

  let res: Response
  try {
    res = await fetchImpl(`${creds.serverUrl}/v1/me/balance`, {
      headers: { authorization: `Bearer ${creds.token}` },
      signal: AbortSignal.timeout(15_000),
    })
  } catch (e) {
    // Ag hatasi bir SORU degil, bir DURUM. Kullaniciya ne yapacagini soyle.
    fail('DWL-3001', 'Sunucuya ulasilamadi', e instanceof Error ? e.message : String(e))
  }

  if (res.status === 401) {
    fail('DWL-2002', 'Token gecersiz', '`dwell login --force` ile tekrar bagla')
  }
  if (!res.ok) fail('DWL-3001', `Sunucu hatasi (HTTP ${res.status})`)

  const b = (await res.json()) as BalanceResponse
  render(b, creds.publisherId, argv.includes('--json') ? JSON.stringify(b) : null)
}

function render(b: BalanceResponse, address: string, jsonOut: string | null): void {
  if (jsonOut !== null) { out(jsonOut); return }

  const pending = BigInt(b.pendingStroops)
  const payable = BigInt(b.payableStroops)
  const inFlight = BigInt(b.inFlightStroops)
  const threshold = BigInt(b.payoutThresholdStroops)

  banner()
  rows([
    ['odenebilir', `${bold(green(usdc(payable)))}`],
    ['bekleyen', `${usdc(pending)} ${dim('· dogrulanmayi bekliyor')}`],
    ...(inFlight > 0n
      ? [['yolda', `${usdc(inFlight)} ${dim('· zincirde onay bekleniyor')}`] as const]
      : []),
    ['toplam kazanc', dim(usdc(b.lifetimeStroops))],
  ])

  out()
  out(`  ${dim('cuzdan')}  ${address}`)
  out()

  /* ── odeme ne zaman ── */

  if (payable >= threshold) {
    ok(`esik asildi — bir sonraki odeme turunda gonderilecek`)
  } else if (b.blockedReason) {
    const kalan = threshold - payable
    warn(`${usdc(kalan)} daha gerekiyor ${dim(`(esik ${usdc(threshold)})`)}`)
    // Sunucunun kendi gerekcesi farkliysa onu da goster — esik disinda bir
    // sebep olabilir (cuzdan bekleme suresi, trustline eksigi).
    if (!/esik/i.test(b.blockedReason)) info(dim(b.blockedReason))
  } else {
    info(dim('odeme bekleniyor'))
  }

  /* ── gecmis ── */

  if (b.recentPayouts.length > 0) {
    out()
    out(`  ${dim('son odemeler')}`)
    for (const p of b.recentPayouts.slice(0, 5)) {
      const isaret = p.state === 'settled' ? green('✓') : yellow('·')
      const tarih = new Date(p.at).toLocaleDateString()
      // OSC 8: destekleyen terminalde tiklanabilir, desteklemeyende duz metin.
      // Ikisi de calisir; link'i gizlemek yerine ikisini de veriyoruz.
      out(`  ${isaret} ${usdc(p.amountStroops).padEnd(10)} ${dim(tarih)}  ${dim(link(p.txHash))}`)
    }
  }

  out()
}

/** Terminal destekliyorsa tiklanabilir link, degilse kisa hash. */
export function link(txHash: string, isTty = process.stdout.isTTY === true): string {
  const kisa = `${txHash.slice(0, 8)}\u2026`
  if (!isTty) return kisa               // boruya yazarken kacis dizisi yollamayiz

  // OSC 8. Desteklemeyen terminaller diziyi yutar, yalnizca metni basar;
  // destekleyende tiklanabilir olur. Sonlandirici olarak `\u0007` (BEL)
  // kullaniliyor: ST (`ESC \\`) eski terminallerde daha kotu bozuluyor.
  const url = `${EXPLORER}/${txHash}`
  return `\u001b]8;;${url}\u0007${kisa}\u001b]8;;\u0007`
}
