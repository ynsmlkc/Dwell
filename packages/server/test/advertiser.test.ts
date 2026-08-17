/**
 * Reklamveren tarafi — kampanya, butunluk kontrolu, para yatirma.
 *
 * Iki soru sorulmuyor ve sorulmayacak: "bu reklam uygun mu", "bu marka
 * bizimle calisabilir mi". ADR-024: taraf ACIK.
 *
 * Sorulan tek sey BUTUNLUK: kullanici satirda gordugu yere mi gidiyor,
 * terminali bozuyor mu, satira sigiyor mu. Reklamverenin ne sattigi bizi
 * ilgilendirmiyor; kullaniciyi kandirip kandirmadigi ilgilendiriyor.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixedClock, stroops } from '@dwell/protocol'
import { openDb, type Db } from '../src/store/db.js'
import { CampaignStore, validateCreative, MIN_BID_CPM, DEFAULT_REV_SHARE_BPS } from '../src/ads/campaign-store.js'
import { DepositWatcher } from '../src/advertisers/deposits.js'
import { SqliteLedgerStore } from '../src/store/persistent.js'
import { Ledger } from '../src/ledger/ledger.js'
import { accountId } from '../src/ledger/accounts.js'

const ADV = 'GA' + 'A'.repeat(53) + 'WHF5'
const ADV2 = 'GB' + 'B'.repeat(53) + 'WHF5'

let dir: string, db: Db
const clock = fixedClock(1_700_000_000_000)
let n = 0

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dwell-adv-'))
  db = openDb(join(dir, 'a.db'))
  n = 0
})
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

const store = () => new CampaignStore(db, clock, () => `k${++n}`)

const iyi = {
  advertiserId: ADV, brand: 'Firecrawl', text: 'docs to LLM-ready markdown',
  cta: 'firecrawl.dev', bidCpm: stroops(300_000_000n),
}

describe('kampanya olusturma', () => {
  it('gecerli kampanya olusur ve DURDURULMUS baslar', () => {
    const r = store().create(iyi)
    expect(r.ok).toBe(true)
    if (!r.ok) return

    // Otomatik yayina almak, yazim hatasiyla dolu bir reklamin binlerce
    // kisiye gitmesi demek — ve gosterim geri alinamaz, parasi odenmistir.
    expect(r.campaign.status).toBe('paused')
    expect(r.campaign.creative.brand).toBe('Firecrawl')
  })

  /**
   * Yayinci payi platformun karari (ADR-011). Reklamveren onu belirleyemez —
   * belirleyebilseydi sifira ceker, yayinciya hicbir sey odemeden reklam
   * gosterirdi.
   */
  it('yayinci payini reklamveren BELIRLEYEMEZ', () => {
    const r = store().create({ ...iyi, revShareBps: 0 } as any)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.campaign.revShareBps).toBe(DEFAULT_REV_SHARE_BPS)
  })

  it('taban teklifin altinda reddedilir', () => {
    const r = store().create({ ...iyi, bidCpm: stroops(MIN_BID_CPM - 1n) })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.field).toBe('bidCpm')
  })

  it('kampanya yeniden baslatmadan sonra duruyor', () => {
    const r = store().create(iyi)
    expect(r.ok).toBe(true)

    db.close()
    db = openDb(join(dir, 'a.db'))
    expect(store().forAdvertiser(ADV)).toHaveLength(1)
  })
})

describe('sahiplik', () => {
  it('baskasinin kampanyasi DEGISTIRILEMEZ', () => {
    const s = store()
    const r = s.create(iyi)
    if (!r.ok) return

    const saldiri = s.setStatus(r.campaign.id, ADV2, 'active')
    expect(saldiri.ok).toBe(false)
    // "Yetkin yok" DEMIYORUZ — "bulunamadi" diyoruz. Aksi halde saldirgan
    // hangi kampanya kimliklerinin var oldugunu ogrenirdi.
    expect(saldiri.ok === false && saldiri.reason).toContain('bulunamadi')
    expect(s.get(r.campaign.id)!.status).toBe('paused')
  })

  it('reklamveren yalnizca KENDI kampanyalarini gorur', () => {
    const s = store()
    s.create(iyi)
    s.create({ ...iyi, advertiserId: ADV2, brand: 'Resend' })

    expect(s.forAdvertiser(ADV)).toHaveLength(1)
    expect(s.forAdvertiser(ADV)[0]!.creative.brand).toBe('Firecrawl')
  })
})

