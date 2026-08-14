/**
 * Spinner katmanini aktif reklamla senkronlar — ADR-001.
 *
 * `spinnerVerbs` STATIK bir listedir: Claude Code onu `settings.json`'dan
 * okur ve bize hicbir sinyal gondermez. Reklami degistirmenin tek yolu
 * dosyayi yeniden yazmak.
 *
 * Bu yuzden spinner yalnizca bir GORUNURLUK katmanidir; sayim ve
 * faturalandirma tamamen `statusLine`'a dayanir.
 *
 * Yazma kurallari:
 *   • Yalnizca marka DEGISTIGINDE yazilir — saniyede bir dosya yazmayiz
 *   • Yalnizca alan BIZIMSE yazilir (`__dwell` izi); kullanicinin veya
 *     baska bir aracin ayarina dokunulmaz
 *   • Gecici dosya + rename ile atomik: yarim yazilmis bir `settings.json`
 *     kullanicinin Claude Code'unu bozar
 *   • Hata YUTULUR: spinner guncellenememesi urunu durdurmaz
 */

import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'node:fs'
import { SETTINGS_PATH, MARKER, type ClaudeSettings } from '../settings.js'
import { DISCLOSURE_GLYPH } from '@dwell/protocol'

export interface SpinnerSyncOptions {
  readonly path?: string
  readonly onError?: (e: unknown) => void
}

export class SpinnerSync {
  #lastBrand: string | null = null
  readonly #path: string
  readonly #onError: (e: unknown) => void

  constructor(opts: SpinnerSyncOptions = {}) {
    this.#path = opts.path ?? SETTINGS_PATH
    this.#onError = opts.onError ?? (() => {})
  }

  /**
   * Aktif reklamin markasini spinner'a yazar.
   *
   * `null` verilirse spinner temizlenir — reklam gosterilmiyorsa spinner'da
   * eski marka asili kalmamali.
   */
  sync(brand: string | null): void {
    if (brand === this.#lastBrand) return          // degismedi, dosyaya dokunma

    try {
      if (!existsSync(this.#path)) return
      const settings = JSON.parse(readFileSync(this.#path, 'utf8')) as ClaudeSettings

      // Alan bizim degilse DOKUNMA. Kullanici kendi spinner'ini ayarlamis
      // olabilir ya da baska bir arac oraya yazmis olabilir.
      if (settings.spinnerVerbs && settings.spinnerVerbs[MARKER] !== true) return
      if (!settings.spinnerVerbs) return           // spinner katmani kurulu degil

      // ADR-013: spinner'da da ifsa glifi zorunlu. Kullanici `Firecrawl…`
      // gorup Claude Code'un kendi kelimesi sanmamali.
      settings.spinnerVerbs = {
        mode: 'replace',
        verbs: brand ? [`${DISCLOSURE_GLYPH} ${brand}`] : [],
        [MARKER]: true,
      }

      const tmp = `${this.#path}.dwell-tmp`
      writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 })
      renameSync(tmp, this.#path)                  // atomik yer degistirme
      this.#lastBrand = brand
    } catch (e) {
      // Spinner guncellenememesi urunu durdurmaz. statusLine calismaya
      // devam eder ve sayim ondan gelir.
      this.#onError(e)
      try { unlinkSync(`${this.#path}.dwell-tmp`) } catch { /* onemsiz */ }
    }
  }

  /** Kapanirken spinner'i temizle — olu bir marka asili kalmasin. */
  clear(): void { this.sync(null) }
}
