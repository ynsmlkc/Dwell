/**
 * Gosterim kuyrugu — offline dayaniklilik (ADR-003).
 *
 * Gosterimler once DISKE yazilir, sonra toplu gonderilir. Internet giderse,
 * daemon carparsa, makine uyursa kayip olmaz.
 *
 * Tasarim: append-only JSONL + ayri bir "gonderildi" isareti.
 *
 * Neden JSONL: her satir bagimsiz. Dosya yarim yazilmis bir satirla biterse
 * (guc kesildi) yalnizca o satir kaybolur, dosyanin tamami degil. Tek bir
 * buyuk JSON nesnesi olsaydi bozuk dosya = tum kuyruk kaybi olurdu.
 *
 * Neden ayri isaret dosyasi degil de satir icinde `sent`: gonderim sonrasi
 * dosyayi yeniden yazmak, tam o anda gelen yeni gosterimleri kaybetme riski
 * yaratir. Bunun yerine gonderilenlerin ID'leri ayri bir dosyaya eklenir ve
 * dosya ancak **guvenli bir anda** sikistirilir.
 */

import { appendFileSync, readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { CompletedImpression } from './turns.js'

export interface QueueOptions {
  readonly dir: string
  /** Bu sayiyi asinca sikistirma denenir. */
  readonly compactAfter?: number
  /** Kuyruk bu boyutu asarsa EN ESKI kayitlar dusurulur — disk dolmasin. */
  readonly maxEntries?: number
  readonly onError?: (e: unknown) => void
}

export class ImpressionQueue {
  readonly #pendingPath: string
  readonly #sentPath: string
  readonly #compactAfter: number
  readonly #maxEntries: number
  readonly #onError: (e: unknown) => void
  #appendCount = 0

  constructor(opts: QueueOptions) {
    mkdirSync(opts.dir, { recursive: true, mode: 0o700 })
    this.#pendingPath = join(opts.dir, 'impressions.jsonl')
    this.#sentPath = join(opts.dir, 'impressions.sent')
    this.#compactAfter = opts.compactAfter ?? 500
    this.#maxEntries = opts.maxEntries ?? 50_000
    this.#onError = opts.onError ?? (() => {})
  }

  /**
   * Diske yazar. Senkron — cunku bu cagri daemon'in tick yolunda ve
   * kaybolmasi kabul edilemez. Tek satir append, mikrosaniyeler surer.
   */
  add(imp: CompletedImpression): void {
    try {
      appendFileSync(this.#pendingPath, JSON.stringify(imp) + '\n', { mode: 0o600 })
      if (++this.#appendCount >= this.#compactAfter) { this.#appendCount = 0; this.compact() }
    } catch (e) {
      // Disk doluysa veya izin yoksa: gosterim kaybolur ama daemon YASAR.
      // Kullanicinin Claude Code'unu bozmak, bir gosterim kaybetmekten kotudur.
      this.#onError(e)
    }
  }

  /** Henuz gonderilmemis kayitlar. */
  pending(): CompletedImpression[] {
    const sent = this.#readSent()
    return this.#readAll().filter((i) => !sent.has(i.id))
  }

  /**
   * Gonderim basarili — ID'ler isaretlenir.
   *
   * Satirlar dosyadan SILINMEZ. Silmek icin dosyayi yeniden yazmak gerekir ve
   * o sirada gelen yeni gosterim kaybolabilir. Isaretleme append-only oldugu
   * icin yaris kosulu yaratmaz.
   */
  markSent(ids: readonly string[]): void {
    if (ids.length === 0) return
    try {
      appendFileSync(this.#sentPath, ids.join('\n') + '\n', { mode: 0o600 })
    } catch (e) { this.#onError(e) }
  }

  /** Gonderilmis kayitlari dosyadan atar. Atomik: gecici dosya + rename. */
  compact(): void {
    try {
      const sent = this.#readSent()
      const keep = this.#readAll().filter((i) => !sent.has(i.id))

      // Kuyruk sisiyorsa en ESKI kayitlar dusurulur. Yeniyi atmak yanlis
      // olurdu: eski gosterimler zaten sunucuda reddedilme ihtimali yuksek.
      const trimmed = keep.length > this.#maxEntries ? keep.slice(-this.#maxEntries) : keep

      const tmp = this.#pendingPath + '.tmp'
      writeFileSync(tmp, trimmed.map((i) => JSON.stringify(i)).join('\n') + (trimmed.length ? '\n' : ''), { mode: 0o600 })
      renameSync(tmp, this.#pendingPath)          // atomik yer degistirme
      if (existsSync(this.#sentPath)) unlinkSync(this.#sentPath)
    } catch (e) { this.#onError(e) }
  }

  size(): number { return this.pending().length }

  /* ── ic isler ── */

  #readAll(): CompletedImpression[] {
    if (!existsSync(this.#pendingPath)) return []
    try {
      return readFileSync(this.#pendingPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .flatMap((line) => {
          // Yarim yazilmis son satir (guc kesintisi) sessizce atlanir.
          try { return [JSON.parse(line) as CompletedImpression] } catch { return [] }
        })
    } catch (e) { this.#onError(e); return [] }
  }

  #readSent(): Set<string> {
    if (!existsSync(this.#sentPath)) return new Set()
    try {
      return new Set(readFileSync(this.#sentPath, 'utf8').split('\n').filter(Boolean))
    } catch (e) { this.#onError(e); return new Set() }
  }
}
