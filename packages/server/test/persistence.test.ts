/**
 * Kalicilik — yeniden baslatmadan sonra ne duruyor.
 *
 * Buradaki testlerin hepsi tek bir soruyu soruyor: sunucu yeniden baslarsa
 * kullanici bir sey kaybeder mi? Railway her deploy'da sureci oldurup
 * yenisini baslatiyor, yani bu haftada birkac kez oluyor.
 *
 * Her test ONCE bir veritabanina yazip SONRA yeni depo nesneleri kurarak
 * okuyor — yani gercekten diske gidip gidip gelmedigini olcuyor, ayni
 * nesnenin bellegini degil.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixedClock, stroops, type Stroops } from '@dwell/protocol'
import { WalletStore } from '@dwell/payments'
import { openDb, type Db, vacuumExpired } from '../src/store/db.js'
import {
  SqliteLedgerStore, SqliteTokenStore, SqlitePayoutStore,
  SqliteImpressionMirror, walletPersistence,
} from '../src/store/persistent.js'
import { Ledger } from '../src/ledger/ledger.js'
import { accountId } from '../src/ledger/accounts.js'
import { hashToken } from '../src/http/auth.js'
import { Pipeline } from '../src/pipeline.js'
import type { Campaign } from '../src/ads/selector.js'

let dir: string
let path: string
let db: Db
const clock = fixedClock(1_700_000_000_000)
let n = 0
const ids = () => `id-${++n}`

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dwell-db-'))
  path = join(dir, 'dwell.db')
  db = openDb(path)
  n = 0
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

/** Sureci yeniden baslatmayi taklit eder: baglantiyi kapat, dosyayi yeniden ac. */
function yenidenBaslat(): Db {
  db.close()
  db = openDb(path)
  return db
}