describe('butunluk kontrolu — ADR-024', () => {
  /**
   * ICERIK yargilanmiyor. Ne satildigi bizi ilgilendirmiyor.
   */
  it('sira disi ama durust reklam KABUL edilir', () => {
    for (const metin of [
      'crypto trading bot',
      'we buy your side project',
      'quit your job, we hire',
    ]) {
      expect(validateCreative({ brand: 'X', text: metin, cta: 'x.com' }).ok).toBe(true)
    }
  })

  it('kacis dizisi ve kontrol karakteri REDDEDILIR', () => {
    for (const kotu of [
      '[31mKIRMIZI',           // ANSI renk
      'normal',                // BEL
      'sag‮sola',               // bidi override
      'satir\nsonu',
    ]) {
      expect(validateCreative({ brand: 'X', text: kotu, cta: 'x.com' }).ok).toBe(false)
    }
  })

  /**
   * Satir 80 karakteri asarsa dar terminalde kesiliyor ve alan adi
   * kayboluyor — reklamveren parasini odedigi seyi alamiyor.
   */
  it('satira sigmayan reklam reddedilir', () => {
    const r = validateCreative({ brand: 'Marka', text: 'x'.repeat(100), cta: 'x.com' })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.field).toBe('text')
  })

  /**
   * Kullanici satirda ne goruyorsa oraya gitmeli. Tam URL kabul edilmiyor:
   * `firecrawl.dev` yazip `kotu-site.com`'a goturmek imkansiz olmali.
   */
  it('alan adi yerine URL yazilamaz', () => {
    for (const kotu of [
      'https://firecrawl.dev',
      'firecrawl.dev/gizli?x=1',
      'firecrawl.dev ve baska',
      'tek-kelime',
      '-bosluk.com',
    ]) {
      expect(validateCreative({ brand: 'X', text: 'y', cta: kotu }).ok).toBe(false)
    }
  })

  it('gecerli alan adlari kabul edilir', () => {
    for (const iyi2 of ['firecrawl.dev', 'resend.com', 'neon.tech', 'a.co', 'my-app.example.org']) {
      expect(validateCreative({ brand: 'X', text: 'y', cta: iyi2 }).ok).toBe(true)
    }
  })

  it('bos alanlar reddedilir', () => {
    expect(validateCreative({ brand: '  ', text: 'y', cta: 'x.com' }).ok).toBe(false)
    expect(validateCreative({ brand: 'X', text: '', cta: 'x.com' }).ok).toBe(false)
    expect(validateCreative({ brand: 'X', text: 'y', cta: '' }).ok).toBe(false)
  })
})

