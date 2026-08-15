/**
 * `dwell balance`.
 *
 * Bu komut kullanicinin parasini gosteriyor; yanlis bir sayi guveni bitirir.
 * Testlerin cogu "dogru sayi mi" degil, "yaniltici mi" sorusunu soruyor:
 * bekleyen ile odenebiliri karistirmak, esigi gizlemek, ya da odemenin neden
 * yapilmadigini soylememek — hepsi teknik olarak dogru ama pratikte yalan.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cmdBalance, link, type BalanceResponse } from '../src/cli/balance.js'
import { saveCredentials } from '../src/credentials.js'

const ADDR = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF5'

let dir: string
let yazilan: string[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dwell-bal-'))
  process.env['DWELL_CREDENTIALS'] = join(dir, 'creds.json')
  yazilan = []
  // `fail()` stderr'e yaziyor, geri kalani stdout'a. Ikisini de yakalamak
  // gerekiyor: hata mesajlarini test etmek istiyoruz.
  const yakala = (s: any): boolean => { yazilan.push(String(s)); return true }
  vi.spyOn(process.stdout, 'write').mockImplementation(yakala)
  vi.spyOn(process.stderr, 'write').mockImplementation(yakala)
})

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env['DWELL_CREDENTIALS']
  rmSync(dir, { recursive: true, force: true })
})

const ekran = (): string => yazilan.join('')

function girisYap(): void {
  saveCredentials({
    serverUrl: 'https://api.test', token: 'dwl_t', publisherId: ADDR,
    tokenId: 't1', loggedInAt: 1,
  })
}

const cevap = (over: Partial<BalanceResponse> = {}): typeof fetch =>
  (async () => new Response(JSON.stringify({
    pendingStroops: '0', payableStroops: '0', inFlightStroops: '0',
    lifetimeStroops: '0', payoutThresholdStroops: '10000000',
    recentPayouts: [], blockedReason: null, ...over,
  }), { status: 200 })) as unknown as typeof fetch

describe('dwell balance', () => {
  it('giris yapilmamissa aciklayici hata verir', async () => {
    await expect(cmdBalance([], cevap())).rejects.toThrow()
    expect(ekran()).toContain('dwell login')
  })

  /**
   * Bekleyen ile odenebilir AYRI gosterilmek zorunda. Toplamak, dogrulama
   * bir gosterimi reddettiginde bakiyenin dusmesine ve hicbir aciklama
   * olmamasina yol acardi.
   */
  it('bekleyen ve odenebilir AYRI gosterilir', async () => {
    girisYap()
    await cmdBalance([], cevap({ pendingStroops: '32000000', payableStroops: '15000000' }))

    const s = ekran()
    expect(s).toContain('odenebilir')
    expect(s).toContain('$1.5')
    expect(s).toContain('bekleyen')
    expect(s).toContain('$3.2')
    // Toplam ($4.7) HICBIR yerde tek sayi olarak gecmemeli.
    expect(s).not.toContain('$4.7')
  })

  it('bekleyenin henuz para OLMADIGI yaziyor', async () => {
    girisYap()
    await cmdBalance([], cevap({ pendingStroops: '32000000' }))
    expect(ekran()).toContain('dogrulanmayi bekliyor')
  })

  it('esigin altindayken NE KADAR kaldigi soylenir', async () => {
    girisYap()
    await cmdBalance([], cevap({
      payableStroops: '4000000', payoutThresholdStroops: '10000000',
      blockedReason: 'esik 10000000 stroop, bakiye 4000000',
    }))
    const s = ekran()
    expect(s).toContain('$0.6')          // 1.00 − 0.40
    expect(s).toContain('$1')            // esik
  })

  it('esik asildiysa odemenin gelecegi soylenir', async () => {
    girisYap()
    await cmdBalance([], cevap({ payableStroops: '25000000' }))
    expect(ekran()).toMatch(/esik asildi/)
  })

  /**
   * Esik disinda bir sebep varsa (cuzdan bekleme suresi, trustline eksigi)
   * o da gosterilmeli. "Esige ulasmadin" demek, asil sebep baskayken
   * kullaniciyi bosuna bekletirdi.
   */
  it('esik disi engel sebebi de gosterilir', async () => {
    girisYap()
    await cmdBalance([], cevap({
      payableStroops: '4000000',
      blockedReason: 'cuzdan degisikligi sonrasi 72 saat bekleme',
    }))
    expect(ekran()).toContain('72 saat')
  })

  it('yolda para YOKSA o satir hic cikmaz', async () => {
    girisYap()
    await cmdBalance([], cevap({ inFlightStroops: '0' }))
    expect(ekran()).not.toContain('yolda')
  })

  it('yolda para VARSA gosterilir', async () => {
    girisYap()
    await cmdBalance([], cevap({ inFlightStroops: '7000000' }))
    const s = ekran()
    expect(s).toContain('yolda')
    expect(s).toContain('$0.7')
  })

  it('cuzdan adresi TAM gosterilir — kisaltilmaz', async () => {
    girisYap()
    await cmdBalance([], cevap())
    // Kullanici parasinin nereye gidecegini dogrulayabilmeli. Kisaltilmis
    // adres bu kontrolu imkansiz kilar.
    expect(ekran()).toContain(ADDR)
  })

  it('--json ham cevabi basar, suslemez', async () => {
    girisYap()
    await cmdBalance(['--json'], cevap({ payableStroops: '15000000' }))
    const s = ekran().trim()
    expect(JSON.parse(s).payableStroops).toBe('15000000')
    expect(s).not.toContain('odenebilir')
  })

  it('401 alinca yeniden giris soylenir', async () => {
    girisYap()
    const f = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch
    await expect(cmdBalance([], f)).rejects.toThrow()
    expect(ekran()).toContain('dwell login --force')
  })

  it('ag yokken cokmez, ne oldugunu soyler', async () => {
    girisYap()
    const f = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    await expect(cmdBalance([], f)).rejects.toThrow()
    expect(ekran()).toContain('ulasilamadi')
  })

  it('son odemeler tarih ve islem linkiyle listelenir', async () => {
    girisYap()
    await cmdBalance([], cevap({
      recentPayouts: [
        { txHash: 'abc123'.padEnd(64, '0'), amountStroops: '25000000', at: 1_700_000_000_000, state: 'settled' },
      ],
    }))
    const s = ekran()
    expect(s).toContain('son odemeler')
    expect(s).toContain('$2.5')
    expect(s).toContain('abc123')
  })
})

describe('link', () => {
  it('TTY\'de tiklanabilir OSC 8 uretir', () => {
    const l = link('a'.repeat(64), true)
    expect(l).toContain('\u001b]8;;')
    expect(l).toContain('stellar.expert')
  })

  /**
   * Boruya yazarken kacis dizisi GONDERILMEZ. `dwell balance | grep` yapan
   * biri gorunmez karakterlerle ugrasmamali.
   */
  it('TTY degilse duz metin — kacis dizisi yok', () => {
    const l = link('a'.repeat(64), false)
    expect(l).not.toContain('\u001b')
    expect(l).not.toContain('\u0007')
    expect(l).toBe('aaaaaaaa…')
  })
})
