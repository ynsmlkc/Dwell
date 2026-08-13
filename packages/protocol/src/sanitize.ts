/**
 * Reklam metni sanitizasyonu — ADR-007.
 *
 * Terminale basilan metin ucuncu tarafin (reklamverenin) yazdigi icerik.
 * Icine escape dizisi koyabilen bir reklamveren kullanicinin terminalinin
 * kontrolunu alir: cursor manipulasyonu, OSC 52 ile pano'ya yazma, ekran
 * temizleme, bazi terminallerde daha agiri.
 *
 * Bu yuzden model su: **reklamveren hicbir zaman stil kodu gonderemez.**
 * Yalnizca anlamsal alan gonderir (brand, text, cta); stili BIZ uretiriz.
 *
 * Bu dosya projedeki ilk gercek koddur (§12 M1) ve en yuksek riskli olandir.
 */

export const SANITIZE_VERSION = 1

/* ─────────────────────────── strip ─────────────────────────── */

/**
 * Tehlikeli kod noktalari. Hepsi **silinir**, kacisla saklanmaz —
 * terminale gidecek metinde bunlarin mesru bir kullanimi yok.
 */
const DANGEROUS = new RegExp(
  [
    '[\\u0000-\\u001F]',   // C0 kontrol — ESC (0x1B), BEL, CR, LF dahil
    '\\u007F',             // DEL
    '[\\u0080-\\u009F]',   // C1 kontrol — 8-bit CSI/OSC girisleri
    '[\\u200B-\\u200F]',   // sifir genislikli + LRM/RLM
    '[\\u202A-\\u202E]',   // bidi override — "trojan source" sinifi
    '[\\u2066-\\u2069]',   // bidi isolate
    '[\\u2028\\u2029]',    // satir/paragraf ayirici
    '\\uFEFF',             // BOM / zero-width no-break space
  ].join('|'),
  'gu',
)

/** Gorunur ama satiri bozan bosluklar — tek boslugua indirgenir. */
const ODD_SPACE = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/gu

/**
 * Iki ayri islem, bilincli olarak ayri tutuluyor:
 *
 *   normalize()      masum duzeltme — cift bosluk, NBSP, NFC farki. Sessizce.
 *   hasUnsafeChars() SALDIRI TESPITI — kontrol karakteri, bidi, sifir genislikli.
 *
 * Ayrimin sebebi: bir kreatifte ESC bulunmasi "biraz dagink girdi" degil,
 * **saldiri denemesidir.** Temizleyip yayinlamak yanlis, cunku ESC silinse
 * bile yuk kalir:  `Fire\x1B[31mcrawl` → `Fire[31mcrawl`.
 * Guvenli ama copluk, ve reklamverenin niyeti sessizce yutulmus olur.
 *
 * Dogru politika **reddetmektir**: sunucu kampanyayi kaydetmez ve reklamvereni
 * isaretler; istemci kirli bir kreatif geldiyse HICBIR SEY basmaz. Bu, ADR-003'un
 * "cache bossa satir gosterilmez" mantiginin aynisi — fail closed.
 */
export function normalize(input: string): string {
  return input
    .normalize('NFC')
    .replace(ODD_SPACE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Girdide saldiri isareti var mi? */
export function hasUnsafeChars(input: string): boolean {
  DANGEROUS.lastIndex = 0
  return DANGEROUS.test(input)
}

/**
 * Son savunma hatti — tehlikeli kod noktalarini siler.
 * Normal akista KULLANILMAZ; kirli girdi reddedilir. Yalnizca log'a veya
 * hata mesajina bir kullanici girdisi koyarken guvenli hale getirmek icin.
 */
export function stripUnsafe(input: string): string {
  return normalize(input.replace(DANGEROUS, ''))
}

/** Girdi tehlikeli bir sey iceriyor muydu? Sunucu tarafi reddi icin. */
export function isClean(input: string): boolean {
  return !hasUnsafeChars(input)
}

/* ─────────────────────────── genislik ─────────────────────────── */

/**
 * Gorunur genislik. Birlesen isaretler (combining marks) sifir sayilir;
 * CJK/emoji gibi genis karakterler iki sayilir. Bagimlilik eklememek icin
 * kaba ama yeterli bir yaklasim — statusLine'da bir-iki sutun sapma sorun degil.
 */
export function displayWidth(s: string): number {
  let w = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0)!
    if (cp >= 0x0300 && cp <= 0x036F) continue                 // combining
    if (cp >= 0xFE00 && cp <= 0xFE0F) continue                 // variation selector
    if (
      (cp >= 0x1100 && cp <= 0x115F) ||                        // Hangul Jamo
      (cp >= 0x2E80 && cp <= 0xA4CF) ||                        // CJK
      (cp >= 0xAC00 && cp <= 0xD7A3) ||                        // Hangul
      (cp >= 0xF900 && cp <= 0xFAFF) ||
      (cp >= 0xFF00 && cp <= 0xFF60) ||                        // fullwidth
      (cp >= 0x1F300 && cp <= 0x1FAFF)                         // emoji
    ) { w += 2; continue }
    w += 1
  }
  return w
}