describe('para yatirma', () => {
  function kur(kayitlar: unknown[], bilinen: string[] = [ADV]) {
    const ledger = new Ledger(new SqliteLedgerStore(db, clock, () => `e${++n}`), clock, () => `e${++n}`)
    let cursor: string | null = null
    const loglar: string[] = []
    const watcher = new DepositWatcher({
      clock, ledger,
      horizonUrl: 'https://horizon.test',
      destination: 'GHOT',
      assetCode: 'USDC', assetIssuer: 'GISSUER',
      isKnownAdvertiser: (a) => bilinen.includes(a),
      cursor: { get: () => cursor, set: (c) => { cursor = c } },
      log: (m) => loglar.push(m),
      fetchImpl: (async () => new Response(
        JSON.stringify({ _embedded: { records: kayitlar } }), { status: 200 },
      )) as unknown as typeof fetch,
    })
    return { watcher, ledger, loglar, cursor: () => cursor }
  }

  const odeme = (over: Record<string, unknown> = {}) => ({
    type: 'payment', to: 'GHOT', from: ADV, amount: '100.0000000',
    asset_code: 'USDC', asset_issuer: 'GISSUER',
    transaction_successful: true, transaction_hash: 'tx1', id: 'op1',
    paging_token: '1000', ...over,
  })

  it('gonderen adrese gore hesaba yazilir — memo YOK', async () => {
    const t = kur([odeme()])
    const r = await t.watcher.poll()

    expect(r.credited).toBe(1)
    expect(t.ledger.balance(accountId('advertiser', ADV))).toBe(1_000_000_000n)
  })

  it('ayni odeme IKI KEZ yazilmaz', async () => {
    const t = kur([odeme(), odeme()])          // ayni tx + op
    await t.watcher.poll()
    expect(t.ledger.balance(accountId('advertiser', ADV))).toBe(1_000_000_000n)
  })

  it('taninmayan gonderen deftere YAZILMAZ ama loglanir', async () => {
    const t = kur([odeme({ from: 'GBILINMEYEN' })])
    const r = await t.watcher.poll()

    expect(r.credited).toBe(0)
    expect(r.unmatched).toBe(1)
    expect(t.loglar.some((l) => l.includes('eslesmeyen'))).toBe(true)
  })

  it('basarisiz islem SAYILMAZ — para hareket etmedi', async () => {
    const t = kur([odeme({ transaction_successful: false })])
    expect((await t.watcher.poll()).credited).toBe(0)
  })

  it('baska varlik SAYILMAZ', async () => {
    const t = kur([odeme({ asset_code: 'SAHTE' })])
    expect((await t.watcher.poll()).credited).toBe(0)
  })

  /** Ayni kodu tasiyan farkli issuer FARKLI varliktir — §8 tuzak #8. */
  it('yanlis issuer\'dan gelen USDC SAYILMAZ', async () => {
    const t = kur([odeme({ asset_issuer: 'GSAHTEISSUER' })])
    expect((await t.watcher.poll()).credited).toBe(0)
  })

  it('baskasina giden odeme SAYILMAZ', async () => {
    const t = kur([odeme({ to: 'GBASKASI' })])
    expect((await t.watcher.poll()).credited).toBe(0)
  })

  it('cursor ilerler — ayni kayitlar tekrar taranmaz', async () => {
    const t = kur([odeme({ paging_token: '4242' })])
    await t.watcher.poll()
    expect(t.cursor()).toBe('4242')
  })

  /**
   * Ag hatasinda cursor ILERLEMEZ. Ilerleseydi, o turdaki odemeler bir daha
   * hic bakilmadan atlanirdi — reklamverenin parasi kaybolurdu.
   */
  it('ag hatasinda cursor ilerlemez', async () => {
    const ledger = new Ledger(new SqliteLedgerStore(db, clock, () => `e${++n}`), clock, () => `e${++n}`)
    let cursor: string | null = null
    const w = new DepositWatcher({
      clock, ledger, horizonUrl: 'https://horizon.test', destination: 'GHOT',
      assetCode: 'USDC', assetIssuer: 'GISSUER',
      isKnownAdvertiser: () => true,
      cursor: { get: () => cursor, set: (c) => { cursor = c } },
      log: () => {},
      fetchImpl: (async () => { throw new Error('ag yok') }) as unknown as typeof fetch,
    })

    expect((await w.poll()).credited).toBe(0)
    expect(cursor).toBeNull()
  })

  it('ondalikli tutar kurusu kurusuna cevrilir', async () => {
    const t = kur([odeme({ amount: '0.1234567' })])
    await t.watcher.poll()
    expect(t.ledger.balance(accountId('advertiser', ADV))).toBe(1_234_567n)
  })
})

/**
 * Girişte cüzdan bağlanmasi.
 *
 * Gercek dagitimda bulundu: kimse odeme alamiyordu. `WalletStore` bos
 * kaldigi icin odeme isi HERKESI "cuzdan bagli degil" diye atliyordu —
 * kullanici cuzdaniyla giris yaptigi halde. Hicbir hata gorunmuyordu,
 * yalnizca para hic gitmiyordu.
 */
