import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SpinnerSync } from '../src/daemon/spinner-sync.js'
import { MARKER, type ClaudeSettings } from '../src/settings.js'

let dir = ''
let path = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dwell-spin-'))
  path = join(dir, 'settings.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const write = (s: ClaudeSettings) => writeFileSync(path, JSON.stringify(s, null, 2))
const read = (): ClaudeSettings => JSON.parse(readFileSync(path, 'utf8'))
const ours = { mode: 'replace' as const, verbs: ['✶ Dwell'], [MARKER]: true as const }

describe('spinner senkronu', () => {
  it('aktif reklamin markasini yazar', () => {
    write({ spinnerVerbs: ours })
    new SpinnerSync({ path }).sync('Firecrawl')
    expect(read().spinnerVerbs?.verbs).toEqual(['✶ Firecrawl'])
  })

  it('ADR-013 — spinner\'da da ifsa glifi zorunlu', () => {
    // Kullanici `Firecrawl…` gorup Claude Code'un kendi kelimesi sanmamali.
    write({ spinnerVerbs: ours })
    new SpinnerSync({ path }).sync('Resend')
    expect(read().spinnerVerbs?.verbs[0]!.startsWith('✶')).toBe(true)
  })

  it('reklam degisince spinner da degisir — statusLine ile AYNI marka', () => {
    write({ spinnerVerbs: ours })
    const s = new SpinnerSync({ path })
    s.sync('Firecrawl')
    s.sync('Resend')
    expect(read().spinnerVerbs?.verbs).toEqual(['✶ Resend'])
  })

  it('marka DEGISMEDIYSE dosyaya dokunmaz', () => {
    // Saniyede bir settings.json yazmak hem gereksiz hem riskli.
    write({ spinnerVerbs: ours })
    const s = new SpinnerSync({ path })
    s.sync('Firecrawl')
    const first = readFileSync(path, 'utf8')

    writeFileSync(path, first.replace('Firecrawl', 'ELLE-DEGISTIRILDI'))
    s.sync('Firecrawl')                       // ayni marka
    expect(readFileSync(path, 'utf8')).toContain('ELLE-DEGISTIRILDI')
  })

  it('reklam yoksa spinner temizlenir', () => {
    write({ spinnerVerbs: ours })
    const s = new SpinnerSync({ path })
    s.sync('Firecrawl')
    s.sync(null)
    expect(read().spinnerVerbs?.verbs).toEqual([])
  })
})

describe('baskasinin ayarina dokunmaz', () => {
  it('BIZIM olmayan spinnerVerbs degistirilmez', () => {
    const rakip = { mode: 'replace' as const, verbs: ['Baska arac'] }
    write({ spinnerVerbs: rakip })
    new SpinnerSync({ path }).sync('Firecrawl')
    expect(read().spinnerVerbs?.verbs).toEqual(['Baska arac'])
  })

  it('spinner katmani kurulu degilse EKLEMEZ', () => {
    // Kullanici `--spinner` istemediyse zorla kurmayiz.
    write({ theme: 'dark' })
    new SpinnerSync({ path }).sync('Firecrawl')
    expect(read().spinnerVerbs).toBeUndefined()
  })

  it('kullanicinin diger ayarlarini korur', () => {
    write({ theme: 'dark', model: 'opus', spinnerVerbs: ours, hooks: { Stop: [] } })
    new SpinnerSync({ path }).sync('Neon')
    const s = read()
    expect(s.theme).toBe('dark')
    expect(s.model).toBe('opus')
    expect(s.hooks).toEqual({ Stop: [] })
  })
})

describe('dayaniklilik', () => {
  it('bozuk settings.json daemon\'i dusurmez', () => {
    writeFileSync(path, '{ bozuk')
    const errors: unknown[] = []
    expect(() => new SpinnerSync({ path, onError: (e) => errors.push(e) }).sync('X')).not.toThrow()
    expect(errors).toHaveLength(1)
    expect(readFileSync(path, 'utf8'), 'dosya bozulmamali').toBe('{ bozuk')
  })

  it('dosya yoksa sessizce gecer', () => {
    expect(() => new SpinnerSync({ path: join(dir, 'yok.json') }).sync('X')).not.toThrow()
  })

  it('gecici dosya geride birakilmaz', () => {
    write({ spinnerVerbs: ours })
    new SpinnerSync({ path }).sync('Firecrawl')
    expect(readdirSync(dir).filter((f) => f.includes('tmp'))).toHaveLength(0)
  })
})

describe('cok oturum — spinner GLOBAL bir ayardir', () => {
  it('bostaki oturumun tick\'i calisan oturumun reklamini SILMEZ', async () => {
    // Gercek kurulumda cikan hata buydu: spinnerVerbs tek dosyada, tum
    // oturumlar icin ortak. Karar isteği yapan oturuma gore verilince
    // bostaki oturum listeyi bosaltiyor, Claude Code varsayilanlara donuyor
    // ve kullanici spinner'da "Brewing…" goruyordu.
    const { startDaemon } = await import('../src/daemon/index.js')
    const { mkdtempSync: mk } = await import('node:fs')
    const tmp = mk(join(tmpdir(), 'dwell-multi-'))
    const settings = join(tmp, 'settings.json')
    writeFileSync(settings, JSON.stringify({ spinnerVerbs: ours }))

    const d = await startDaemon({
      socketPath: join(tmp, 'd.sock'),
      dataDir: tmp,
      settingsPath: settings,
      syncSpinner: true,
      ads: [{ campaignId: 'c1', nonce: '0'.repeat(32), nonceExpiresAt: 9e12,
        creative: { brand: 'Firecrawl', text: 'metin' } }],
    })

    d.hook('UserPromptSubmit', 'calisan')
    d.tick('calisan')
    expect(JSON.parse(readFileSync(settings, 'utf8')).spinnerVerbs.verbs).toEqual(['✶ Firecrawl'])

    d.tick('bosta')          // bostaki oturum tick atiyor
    expect(
      JSON.parse(readFileSync(settings, 'utf8')).spinnerVerbs.verbs,
      'bostaki oturum reklami silmemeli',
    ).toEqual(['✶ Firecrawl'])

    await d.stop()
    rmSync(tmp, { recursive: true, force: true })
  })
})
