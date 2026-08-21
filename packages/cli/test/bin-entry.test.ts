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
import { existsSync, mkdtempSync, symlinkSync, rmSync, mkdirSync, copyFileSync, writeFileSync, readFileSync } from 'node:fs'
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

/**
 * Gecici konumdan kurulum REDDEDILMELI.
 *
 * `npx dwellsh init` paketi `~/.npm/_npx/<hash>/` altina indirir ve kurulum
 * settings.json'a O YOLU yazar. Klasor gecicidir; silindigi gun statusLine
 * olmayan bir dosyayi cagirir, reklam durur ve sebebi gorunmez.
 *
 * Bugun calisip yarin sessizce bozulan bir kurulum, hic kurulmamis
 * olmaktan kotudur — o yuzden basta durduruyoruz.
 */
describe.skipIf(!derlenmis)('gecici konumdan kurulum', () => {
  function initDene(paketKoku: string): { kod: number; cikti: string } {
    const claude = mkdtempSync(join(tmpdir(), 'dwell-cfg-'))
    try {
      const out = execFileSync(process.execPath, [join(paketKoku, 'dist', 'dwell.mjs'), 'init'], {
        encoding: 'utf8', stdio: 'pipe',
        env: { ...process.env, CLAUDE_CONFIG_DIR: claude, DWELL_HOME: mkdtempSync(join(tmpdir(), 'dwell-h-')) },
      })
      return { kod: 0, cikti: out }
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string }
      return { kod: err.status ?? -1, cikti: (err.stdout ?? '') + (err.stderr ?? '') }
    }
  }

  it('_npx onbelleginden kurulmaz ve NEDEN oldugunu soyler', () => {
    // npm'in npx yerlesimini taklit et.
    const sahte = mkdtempSync(join(tmpdir(), 'dwell-npxsim-'))
    const kok = join(sahte, '_npx', 'abc123', 'node_modules', 'dwellsh')
    mkdirSync(join(kok, 'dist'), { recursive: true })
    copyFileSync(DIST, join(kok, 'dist', 'dwell.mjs'))
    writeFileSync(join(kok, 'package.json'), JSON.stringify({ name: 'dwellsh', version: '0.0.0' }))

    const r = initDene(kok)
    expect(r.kod).not.toBe(0)                       // sessizce basarili DONMEZ
    expect(r.cikti).toContain('npm i -g dwellsh')   // ne yapacagini soyler
  })
})

/** Sitedeki komut ile paketin gercekten sagladigi sey ayni olmali. */
describe('sitedeki kurulum komutu', () => {
  const oku = (p: string) =>
    readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')

  it('site kalici kurulum komutu gosteriyor, npx degil', () => {
    for (const p of ['../../server/public/index.html', '../../server/public/app/index.html']) {
      const h = oku(p)
      expect(h).toContain('npm i -g dwellsh')
      expect(h).not.toContain('npx dwellsh init')
    }
  })

  it('README de ayni komutu veriyor', () => {
    const r = oku('../README.md')
    expect(r).toContain('npm i -g dwellsh')
    expect(r).not.toContain('npx dwellsh init')
  })

  /**
   * Ekranda yazan ile panoya kopyalanan AYNI komut olmali.
   *
   * Ikisi ayri yerde duruyor: biri HTML govdesinde (`&amp;&amp;` kacisli),
   * digeri JS dizesinde (`&&` ciplak). Birini guncelleyip otekini unutmak
   * kolay, ve sonucu sinsi: kullanici ekranda dogru komutu gorur, panoya
   * eskisi yapisir.
   */
  it('kopyalanan metin ile ekranda yazan ayni', () => {
    const h = oku('../../server/public/index.html')
    const panoda = /copyButton\(\$\('#copy-install'\), \(\) => '([^']+)'/.exec(h)?.[1]
    expect(panoda).toBeTruthy()
    expect(h).toContain(panoda!.replace(/&/g, '&amp;'))
  })

  /** Spinner katmani ISTENIYORSA komutta bayragi olmali — init onu varsayilan kurmuyor. */
  it('spinner isteniyorsa komut --spinner tasiyor', () => {
    const h = oku('../../server/public/index.html')
    const panoda = /copyButton\(\$\('#copy-install'\), \(\) => '([^']+)'/.exec(h)?.[1] ?? ''
    expect(panoda).toContain('--spinner')
    expect(oku('../README.md')).toContain('--spinner')
  })
})