describe('giriste cuzdan baglanmasi', () => {
  it('yayinci girisi cuzdani baglar ve odeme engeli KALKAR', async () => {
    const { WalletStore } = await import('@dwell/payments')
    const w = new WalletStore({ clock, holdMs: 0, notify: () => {} })

    // Giris oncesi: odeme engelli.
    const engel = w.payoutBlock(ADV)
    expect(engel.blocked).toBe(true)
    expect(engel.blocked && engel.reason).toContain('bagli degil')

    // `main.ts`'teki davranis: publisherId adresin kendisi.
    w.bind(ADV, ADV, 'testnet')

    expect(w.payoutBlock(ADV).blocked).toBe(false)
    expect(w.get(ADV)!.address).toBe(ADV)
  })

  it('ikinci giris bekleme suresi BASLATMAZ', async () => {
    const { WalletStore } = await import('@dwell/payments')
    const bildirimler: unknown[] = []
    const w = new WalletStore({ clock, holdMs: 72 * 3600_000, notify: (n) => bildirimler.push(n) })

    w.bind(ADV, ADV, 'testnet')
    w.bind(ADV, ADV, 'testnet')          // ayni adres — degisiklik degil

    expect(w.get(ADV)!.holdUntil).toBeNull()
    expect(w.payoutBlock(ADV).blocked).toBe(false)
  })
})

/**
 * Reklam secimi — parasi biten reklamveren digerlerini SUSTURMAMALI.
 *
 * Gercek dagitimda bulundu. Cebinde 16 sent kalmis bir reklamverenin
 * gosterim basina 20 sentlik kampanyasi "parasi var" diye uygun sayiliyor,
 * en yuksek teklif oldugu icin seciliyor, sonra "yetmiyor" deyip null
 * donuyordu. Parasi dolu diger kampanyalar hic siraya giremiyordu.
 *
 * Tek bir reklamveren butun agi durduruyordu ve hicbir hata gorunmuyordu.
 */
describe('reklam secimi — butce tukenmesi', () => {
  it('parasi yetmeyen YUKSEK teklif, karsilanabilir dusuk teklifi engellemez', async () => {
    const { AdSelector } = await import('../src/ads/selector.js')
    const { cryptoIdGenerator } = await import('@dwell/protocol')

    const zengin = 'GZENGIN', fakir = 'GFAKIR'
    const kampanyalar = [
      // Gosterim basina 2.000.000 stroop — ama cebinde 1.600.000 var.
      { id: 'pahali', advertiserId: fakir, bidCpm: stroops(2_000_000_000n), revShareBps: 5000,
        creative: { brand: 'Pahali', text: 't', cta: 'p.com' }, status: 'active' as const, frequencyCap: 1 },
      // Gosterim basina 400.000 — ve parasi bol.
      { id: 'ucuz', advertiserId: zengin, bidCpm: stroops(400_000_000n), revShareBps: 5000,
        creative: { brand: 'Ucuz', text: 't', cta: 'u.com' }, status: 'active' as const, frequencyCap: 1 },
    ]

    const sel = new AdSelector({
      clock, ids: cryptoIdGenerator(clock),
      campaigns: () => kampanyalar,
      spendableBalance: (a) => (a === fakir ? stroops(1_600_000n) : stroops(20_000_000n)),
    })

    const secim = sel.select('GPUB')
    expect(secim, 'ag durmamali').not.toBeNull()
    expect(secim!.campaign.id).toBe('ucuz')
  })

  it('hicbiri karsilanamiyorsa sessizce durur', async () => {
    const { AdSelector } = await import('../src/ads/selector.js')
    const { cryptoIdGenerator } = await import('@dwell/protocol')
    const sel = new AdSelector({
      clock, ids: cryptoIdGenerator(clock),
      campaigns: () => [{ id: 'x', advertiserId: 'GA', bidCpm: stroops(2_000_000_000n), revShareBps: 5000,
        creative: { brand: 'X', text: 't', cta: 'x.com' }, status: 'active' as const, frequencyCap: 1 }],
      spendableBalance: () => stroops(1n),
    })
    expect(sel.select('GPUB')).toBeNull()
  })
})