describe('defter', () => {
  it('bakiye yeniden baslatmadan SAG cikar', () => {
    const l1 = new Ledger(new SqliteLedgerStore(db, clock, ids), clock, ids)
    l1.deposit({ advertiserId: 'adv', amount: stroops(1_000_000_000n), topupId: 't1' })
    l1.postImpression({
      impressionId: 'imp-1', publisherId: 'alice', advertiserId: 'adv',
      campaignId: 'c1', rate: stroops(300_000n), revShareBps: 5000,
    })
    const once = l1.balance(accountId('publisher', 'alice'))
    expect(once).toBeGreaterThan(0n)

    const l2 = new Ledger(new SqliteLedgerStore(yenidenBaslat(), clock, ids), clock, ids)
    expect(l2.balance(accountId('publisher', 'alice'))).toBe(once)
  })

  it('invariantlar yeniden yukledikten sonra da saglam', () => {
    const l1 = new Ledger(new SqliteLedgerStore(db, clock, ids), clock, ids)
    l1.deposit({ advertiserId: 'adv', amount: stroops(1_000_000_000n), topupId: 't1' })
    for (let i = 0; i < 5; i++) {
      l1.postImpression({
        impressionId: `imp-${i}`, publisherId: 'alice', advertiserId: 'adv',
        campaignId: 'c1', rate: stroops(333_333n), revShareBps: 5000,
      })
    }

    const l2 = new Ledger(new SqliteLedgerStore(yenidenBaslat(), clock, ids), clock, ids)
    expect(l2.audit()).toEqual([])
    expect(l2.publishers()).toContain('alice')
  })

  /**
   * Yuvarlama artigi kritik: 333.333 stroop'un %50'si tam bolunmuyor.
   * Metin olarak saklayip `BigInt`'e cevirdigimiz icin bir stroop bile
   * kaymamali.
   */
  it('kurus kurusuna ayni — yuvarlama kaymasi yok', () => {
    const l1 = new Ledger(new SqliteLedgerStore(db, clock, ids), clock, ids)
    l1.deposit({ advertiserId: 'adv', amount: stroops(1_000_000_000n), topupId: 't1' })
    l1.postImpression({
      impressionId: 'imp-1', publisherId: 'alice', advertiserId: 'adv',
      campaignId: 'c1', rate: stroops(333_333n), revShareBps: 3333,
    })
    const before = {
      alice: l1.balance(accountId('publisher', 'alice')),
      platform: l1.balance(accountId('platform_revenue')),
      adv: l1.balance(accountId('advertiser', 'adv')),
    }

    const l2 = new Ledger(new SqliteLedgerStore(yenidenBaslat(), clock, ids), clock, ids)
    expect(l2.balance(accountId('publisher', 'alice'))).toBe(before.alice)
    expect(l2.balance(accountId('platform_revenue'))).toBe(before.platform)
    expect(l2.balance(accountId('advertiser', 'adv'))).toBe(before.adv)
  })

  /**
   * Buyuk tutarlar. 2^53 ustunde JS `number` sessizce yuvarlar; metin olarak
   * sakladigimiz icin bu olmamali.
   */
  it('2^53 ustundeki tutarlar bozulmaz', () => {
    const buyuk = stroops(9_007_199_254_740_993n)      // 2^53 + 1
    const l1 = new Ledger(new SqliteLedgerStore(db, clock, ids), clock, ids)
    l1.deposit({ advertiserId: 'adv', amount: buyuk, topupId: 't1' })

    const l2 = new Ledger(new SqliteLedgerStore(yenidenBaslat(), clock, ids), clock, ids)
    expect(l2.balance(accountId('advertiser', 'adv'))).toBe(buyuk)
  })

  /** Idempotency kisiti veritabaninda; surec yeniden basladiktan sonra da gecerli. */
  it('ayni gosterim yeniden baslatmadan sonra IKINCI KEZ yazilamaz', () => {
    const l1 = new Ledger(new SqliteLedgerStore(db, clock, ids), clock, ids)
    l1.deposit({ advertiserId: 'adv', amount: stroops(1_000_000_000n), topupId: 't1' })
    const girdi = {
      impressionId: 'imp-tek', publisherId: 'alice', advertiserId: 'adv',
      campaignId: 'c1', rate: stroops(300_000n), revShareBps: 5000,
    }
    l1.postImpression(girdi)
    const once = l1.balance(accountId('publisher', 'alice'))

    const l2 = new Ledger(new SqliteLedgerStore(yenidenBaslat(), clock, ids), clock, ids)
    l2.postImpression(girdi)                     // ayni kayit, ayni anahtar
    expect(l2.balance(accountId('publisher', 'alice'))).toBe(once)
    expect(l2.audit()).toEqual([])
  })
})

describe('token\'lar', () => {
  it('giris yeniden baslatmadan sonra gecerli kalir', () => {
    const t1 = new SqliteTokenStore(db)
    t1.add({
      id: 'tok-1', publisherId: 'GABC', tokenHash: hashToken('dwl_gizli'),
      scopes: ['report:impressions', 'read:balance'],
      clientVersion: null, revokedAt: null, lastSeenAt: null,
    })

    const t2 = new SqliteTokenStore(yenidenBaslat())
    const bulunan = t2.find('dwl_gizli')
    expect(bulunan?.publisherId).toBe('GABC')
    expect(bulunan?.scopes).toEqual(['report:impressions', 'read:balance'])
  })

  it('iptal edilmis token yeniden baslatmadan sonra da IPTAL', () => {
    const t1 = new SqliteTokenStore(db)
    t1.add({
      id: 'tok-1', publisherId: 'GABC', tokenHash: hashToken('dwl_gizli'),
      scopes: ['read:balance'], clientVersion: null, revokedAt: null, lastSeenAt: null,
    })
    t1.revoke('tok-1', 12345)

    const t2 = new SqliteTokenStore(yenidenBaslat())
    expect(t2.find('dwl_gizli')?.revokedAt).toBe(12345)
  })

  it('ham token diskte SAKLANMAZ', () => {
    const t1 = new SqliteTokenStore(db)
    t1.add({
      id: 'tok-1', publisherId: 'GABC', tokenHash: hashToken('dwl_cok_gizli'),
      scopes: ['read:balance'], clientVersion: null, revokedAt: null, lastSeenAt: null,
    })
    const satirlar = JSON.stringify(db.prepare('SELECT * FROM tokens').all())
    expect(satirlar).not.toContain('dwl_cok_gizli')
  })
})

