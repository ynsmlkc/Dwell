/**
 * Paketin `bin` girdisi gercekten calisiyor mu?
 *
 * Gercekte yasandi ve en pahali hata sinifiydi: 0.1.0–0.1.6 arasi HICBIR
 * surum npm'den kurulunca calismiyordu. `bin` bir sembolik bag uretiyor
 * (`dwell`, uzantisiz), giris noktasi kontrolu ise dosya ADINI
 * karsilastiriyordu — `".../dwell.mjs".endsWith("dwell")` false.
 *
 * `main()` hic cagrilmadi. Hata yok, uyari yok, cikis kodu 0. `npx dwellsh
 * init` yazan kullanici mutlak sessizlik gordu.
 *
 * Gelistirmede gorunmedi cunku her test `node dist/dwell.mjs` ile, yani
 * dosya adiyla cagiriyordu. Bu dosya kullanicinin gectigi yoldan geciyor:
 * bir sembolik bag kurup ONUN uzerinden calistiriyor.
 *
 * Derlenmis cikti gerekiyor; `dist/` yoksa testler atlanir.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIST = fileURLToPath(new URL('../dist/dwell.mjs', import.meta.url))
const derlenmis = existsSync(DIST)

/** Verilen yoldan calistirir, stdout doner. */
function calistir(yol: string, ...args: string[]): string {
  return execFileSync(process.execPath, [yol, ...args], {
    encoding: 'utf8',
    env: { ...process.env, DWELL_HOME: mkdtempSync(join(tmpdir(), 'dwell-bin-')) },
  }).trim()
}

let baglanti: string
let dizin: string

beforeAll(() => {
  if (!derlenmis) return
  dizin = mkdtempSync(join(tmpdir(), 'dwell-bin-link-'))
  // npm'in kurdugu yapinin aynisi: uzantisiz bir isimle sembolik bag.
  baglanti = join(dizin, 'dwell')
  symlinkSync(DIST, baglanti)
})

describe.skipIf(!derlenmis)('paketin bin girdisi', () => {
  it('dosya adiyla dogrudan calisir', () => {
    expect(calistir(DIST, 'version')).toBe(
      JSON.parse(
        // package.json'daki surum — gomulu deger bununla ayni olmali
        require('node:fs').readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
      ).version,
    )
  })

  /** ASIL TEST: npm'in kurdugu uzantisiz sembolik bag uzerinden. */
  it('uzantisiz sembolik bag uzerinden de calisir', () => {
    const cikti = calistir(baglanti, 'version')
    expect(cikti).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('sembolik bag uzerinden help SESSIZ KALMAZ', () => {
    // Asil belirti buydu: cikis kodu 0, cikti sifir bayt.
    expect(calistir(baglanti, 'help').length).toBeGreaterThan(50)
  })

  it('bilinmeyen komut sembolik bag uzerinden de hata verir', () => {
    let hata: { status?: number } | null = null
    try {
      execFileSync(process.execPath, [baglanti, 'boyle-bir-komut-yok'], { stdio: 'pipe' })
    } catch (e) {
      hata = e as { status?: number }
    }
    // Sessizce basarili donmek, hatanin ta kendisiydi.
    expect(hata).not.toBeNull()
    expect(hata?.status).not.toBe(0)
  })

  it('package.json bin girdisi derlenmis dosyayi gosteriyor', () => {
    const pkg = JSON.parse(
      require('node:fs').readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { bin: Record<string, string> }
    for (const hedef of Object.values(pkg.bin)) {
      expect(existsSync(fileURLToPath(new URL('../' + hedef, import.meta.url)))).toBe(true)
    }
  })
})

if (derlenmis) {
  // Vitest surec sonunda temizlesin.
  process.on('exit', () => { try { rmSync(dizin, { recursive: true, force: true }) } catch { /* onemsiz */ } })
}
