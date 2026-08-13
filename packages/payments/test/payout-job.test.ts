/**
 * Odeme job'i testleri.
 *
 * Kivilcim 2'de testnet'te GORDUGUMUZ ariza modlarinin hepsi burada
 * deterministik olarak uretiliyor.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { fixedClock, stroops, type Stroops } from '@dwell/protocol'
import { PayoutJob, type PayoutCandidate } from '../src/payout-job.js'
import { WalletStore } from '../src/wallet.js'
import { MockRail } from './mock-rail.js'
import type { PayoutItem, SubmissionReceipt } from '../src/rail.js'

const addr = (n: number) => 'G' + String(n).padStart(55, 'A')

let clock: ReturnType<typeof fixedClock>
let wallets: WalletStore
let rail: MockRail
let events: string[]
let batchSeq: number

function setup(opts: {
  rail?: ConstructorParameters<typeof MockRail>[0]
  candidates?: PayoutCandidate[]
  publishers?: number
  batchSize?: number
} = {}) {
  clock = fixedClock(1_700_000_000_000)
  wallets = new WalletStore({ clock, notify: () => {} })
  rail = new MockRail(opts.rail)
  events = []
  batchSeq = 0

  const n = opts.publishers ?? 3
  for (let i = 1; i <= n; i++) {
    wallets.bind(`p${i}`, addr(i), 'testnet')
    rail.addressMap[`p${i}`] = addr(i)
  }

  const candidates = opts.candidates
    ?? Array.from({ length: n }, (_, i) => ({ publisherId: `p${i + 1}`, payable: stroops(50_000_000n) }))

  const job = new PayoutJob({
    clock, rail, wallets,
    candidates: () => candidates,
    threshold: stroops(10_000_000n),
    batchSize: opts.batchSize ?? 10,
    newBatchId: () => `b${++batchSeq}`,
    onSubmit: (id, items, r) => events.push(`submit:${id}:${items.length}:${r.txHash}`),
    onSettled: (id, items) => events.push(`settled:${id}:${items.length}`),
    onFailed: (id, items, reason) => events.push(`failed:${id}:${reason}`),
    onSkipped: (p, reason) => events.push(`skip:${p}:${reason}`),
  })
  return job
}

describe('mutlu yol', () => {
  it('uygun herkes odenir', async () => {
    const r = await setup().run()
    expect(r.paid).toBe(3)
    expect(r.failed).toBe(0)
    expect(r.totalPaid).toBe(150_000_000n)
    expect(events).toContain('settled:b1:3')
  })

  it('kayit submit\'ten ONCE yazilir — §8 tuzak #9', async () => {
    await setup().run()
    // `submit` olayi `settled`'dan once gelmeli: cevap gelmese bile
    // "yolda" kaydi durmali.
    expect(events.findIndex((e) => e.startsWith('submit:')))
      .toBeLessThan(events.findIndex((e) => e.startsWith('settled:')))
  })

  it('esigin altindakiler hic denenmez', async () => {
    const r = await setup({
      candidates: [
        { publisherId: 'p1', payable: stroops(50_000_000n) },
        { publisherId: 'p2', payable: stroops(1_000_000n) },   // esigin altinda
      ],
    }).run()
    expect(r.paid).toBe(1)
    expect(rail.submitted[0]!.opIndex).toHaveLength(1)
  })
})

describe('§8 tuzak #1 — tek bozuk hedef tum batch\'i dusurur', () => {
  it('trustline\'siz hedef batch\'e HIC ALINMAZ', async () => {
    const r = await setup({
      rail: { destinations: { [addr(2)]: { trustlineOk: false } } },
    }).run()

    expect(r.skipped).toBe(1)
    expect(r.paid, 'digerleri odenmeli').toBe(2)
    expect(events).toContainEqual(expect.stringMatching(/skip:p2:USDC trustline yok/))
  })

  it('on kontrol atlanirsa TUM batch patlar', async () => {
    // Bu senaryo dogrulamanin neden batch kurulmadan HEMEN once yapildigini
    // gosteriyor: hedef arada bozulursa 3 masum publisher da odeme alamaz.
    const r = await setup({ rail: { failingAddress: addr(2) } }).run()

    expect(r.paid).toBe(0)
    expect(r.failed).toBe(3)
    expect(events).toContainEqual(expect.stringMatching(/failed:b1:tx basarisiz: p2=op_no_trust/))
  })

  it('suclu operation INDEKSINDEN bulunur — op_index zorunlu', async () => {
    await setup({ rail: { failingAddress: addr(3) } }).run()
    const failed = events.find((e) => e.startsWith('failed:'))!
    expect(failed, 'suclu ismen raporlanmali').toContain('p3=op_no_trust')
    expect(failed).not.toContain('p1=op_no_trust')
  })
})

describe('§8 tuzak #7 — patlayan tx de ledger\'a girer', () => {
  it('basarisiz batch "odendi" SAYILMAZ', async () => {
    const r = await setup({ rail: { failingAddress: addr(1) } }).run()
    expect(r.paid).toBe(0)
    expect(events).not.toContainEqual(expect.stringMatching(/^settled:/))
    // Ters kayit yazilmali — para publisher'a donmeli.
    expect(events).toContainEqual(expect.stringMatching(/^failed:/))
  })
})

describe('hedef eleme', () => {
  const cases: [string, any, RegExp][] = [
    ['hesap yok', { exists: false }, /zincirde yok/],
    ['trustline yok', { trustlineOk: false }, /trustline yok/],
    ['yetkisiz trustline', { authorized: false }, /yetkilendirilmemis/],
    ['memo gerekiyor', { memoRequired: true }, /memo/],
    ['limit yetersiz', { trustlineLimit: 1_000n, trustlineBalance: 0n }, /limiti yetersiz/],
  ]

  for (const [name, dest, pattern] of cases) {
    it(`${name} → dusurulur, sebebi bildirilir`, async () => {
      const r = await setup({ rail: { destinations: { [addr(2)]: dest } } }).run()
      expect(r.skipped).toBe(1)
      expect(events.find((e) => e.startsWith('skip:p2'))).toMatch(pattern)
    })
  }
})

describe('ADR-014 — bekleme suresindeki hesap odenmez', () => {
  it('adres degistirmis publisher batch\'ten dusurulur', async () => {
    const job = setup()
    wallets.bind('p2', addr(99), 'testnet')      // adres degisti → 72 saat

    const r = await job.run()
    expect(r.paid).toBe(2)
    expect(events.find((e) => e.startsWith('skip:p2'))).toMatch(/72 saat kaldi/)
  })

  it('bekleme dolunca odenir', async () => {
    const job = setup()
    wallets.bind('p2', addr(99), 'testnet')
    rail.addressMap['p2'] = addr(99)
    clock.advance(73 * 3600_000)

    expect((await job.run()).paid).toBe(3)
  })
})

describe('ADR-015 — sicak cuzdan', () => {
  it('XLM yetersizse HICBIR odeme yapilmaz', async () => {
    // USDC dolu ama XLM biten hesap sessizce durur; alarm ureten tek sey bu.
    const r = await setup({ rail: { availableXlm: 1_000n } }).run()
    expect(r.batches).toBe(0)
    expect(r.paid).toBe(0)
    expect(r.alerts).toContainEqual(expect.stringMatching(/XLM yetersiz/))
  })

  it('USDC yetersizse alarm uretilir', async () => {
    const r = await setup({ rail: { usdcBalance: 1_000_000n } }).run()
    expect(r.alerts).toContainEqual(expect.stringMatching(/USDC yetersiz/))
  })
})

describe('ADR-006 — batch boyutu', () => {
  it('10\'ar 10\'ar bolunur', async () => {
    const r = await setup({ publishers: 25, batchSize: 10 }).run()
    expect(r.batches).toBe(3)
    expect(r.paid).toBe(25)
    expect(rail.submitted.map((s) => s.opIndex.length)).toEqual([10, 10, 5])
  })

  it('kucuk batch patlama yaricapini sinirlar', async () => {
    // 25 hedeften biri bozuk. p15 ikinci batch'te (10-19 arasi), yani
    // yalnizca o batch duser. Tek buyuk batch olsaydi 25 kisi de odenmezdi.
    const r = await setup({
      publishers: 25, batchSize: 10,
      rail: { failingAddress: addr(15) },
    }).run()
    expect(r.paid, 'birinci ve ucuncu batch kurtulur').toBe(15)
    expect(r.failed, 'yalnizca ikinci batch').toBe(10)
  })
})

describe('§8 tuzak #10 — belirsizlik ve zaman asimi', () => {
  it('gecici pending sonrasi AYNI envelope tekrar gonderilir', async () => {
    const r = await setup({ rail: { pendingRounds: 2 } }).run()
    expect(r.paid).toBe(3)
    expect(rail.resubmits, 'yeniden insa DEGIL, ayni byte\'lar').toEqual(['xdr-b1', 'xdr-b1'])
    expect(rail.submitted, 'ikinci kez submitBatch cagrilmamali').toHaveLength(1)
  })

  it('maxTime gecmeden ASLA yeni transaction kurulmaz', async () => {
    // `NOT_FOUND` tek basina anlamsizdir; yeni sequence ile yeniden kurmak
    // cift odeme uretir.
    const r = await setup({ rail: { neverIncluded: true } }).run()
    expect(rail.submitted).toHaveLength(1)
    expect(r.paid).toBe(0)
  })

  it('maxTime gecince olu sayilir ve ters kayit yazilir', async () => {
    // Gercekte polling sirasinda zaman gecer; mock her reconcile'da saati
    // ilerletiyor.
    const r = await setup({ rail: { neverIncluded: true, advanceOnReconcile: 100_000 } }).run()
    expect(events).toContainEqual(expect.stringMatching(/failed:.*zaman asimina/))
    expect(r.paid).toBe(0)
  })
})

describe('submit cagrisi patlarsa', () => {
  it('hicbir kayit yazilmaz — hash bilinmiyor, mutabakat kurulamaz', async () => {
    const r = await setup({ rail: { throwOnSubmit: true } }).run()
    expect(events).toHaveLength(0)
    expect(r.alerts).toContainEqual(expect.stringMatching(/submit edilemedi/))
  })
})

describe('cuzdan bagli degilse', () => {
  it('odeme denenmez', async () => {
    const job = setup({ candidates: [{ publisherId: 'bagli-degil', payable: stroops(50_000_000n) }] })
    const r = await job.run()
    expect(r.skipped).toBe(1)
    expect(events[0]).toMatch(/cuzdan bagli degil/)
  })
})