describe('cuzdanlar', () => {
  const ADDR = 'GA' + 'A'.repeat(53) + 'WHF5'

  it('baglanti yeniden baslatmadan sonra duruyor', () => {
    const w1 = new WalletStore({ clock, holdMs: 0, notify: () => {}, persist: walletPersistence(db) })
    w1.bind('alice', ADDR, 'testnet')

    const w2 = new WalletStore({ clock, holdMs: 0, notify: () => {}, persist: walletPersistence(yenidenBaslat()) })
    expect(w2.get('alice')?.address).toBe(ADDR)
  })

  /**
   * Bekleme suresi de kalici olmali. Olmasaydi, adresini degistiren biri
   * sunucuyu yeniden baslatarak 72 saatlik beklemeyi atlatabilirdi.
   */
  it('cuzdan degisikligi beklemesi yeniden baslatmayla SIFIRLANMAZ', () => {
    const ADDR2 = 'GB' + 'B'.repeat(53) + 'WHF5'
    const w1 = new WalletStore({ clock, holdMs: 72 * 3600_000, notify: () => {}, persist: walletPersistence(db) })
    w1.bind('alice', ADDR, 'testnet')
    const b = w1.bind('alice', ADDR2, 'testnet')
    expect(b.holdUntil).not.toBeNull()

    const w2 = new WalletStore({ clock, holdMs: 72 * 3600_000, notify: () => {}, persist: walletPersistence(yenidenBaslat()) })
    expect(w2.get('alice')?.holdUntil).toBe(b.holdUntil)
    expect(w2.get('alice')?.address).toBe(ADDR2)
  })

  it('adres sahipligi korunur — baskasi ayni adresi baglayamaz', () => {
    const w1 = new WalletStore({ clock, holdMs: 0, notify: () => {}, persist: walletPersistence(db) })
    w1.bind('alice', ADDR, 'testnet')

    const w2 = new WalletStore({ clock, holdMs: 0, notify: () => {}, persist: walletPersistence(yenidenBaslat()) })
    expect(w2.boundToOther(ADDR, 'bob')).toBe(true)
    expect(w2.boundToOther(ADDR, 'alice')).toBe(false)
  })
})

