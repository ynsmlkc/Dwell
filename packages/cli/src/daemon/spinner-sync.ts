/**
 * Spinner katmanini aktif reklamla senkronlar — ADR-001.
 *
 * OLCULDU (2026-08-14, temiz kosulda — tek yazar):
 * Claude Code `spinnerVerbs`'u **TUR BASINDA** okuyor. Tur ICINDE dosyayi
 * degistirmek o turu etkilemiyor; deger bir sonraki prompt'ta geciyor.
 *
 * Yontem: rakip urun ayni alani 7-37 saniyede bir yazarken ekran izlendi.
 * Dosya surekli degisti, spinner tur boyunca SABIT kaldi, sonraki
 * prompt'ta degisti. Ayni sinir rakipte de var.
 *
 * (Onceki olcum "oturum basinda sabitliyor" diyordu ve YANLISTI: o sirada
 * iki program ayni alana yaziyordu, hangi degerin ne zaman gecerli oldugu
 * ayirt edilemiyordu.)
 *
 * Sonuclari:
 *   • Tur ICINDE rotasyon imkansiz — bir tur boyunca tek reklam
 *   • Tur BASINA farkli reklam MUMKUN; deger tur bitiminde onceden yazilir
 *   • Liste her zaman DOLU tutulur; bosaltmak yeni turlarin varsayilanlara
 *     dusmesine yol acar
 *   • Spinner dogal olarak yalnizca model calisirken gorunur, yani ADR-023
 *     icin ayrica temizlemeye gerek yok
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
   * `null` GECILDIGINDE HICBIR SEY YAPILMAZ — liste dolu birakilir.
   *
   * Bosaltmak zararliydi: liste bosken acilan bir oturum Claude Code'un
   * varsayilan kelimelerine duser ve o oturum boyunca oyle kalir (canli
   * okuma yok). Dolu birakmak, yeni oturumlarin en azindan bir reklam
   * yakalamasini saglar.
   */
  sync(brand: string | null): void {
    if (brand === null) return                     // bkz. yukaridaki gerekce
    if (brand === this.#lastBrand) return          // degismedi, dosyaya dokunma
    this.#write([`${DISCLOSURE_GLYPH} ${brand}`])
    this.#lastBrand = brand
  }

  #write(verbs: string[]): void {
    try {
      if (!existsSync(this.#path)) return
      const settings = JSON.parse(readFileSync(this.#path, 'utf8')) as ClaudeSettings

      // Alan bizim degilse DOKUNMA. Kullanici kendi spinner'ini ayarlamis
      // olabilir ya da baska bir arac oraya yazmis olabilir.
      if (settings.spinnerVerbs && settings.spinnerVerbs[MARKER] !== true) return
      if (!settings.spinnerVerbs) return           // spinner katmani kurulu degil

      settings.spinnerVerbs = { mode: 'replace', verbs, [MARKER]: true }

      const tmp = `${this.#path}.dwell-tmp`
      writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 })
      renameSync(tmp, this.#path)                  // atomik yer degistirme
    } catch (e) {
      // Spinner guncellenememesi urunu durdurmaz. statusLine calismaya
      // devam eder ve sayim ondan gelir.
      this.#onError(e)
      try { unlinkSync(`${this.#path}.dwell-tmp`) } catch { /* onemsiz */ }
    }
  }

  /**
   * Kaldirma sirasinda listeyi bosaltir.
   *
   * Yalnizca `dwell uninstall` cagirir. Normal calismada liste ASLA
   * bosaltilmaz — bkz. `sync`.
   */
  clear(): void {
    this.#lastBrand = null
    this.#write([])
  }
}
