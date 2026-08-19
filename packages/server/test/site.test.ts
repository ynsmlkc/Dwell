/**
 * Sitenin sayfalari ile `app.js` arasindaki sozlesme.
 *
 * Gercekte yasandi: `/app` ve `/advertisers/app` sayfalari `app.js`'den
 * `login` istiyordu, `app.js` onu hic disa acmiyordu. ES modullerinde eksik
 * bir isim modulun TAMAMINI calistirmaz — sayfadaki her bolum `hidden`
 * baslayip JS ile aciliyor oldugu icin iki panel de BOMBOS aciliyordu.
 * Konsola bakmayan biri icin hicbir belirti yok: 200 doner, CSS yuklenir,
 * sayfa bos.
 *
 * Derleme adimi olmadigi icin bunu yakalayacak bir tip denetleyicisi de
 * yok. O boslugu bu dosya kapatiyor.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PUBLIC = join(fileURLToPath(new URL('../public', import.meta.url)))

/** public/ altindaki her .html — alt klasorler dahil. */
function htmlFiles(dir = PUBLIC, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    if (e.isDirectory()) return htmlFiles(join(dir, e.name), rel)
    return e.name.endsWith('.html') ? [rel] : []
  })
}

const appJs = readFileSync(join(PUBLIC, 'app.js'), 'utf8')

/**
 * `app.js`'in disa actigi isimler.
 *
 * `[^\s(=;]+` kullaniyoruz: isim `$` ve `$$` olabiliyor ve `\w+` bunlari
 * KACIRIYOR — bu testi yazarken once oyle yazdim ve `$` eksikmis gibi
 * gorundu, yanlis alarm verdi.
 */
const exported = new Set(
  [...appJs.matchAll(/^export\s+(?:async\s+)?(?:function|class|const|let)\s+([^\s(=;]+)/gm)]
    .map((m) => m[1]!),
)

/** Bir HTML dosyasinin `/app.js`'den istedigi isimler. */
function importsOf(html: string): string[] {
  return [...html.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]\/app\.js['"]/g)]
    .flatMap((m) => m[1]!.split(','))
    .map((s) => s.trim())
    .filter(Boolean)
}

describe('site — sayfa/app.js sozlesmesi', () => {
  const pages = htmlFiles()

  it('sayfalar bulundu', () => {
    expect(pages.length).toBeGreaterThan(0)
  })

  it.each(pages)('%s: istedigi her isim app.js icinde var', (page) => {
    const istenen = importsOf(readFileSync(join(PUBLIC, page), 'utf8'))
    const eksik = istenen.filter((name) => !exported.has(name))
    expect(eksik).toEqual([])
  })

  /** Giris her panelin ON KAPISI: yoksa hicbir sayfa acilmaz. */
  it('login disa acilmis', () => {
    expect(exported.has('login')).toBe(true)
  })

  /**
   * Sayfalarin cogunda her bolum `hidden` baslar. Bu, JS calismazsa
   * kullanicinin bos ekran gormesi demek — o yuzden yukaridaki denetim
   * "iyi olurdu" degil, sartt.
   */
  it('paneller gercekten JS ile aciliyor (bos sayfa riski gercek)', () => {
    const panel = readFileSync(join(PUBLIC, 'app/index.html'), 'utf8')
    expect(panel).toContain('id="v-connect"')
    expect(/id="v-connect"[^>]*class="[^"]*hidden/.test(panel)).toBe(true)
  })
})