describe('odeme kayitlari', () => {
  const receipt = {
    batchId: 'b1', txHash: 'h'.repeat(64), envelopeXdr: 'AAAAxdr', sourceSeq: '7',
    maxTime: 1_700_000_180_000, feeBid: 200n,
    opIndex: [{ publisherId: 'alice', index: 0 }, { publisherId: 'bob', index: 1 }],
  }
  const items = [
    { publisherId: 'alice', address: 'GA1', amount: stroops(25_000_000n) },
    { publisherId: 'bob', address: 'GB1', amount: stroops(13_500_000n) },
  ]

  it('kalemler yeniden baslatmadan sonra okunabilir', () => {
    new SqlitePayoutStore(db).recordSubmit({ receipt, items, at: 1000 })

    const p2 = new SqlitePayoutStore(yenidenBaslat())
    const a = p2.forPublisher('alice')[0]!
    expect(a.amount).toBe(25_000_000n)
    expect(a.opIndex).toBe(0)
    expect(a.destinationAddress).toBe('GA1')
    expect(a.envelopeXdr).toBe('AAAAxdr')
  })

  /**
   * En onemlisi. Submit ile mutabakat ARASINDA sunucu duserse, envelope
   * diskte olmali — yoksa zincire gonderilmis bir odeme sonsuza kadar
   * "yolda" kalir ve kimse bir daha bakmaz.
   */
  it('asili batch yeniden baslatmadan sonra da BULUNUR', () => {
    new SqlitePayoutStore(db).recordSubmit({ receipt, items, at: 1000 })

    const p2 = new SqlitePayoutStore(yenidenBaslat())
    const acik = p2.unresolved()
    expect(acik).toHaveLength(1)
    expect(acik[0]!.batchId).toBe('b1')
    // Mutabakat icin gereken her sey elimizde.
    expect(acik[0]!.receipt.txHash).toBe(receipt.txHash)
    expect(acik[0]!.receipt.envelopeXdr).toBe('AAAAxdr')
    expect(acik[0]!.receipt.opIndex).toHaveLength(2)
  })

  it('onaylanmis odeme yeniden baslatmada tekrar acilmaz', () => {
    const p1 = new SqlitePayoutStore(db)
    p1.recordSubmit({ receipt, items, at: 1000 })
    p1.markSettled('b1', receipt.txHash, 2000)

    const p2 = new SqlitePayoutStore(yenidenBaslat())
    expect(p2.unresolved()).toHaveLength(0)
    expect(p2.forPublisher('alice')[0]!.state).toBe('settled')
  })

  it('onaylanmis kalem sonradan basarisiz YAPILAMAZ', () => {
    const p1 = new SqlitePayoutStore(db)
    p1.recordSubmit({ receipt, items, at: 1000 })
    p1.markSettled('b1', receipt.txHash, 2000)
    p1.markFailed('b1', 'gec gelen hata', 3000)

    const p2 = new SqlitePayoutStore(yenidenBaslat())
    expect(p2.forPublisher('alice')[0]!.state).toBe('settled')
  })
})

