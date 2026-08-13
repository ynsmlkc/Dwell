/**
 * Para — ADR-005.
 *
 * Birim **stroop** (1e-7 USDC), Stellar'in klasik varlik hassasiyeti.
 * `int64` tavani 9_223_372_036_854_775_807 stroop ≈ 922.337.203.685 USDC.
 *
 * Isimlendirme kurali: hicbir yerde `micros` YOK. "Micro" 1e-6 demektir,
 * birim 1e-7'dir; ikisi karisirsa 10x odeme hatasi olur (ADR-005).
 *
 * Float YASAK. Bu dosyada `number` yalnizca bps gibi tam sayi katsayilarda
 * gecer, hicbir zaman para tutarinda gecmez.
 */

declare const stroopsBrand: unique symbol

/** 1e-7 USDC. Ciplak `bigint` ile karistirilamaz — branded. */
export type Stroops = bigint & { readonly [stroopsBrand]: 'Stroops' }

/** 1 USDC = 10_000_000 stroop. */
export const SCALE = 10_000_000n

/** Stellar klasik varlik tutarlari int64 ile sinirli. */
export const MAX_STROOPS = 9_223_372_036_854_775_807n

export class MoneyError extends Error {
  override readonly name = 'MoneyError'
}

/** Ciplak bigint'i Stroops'a cevirir ve int64 sinirini dogrular. */
export function stroops(value: bigint): Stroops {
  if (typeof value !== 'bigint') throw new MoneyError('stroops() bigint bekler')
  if (value > MAX_STROOPS || value < -MAX_STROOPS) {
    throw new MoneyError(`int64 tasmasi: ${value}`)
  }
  return value as Stroops
}

export const ZERO = stroops(0n)

/* ─────────────────────────── aritmetik ─────────────────────────── */
// bigint operatorleri brand'i dusurdugu icin sarmalayicilar sart.

export const add = (a: Stroops, b: Stroops): Stroops => stroops(a + b)
export const sub = (a: Stroops, b: Stroops): Stroops => stroops(a - b)
export const neg = (a: Stroops): Stroops => stroops(-a)
export const sum = (xs: readonly Stroops[]): Stroops => xs.reduce(add, ZERO)

/* ──────────────────── SDK amount string donusumu ───────────────── */

/**
 * Stellar SDK `Operation.payment({ amount })` **ondalikli string** ister
 * ("1.5"), stroop degil, ve 7 haneden fazla ondalikta exception atar.
 *
 * `Number(v) / 1e7` YASAK: 2^53 stroop ustunde precision kaybeder ve
 * ADR-005'in "float yasak" kuralini cigner. Saf bigint aritmetigi:
 */
export function toAmountString(v: Stroops): string {
  if (v <= 0n) {
    // Yuvarlamayla sifira dusen tek bir item TUM transaction'i gecersiz kilar.
    throw new MoneyError(`amount > 0 olmali, gelen: ${v}`)
  }
  const whole = v / SCALE
  const frac = (v % SCALE).toString().padStart(7, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : `${whole}`
}

/** "1.5" → 15_000_000n. Round-trip testi icin ve Horizon cevaplarini okurken. */
export function fromAmountString(s: string): Stroops {
  if (!/^-?\d+(\.\d{1,7})?$/.test(s)) {
    throw new MoneyError(`gecersiz amount string: ${JSON.stringify(s)}`)
  }
  const neg = s.startsWith('-')
  const body = neg ? s.slice(1) : s
  const [whole = '0', frac = ''] = body.split('.')
  const v = BigInt(whole) * SCALE + BigInt(frac.padEnd(7, '0'))
  return stroops(neg ? -v : v)
}

/* ──────────────────────── gelir paylasimi ──────────────────────── */

/** Publisher payi, on binde. %50 = 5000 (ADR-011). */
export const DEFAULT_REV_SHARE_BPS = 5000

export interface RevenueSplit {
  readonly publisher: Stroops
  readonly platform: Stroops
}

/**
 * ADR-011 — gelir paylasimi.
 *
 * Platform payi ayrica hesaplanmaz, **artik** olarak alinir. Boylece
 * `publisher + platform === rate` her zaman kesin saglanir ve yuvarlama
 * bosluk birakmaz — ADR-005'in "ref basina toplam sifir" invariant'i
 * bu sayede tutar.
 *
 * NOT: ters kayit bu fonksiyonla YENIDEN HESAPLANMAZ. Clawback ve basarisiz
 * odeme geri alimi, orijinal entry'lerin `neg()` ile kopyalanmasiyla yazilir
 * (ADR-005). Negatif girdiyle yeniden hesaplamak yuvarlama artigini ters
 * yone dusurur ve invariant'i kirar.
 */
export function splitRevenue(
  rate: Stroops,
  bps: number = DEFAULT_REV_SHARE_BPS,
): RevenueSplit {
  if (rate < 0n) throw new MoneyError('splitRevenue negatif tutar kabul etmez — bkz. ADR-005 ters kayit kurali')
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw new MoneyError(`bps 0..10000 arasi tam sayi olmali, gelen: ${bps}`)
  }
  const publisher = stroops((rate * BigInt(bps)) / 10_000n)
  return { publisher, platform: sub(rate, publisher) }
}

/**
 * ADR-009 — teklif CPM cinsindendir (1.000 gosterim).
 * Gosterim basina oran = bid / 1000, kalan platform lehine atilir.
 */
export function rateFromCpm(bidCpm: Stroops): Stroops {
  if (bidCpm < 0n) throw new MoneyError('CPM negatif olamaz')
  return stroops(bidCpm / 1000n)
}

/**
 * Insan icin: 15_000_000n → "1.5 USDC". Sadece gosterim, hesapta kullanilmaz.
 * `toAmountString`'in aksine sifir ve negatifi kabul eder — bakiye ekraninda
 * "0 USDC" ve ters kayitlarda negatif gostermek gerekiyor.
 */
export function format(v: Stroops): string {
  if (v === 0n) return '0 USDC'
  const abs = stroops(v < 0n ? -v : v)
  return `${v < 0n ? '-' : ''}${toAmountString(abs)} USDC`
}