/** Gorunur genislige gore kirp, sonuna tek nokta koy. */
export function truncate(s: string, max: number): string {
  if (max <= 0) return ''
  if (displayWidth(s) <= max) return s
  let out = ''
  for (const ch of s) {
    if (displayWidth(out + ch) > max - 1) break
    out += ch
  }
  return out.trimEnd() + '…'
}

/* ─────────────────────────── render ─────────────────────────── */

import type { Creative } from './schemas.js'

/** Terminale basilmaya hazir, dogrulanmis satir. */
export interface SanitizedAdLine {
  /** ANSI'li hali — sadece bizim urettigimiz kodlar. */
  readonly ansi: string
  /** Duz hali — log, test ve renksiz terminaller icin. */
  readonly plain: string
  readonly width: number
}

/** ADR-013: ifsa glifi. Hicbir yuzeyde atlanmaz — spinner'da bile. */
export const DISCLOSURE_GLYPH = '✶'

/**
 * Allowlist. Reklamveren ham stil kodu **gonderemez**; yalnizca burada
 * tanimli kodlar, yalnizca bizim sectigimiz yerlere uygulanir.
 */
const ESC = '\x1B'
const STYLE = {
  glyph: `${ESC}[38;5;208m`,
  brand: `${ESC}[1m`,
  dim: `${ESC}[2m`,
  reset: `${ESC}[0m`,
} as const

export const LIMITS = { brand: 20, text: 60, cta: 30 } as const

export class SanitizeError extends Error {
  override readonly name = 'SanitizeError'
}

/**
 * Fail-closed kapi. Kreatifin herhangi bir alaninda tehlikeli kod noktasi
 * varsa firlatir — cagiran taraf HICBIR SEY basmaz.
 *
 * Buraya dusen bir kreatif iki seyden birini gosterir: sunucu tarafi kontrolu
 * atlanmis, ya da tasima katmani kurcalanmis. Ikisi de "reklami temizleyip
 * goster" degil, "sus ve alarm uret" durumudur.
 */
export function assertClean(creative: Creative): void {
  for (const field of ['brand', 'text', 'cta'] as const) {
    const value = creative[field]
    if (value !== undefined && hasUnsafeChars(value)) {
      throw new SanitizeError(
        `kreatifin "${field}" alani kontrol/bidi karakteri iceriyor — reddedildi`,
      )
    }
  }
}

/**
 * Kreatifi terminale basilabilir satira cevirir.
 *
 * @param columns Terminal genisligi. statusLine icinde `tput cols` CALISMAZ
 *   (cikti yakalaniyor); `COLUMNS` env degiskeni okunur. Bilinmiyorsa 80.
 */
export function renderAdLine(creative: Creative, columns = 80): SanitizedAdLine {
  assertClean(creative)

  const brand = truncate(normalize(creative.brand), LIMITS.brand)
  const text = truncate(normalize(creative.text), LIMITS.text)
  const cta = creative.cta ? truncate(normalize(creative.cta), LIMITS.cta) : ''

  if (!brand) throw new SanitizeError('brand normalize sonrasi bos kaldi')
  if (!text) throw new SanitizeError('text normalize sonrasi bos kaldi')

  // Parcalar ayri tutulur; kirpma DUZ metin uzerinde yapilir, stil EN SON
  // eklenir. Ters sirada yaparsan ANSI dizisinin ortasindan kirpar ve
  // terminali bozarsin — tam olarak ADR-007'nin engellemeye calistigi sey.
  const SEP = ' — '
  const CTA_SEP = ' · '
  const budget = Math.max(20, columns - 1)
  const fixed = displayWidth(`${DISCLOSURE_GLYPH} ${brand}${SEP}`)

  let outText = text
  let outCta = cta

  // 1) Sigmiyorsa once cta atilir — en az bilgi tasiyan parca o.
  if (fixed + displayWidth(text) + (cta ? displayWidth(CTA_SEP + cta) : 0) > budget) {
    outCta = ''
  }
  // 2) Hala sigmiyorsa metin kisaltilir. Marka ve glif asla kirpilmaz.
  if (fixed + displayWidth(outText) > budget) {
    outText = truncate(text, Math.max(3, budget - fixed))
  }

  const tail = outCta ? `${CTA_SEP}${outCta}` : ''
  const plain = `${DISCLOSURE_GLYPH} ${brand}${SEP}${outText}${tail}`
  const ansi =
    `${STYLE.glyph}${DISCLOSURE_GLYPH}${STYLE.reset} ` +
    `${STYLE.brand}${brand}${STYLE.reset}` +
    `${SEP}${outText}` +
    (outCta ? `${STYLE.dim}${CTA_SEP}${outCta}${STYLE.reset}` : '')

  return { ansi, plain, width: displayWidth(plain) }
}

/**
 * Spinner verb'u — ADR-001 gorunurluk katmani.
 * Cok kisa olmali; Claude Code sonuna "…" ve sayaci kendisi ekliyor.
 * ADR-013 geregi burada da ifsa glifi zorunlu.
 */
export function renderSpinnerVerb(creative: Creative): string {
  assertClean(creative)
  const brand = truncate(normalize(creative.brand), LIMITS.brand)
  if (!brand) throw new SanitizeError('brand normalize sonrasi bos kaldi')
  return `${DISCLOSURE_GLYPH} ${brand}`
}