describe('gosterimler ve sunumlar', () => {
  const campaigns: Campaign[] = [{
    id: 'c1', advertiserId: 'adv', bidCpm: stroops(300_000_000n), revShareBps: 5000,
    creative: { brand: 'X', text: 'y', cta: 'x.com' }, status: 'active', frequencyCap: 100,
  }]

  function kurPipeline(database: Db, ledger: Ledger): Pipeline {
    const mirror = new SqliteImpressionMirror(database)
    return new Pipeline({
      clock, ids: { impressionId: ids, randomHex: () => 'ab'.repeat(16) } as any,
      ledger, campaigns: () => campaigns,
      minImpressionMs: 10_000, minClientVersion: '0.0.0',
      pendingMs: 1000, dailyCap: 400,
      persist: {
        loadImpressions: () => mirror.loadImpressions(),
        saveImpression: (i) => mirror.saveImpression(i),
        loadDeliveries: () => mirror.loadDeliveries(),
        saveDelivery: (d) => mirror.saveDelivery(d),
      },
    })
  }

  /**
   * Deploy anindaki gosterimler.
   *
   * Reklam sunuldu, kullanici bakiyor, o sirada Railway yeniden deploy etti.
   * Gosterim raporlandiginda nonce hala taninmali — yoksa reddedilir,
   * istemci onu kuyrugundan siler ve o kazanc SESSIZCE kaybolur.
   */
  it('sunulan reklamin nonce\'u yeniden baslatmadan sonra da GECERLI', () => {
    const l1 = new Ledger(new SqliteLedgerStore(db, clock, ids), clock, ids)
    l1.deposit({ advertiserId: 'adv', amount: stroops(10_000_000_000n), topupId: 't1' })
    const p1 = kurPipeline(db, l1)
    const sel = p1.serveAd('alice')!
    expect(sel).toBeTruthy()

    const yeni = yenidenBaslat()
    const l2 = new Ledger(new SqliteLedgerStore(yeni, clock, ids), clock, ids)
    const p2 = kurPipeline(yeni, l2)

    const r = p2.ingest.ingest('alice', [{
      id: '01M0' + 'A'.repeat(22), campaignId: 'c1', nonce: sel.nonce, sessionId: 's1',
      surface: 'statusline', durationMs: 15_000, clientTs: clock.now(),
      projectKey: 'a'.repeat(64), clientVersion: '0.1.0', os: 'darwin', arch: 'arm64',
    }] as any, { ipHash: null })

    expect(r.rejected).toEqual([])
    expect(r.accepted).toHaveLength(1)
  })

  it('bekleyen gosterim yeniden baslatmadan sonra dogrulanabilir', () => {
    const l1 = new Ledger(new SqliteLedgerStore(db, clock, ids), clock, ids)
    l1.deposit({ advertiserId: 'adv', amount: stroops(10_000_000_000n), topupId: 't1' })
    const p1 = kurPipeline(db, l1)
    const sel = p1.serveAd('alice')!
    p1.ingest.ingest('alice', [{
      id: '01M0' + 'B'.repeat(22), campaignId: 'c1', nonce: sel.nonce, sessionId: 's1',
      surface: 'statusline', durationMs: 15_000, clientTs: clock.now(),
      projectKey: 'a'.repeat(64), clientVersion: '0.1.0', os: 'darwin', arch: 'arm64',
    }] as any, { ipHash: null })

    const yeni = yenidenBaslat()
    const l2 = new Ledger(new SqliteLedgerStore(yeni, clock, ids), clock, ids)
    const p2 = kurPipeline(yeni, l2)
    expect(p2.impressions()).toHaveLength(1)

    clock.advance(5000)
    const r = p2.runVerification()
    expect(r.verified).toBe(1)
    expect(l2.balance(accountId('publisher', 'alice'))).toBeGreaterThan(0n)
  })

  /** Ayni gosterim yeniden baslatmadan sonra IKINCI KEZ sayilamaz. */
  it('yinelenen gosterim yeniden baslatmadan sonra da reddedilir', () => {
    const l1 = new Ledger(new SqliteLedgerStore(db, clock, ids), clock, ids)
    l1.deposit({ advertiserId: 'adv', amount: stroops(10_000_000_000n), topupId: 't1' })
    const p1 = kurPipeline(db, l1)
    const sel = p1.serveAd('alice')!
    const olay = {
      id: '01M0' + 'C'.repeat(22), campaignId: 'c1', nonce: sel.nonce, sessionId: 's1',
      surface: 'statusline', durationMs: 15_000, clientTs: clock.now(),
      projectKey: 'a'.repeat(64), clientVersion: '0.1.0', os: 'darwin', arch: 'arm64',
    }
    p1.ingest.ingest('alice', [olay] as any, { ipHash: null })

    const yeni = yenidenBaslat()
    const l2 = new Ledger(new SqliteLedgerStore(yeni, clock, ids), clock, ids)
    const p2 = kurPipeline(yeni, l2)
    const r = p2.ingest.ingest('alice', [olay] as any, { ipHash: null })

    expect(r.duplicates).toHaveLength(1)
    expect(r.accepted).toHaveLength(0)
  })
})

describe('temizlik', () => {
  it('suresi gecmis sunumlar silinir, defter ASLA silinmez', () => {
    const l = new Ledger(new SqliteLedgerStore(db, clock, ids), clock, ids)
    l.deposit({ advertiserId: 'adv', amount: stroops(1_000_000n), topupId: 't1' })

    const mirror = new SqliteImpressionMirror(db)
    mirror.saveDelivery({
      nonce: 'eski', publisherId: 'alice', campaignId: 'c1', advertiserId: 'adv',
      rate: stroops(1000n), revShareBps: 5000,
      expiresAt: clock.now() - 7200_000, consumed: true,
    })

    const silinen = vacuumExpired(db, clock.now(), 90 * 86_400_000)
    expect(silinen).toBeGreaterThan(0)
    expect(mirror.loadDeliveries()).toHaveLength(0)
    // Defter yerinde.
    expect(l.balance(accountId('advertiser', 'adv'))).toBe(1_000_000n)
  })
})
