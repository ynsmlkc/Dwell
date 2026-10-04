/**
 * Sponsor havuzlari — NEXT.md §10.
 *
 * Korunan seyler: havuz kampanyasi genel aga sizmaz, genel ag kampanyasi
 * havuza sizmaz, kimse kendi projesini gorerek kazanmaz, kapanan havuzun
 * uyesi genel aga duser, fatura sponsora kesilir, takim basina tek proje.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { fixedClock, stroops, FALLBACK_CONFIG } from '@dwell/protocol'
import { createApp } from '../src/http/app.js'
import { TokenStore, hashToken } from '../src/http/auth.js'
import { Pipeline } from '../src/pipeline.js'
import { Ledger } from '../src/ledger/ledger.js'
import { MemoryLedgerStore } from '../src/ledger/memory-store.js'
import { CampaignStore } from '../src/ads/campaign-store.js'
import { PoolStore } from '../src/pools/pool-store.js'
import { openDb, MEMORY, type Db } from '../src/store/db.js'
import { poolReserve, poolCampaignIds, type ReserveDeps } from '../src/pools/reserve.js'
import { WithdrawService } from '../src/payouts/withdraw.js'
import { MemoryPayoutStore } from '../src/payouts/store.js'
import type { PaymentRail, PayoutBatch, SubmissionReceipt } from '@dwell/payments'

const SPONSOR = 'G-SPONSOR'
const ADV = 'G-ADV'
const ALICE = 'G-ALICE'
const BOB = 'G-BOB'
const OUTSIDER = 'G-OUTSIDER'
const TOK = { sponsor: 'dwl_sponsor_token_0123456789abcdef', alice: 'dwl_alice_token_00123456789abcdef', bob: 'dwl_bob_token_0000123456789abcdef', adv: 'dwl_adv_token_0000123456789abcdefg' }
const BID = stroops(10_000_000n)   // $1 CPM → gosterim basina 10_000 stroop

let clock: ReturnType<typeof fixedClock>
let db: Db
let ledger: Ledger
let campaigns: CampaignStore
let pools: PoolStore
let pipeline: Pipeline
let app: ReturnType<typeof createApp>
let tokens: TokenStore
let reserveDeps: ReserveDeps
let seq = 0
let codeSeq = 0

beforeEach(() => {
  clock = fixedClock(1_700_000_000_000)
  seq = 0; codeSeq = 0
  db = openDb(MEMORY)
  const ids = { impressionId: () => `id-${seq++}`, randomHex: (n: number) => String(seq++).padStart(n * 2, 'a') }
  ledger = new Ledger(new MemoryLedgerStore(clock, () => `led-${seq++}`), clock, () => `led-${seq++}`)
  ledger.deposit({ advertiserId: SPONSOR, amount: stroops(100_000_000n), topupId: 't-sponsor' })
  ledger.deposit({ advertiserId: ADV, amount: stroops(100_000_000n), topupId: 't-adv' })

  campaigns = new CampaignStore(db, clock, () => `${seq++}`)
  pools = new PoolStore(db, clock, () => `${seq++}`, () => `C0DE${String(codeSeq++).padStart(2, '0')}`)
  // main.ts'teki baglamanin aynisi.
  reserveDeps = { pools, campaigns, spentOn: (ids) => pipeline.spentOn(ids) }
  pipeline = new Pipeline({
    clock, ids, ledger, campaigns: () => campaigns.all(),
    poolOf: (p) => pools.poolOf(p),
    poolAllows: (pub, poolId, rate) => {
      const p = pools.get(poolId)!
      const ids = poolCampaignIds(reserveDeps, poolId)
      if (pipeline.servedToday(pub, ids) >= p.dailyCapPerMember) return false
      return pipeline.spentOn(ids) + rate <= p.budget
    },
    reservedForPools: (adv) => poolReserve(reserveDeps, adv),
    minImpressionMs: 10_000, minClientVersion: '0.0.0', pendingMs: 3600_000, dailyCap: 400,
  })

  tokens = new TokenStore()
  const pub = ['report:impressions', 'read:balance', 'withdraw:balance'] as const
  tokens.add({ id: 't1', publisherId: SPONSOR, tokenHash: hashToken(TOK.sponsor), scopes: ['manage:campaigns', 'read:spend'], clientVersion: null, revokedAt: null, lastSeenAt: null })
  tokens.add({ id: 't2', publisherId: ALICE, tokenHash: hashToken(TOK.alice), scopes: [...pub], clientVersion: null, revokedAt: null, lastSeenAt: null })
  tokens.add({ id: 't3', publisherId: BOB, tokenHash: hashToken(TOK.bob), scopes: [...pub], clientVersion: null, revokedAt: null, lastSeenAt: null })
  tokens.add({ id: 't4', publisherId: ADV, tokenHash: hashToken(TOK.adv), scopes: ['manage:campaigns', 'read:spend'], clientVersion: null, revokedAt: null, lastSeenAt: null })

  app = createApp({
    clock, ids, pipeline, ledger, tokens,
    config: () => ({ ...FALLBACK_CONFIG, renderEnabled: true }),
    ipSalt: 's', payoutThreshold: stroops(10_000_000n),
    campaigns, pools,
  })
})

const call = (method: string, path: string, token?: string, body?: unknown) => app.request(path, {
  method,
  headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})
const json = async (r: Response): Promise<any> => r.json()

/** Genel agda aktif bir reklam. */
const generalAd = () => {
  const r = campaigns.create({ advertiserId: ADV, brand: 'Acme', text: 'general network ad', cta: 'acme.dev', bidCpm: BID })
  if (!r.ok) throw new Error(r.reason)
  campaigns.setStatus(r.campaign.id, ADV, 'active')
  return r.campaign
}

const BUDGET = stroops(10_000_000n)  // $1 = 100 gosterim

const openPool = (opts: { budget?: bigint; cap?: number } = {}) => {
  const r = pools.create({ sponsorId: SPONSOR, name: 'Stellar Hack Istanbul', bidCpm: BID, budget: stroops(opts.budget ?? BUDGET), ...(opts.cap ? { dailyCapPerMember: opts.cap } : {}) })
  if (!r.ok) throw new Error(r.reason)
  return r.pool
}

const project = (pool: { id: string }, who: string, brand: string) => {
  const r = campaigns.createPoolProject({ sponsorId: SPONSOR, poolId: pool.id, submittedBy: who, bidCpm: BID, brand, text: 'our hackathon project', cta: `${brand.toLowerCase()}.dev` })
  if (!r.ok) throw new Error(r.reason)
  return r.campaign
}

/** Ayni yayinciya N kez reklam sor, sunulan markalari topla. */
const servedBrands = (publisherId: string, n = 6) =>
  new Set(Array.from({ length: n }, () => pipeline.serveAd(publisherId)?.campaign.creative.brand ?? null))

describe('secici — kapali dongu', () => {
  it('havuz uyesi yalnizca kendi havuzunu, disaridaki yalnizca genel agi gorur', () => {
    generalAd()
    const pool = openPool()
    project(pool, ALICE, 'AliceApp')
    project(pool, BOB, 'BobApp')
    pools.join(pool.code, ALICE)

    expect(servedBrands(ALICE)).toEqual(new Set(['BobApp']))
    expect(servedBrands(OUTSIDER)).toEqual(new Set(['Acme']))
  })

  it('kimse kendi projesini gormez; havuzda baska proje yoksa susar', () => {
    const pool = openPool()
    project(pool, ALICE, 'AliceApp')
    pools.join(pool.code, ALICE)
    expect(pipeline.serveAd(ALICE)).toBe(null)
  })

  it('havuz kapaninca uye genel aga duser, havuz projeleri kimseye gosterilmez', () => {
    generalAd()
    const pool = openPool()
    project(pool, BOB, 'BobApp')
    pools.join(pool.code, ALICE)
    pools.close(pool.id, SPONSOR)

    expect(servedBrands(ALICE)).toEqual(new Set(['Acme']))
    expect(servedBrands(OUTSIDER)).toEqual(new Set(['Acme']))
  })

  it('fatura sponsora kesilir, projeyi giren takima degil', () => {
    const pool = openPool()
    project(pool, BOB, 'BobApp')
    pools.join(pool.code, ALICE)
    const sel = pipeline.serveAd(ALICE)!
    expect(sel.campaign.advertiserId).toBe(SPONSOR)
  })

  it('sponsorun bakiyesi bitince havuz susar', () => {
    const broke = 'G-BROKE'
    const r = pools.create({ sponsorId: broke, name: 'Empty Hack', bidCpm: BID, budget: BUDGET })
    if (!r.ok) throw new Error(r.reason)
    campaigns.createPoolProject({ sponsorId: broke, poolId: r.pool.id, submittedBy: BOB, bidCpm: BID, brand: 'BobApp', text: 'x', cta: 'bob.dev' })
    pools.join(r.pool.code, ALICE)
    expect(pipeline.serveAd(ALICE)).toBe(null)
  })
})

describe('butce ve uye siniri', () => {
  it('butce bitince havuz susar — teslimat aninda sayilir, raporlama beklenmez', () => {
    const pool = openPool({ budget: BID / 1000n * 2n })   // tam 2 gosterim
    project(pool, BOB, 'BobApp')
    pools.join(pool.code, ALICE)
    expect(pipeline.serveAd(ALICE)).not.toBe(null)
    expect(pipeline.serveAd(ALICE)).not.toBe(null)
    expect(pipeline.serveAd(ALICE)).toBe(null)
  })

  it('uye gunluk sinira gelince durur, digerleri devam eder', () => {
    const pool = openPool({ cap: 2 })
    project(pool, BOB, 'BobApp')
    project(pool, ALICE, 'AliceApp')
    pools.join(pool.code, ALICE)
    pools.join(pool.code, BOB)
    pipeline.serveAd(ALICE); pipeline.serveAd(ALICE)
    expect(pipeline.serveAd(ALICE)).toBe(null)
    expect(pipeline.serveAd(BOB)?.campaign.creative.brand).toBe('AliceApp')
  })

  it('butce artirilinca havuz yeniden konusur', () => {
    const pool = openPool({ budget: BID / 1000n })
    project(pool, BOB, 'BobApp')
    pools.join(pool.code, ALICE)
    pipeline.serveAd(ALICE)
    expect(pipeline.serveAd(ALICE)).toBe(null)
    pools.setBudget(pool.id, SPONSOR, BUDGET)
    expect(pipeline.serveAd(ALICE)).not.toBe(null)
  })

  it('sponsorun normal kampanyasi havuza ayrilan parayi harcayamaz', () => {
    const own = campaigns.create({ advertiserId: SPONSOR, brand: 'SponsorCo', text: 'our own ad', cta: 'sponsor.dev', bidCpm: BID })
    if (!own.ok) throw new Error(own.reason)
    campaigns.setStatus(own.campaign.id, SPONSOR, 'active')
    expect(pipeline.serveAd(OUTSIDER)?.campaign.creative.brand).toBe('SponsorCo')

    // Bakiyenin tamami ($10) havuza ayrildi.
    const pool = openPool({ budget: 100_000_000n })
    expect(pipeline.serveAd(OUTSIDER)).toBe(null)

    pools.close(pool.id, SPONSOR)
    expect(pipeline.serveAd(OUTSIDER)?.campaign.creative.brand).toBe('SponsorCo')
  })
})

describe('PoolStore', () => {
  it('ad ve teklif dogrulanir', () => {
    expect(pools.create({ sponsorId: SPONSOR, name: 'ab', bidCpm: BID, budget: BUDGET }).ok).toBe(false)
    expect(pools.create({ sponsorId: SPONSOR, name: 'Valid Hack', bidCpm: stroops(1n), budget: BUDGET }).ok).toBe(false)
    expect(pools.create({ sponsorId: SPONSOR, name: 'Valid Hack', bidCpm: BID, budget: stroops(1n) }).ok).toBe(false)
    expect(pools.create({ sponsorId: SPONSOR, name: 'Valid Hack', bidCpm: BID, budget: BUDGET, dailyCapPerMember: 0 }).ok).toBe(false)
  })

  it('kod buyuk/kucuk harf duyarsiz; ayni anda tek havuz', () => {
    const a = openPool()
    const b = pools.create({ sponsorId: SPONSOR, name: 'Second Hack', bidCpm: BID, budget: BUDGET })
    if (!b.ok) throw new Error(b.reason)
    expect(pools.join(a.code.toLowerCase(), ALICE).ok).toBe(true)
    expect(pools.poolOf(ALICE)).toBe(a.id)
    pools.join(b.pool.code, ALICE)
    expect(pools.poolOf(ALICE)).toBe(b.pool.id)
    expect(pools.memberCount(a.id)).toBe(0)
  })

  it('kapali havuza katilinamaz; baskasinin havuzu kapatilamaz', () => {
    const p = openPool()
    expect(pools.close(p.id, ADV).ok).toBe(false)
    pools.close(p.id, SPONSOR)
    expect(pools.join(p.code, ALICE).ok).toBe(false)
  })

  it('havuz, uyelik ve proje alanlari yeniden acilista geri yuklenir', () => {
    const p = openPool()
    pools.join(p.code, ALICE)
    const c = project(p, BOB, 'BobApp')
    const reopened = new PoolStore(db, clock, () => 'x', () => 'Y')
    expect(reopened.byCode(p.code)?.name).toBe('Stellar Hack Istanbul')
    expect(reopened.poolOf(ALICE)).toBe(p.id)
    const rc = new CampaignStore(db, clock, () => 'z').get(c.id)!
    expect([rc.poolId, rc.submittedBy, rc.advertiserId]).toEqual([p.id, BOB, SPONSOR])
  })
})

describe('HTTP', () => {
  it('sponsor havuz acar, katilimci kodla katilir ve projesini girer', async () => {
    expect((await call('POST', '/v1/advertiser/pools', TOK.sponsor, { name: 'No Budget Hack', bidCpmStroops: BID.toString() })).status).toBe(400)
    const created = await call('POST', '/v1/advertiser/pools', TOK.sponsor, { name: 'Stellar Hack Istanbul', bidCpmStroops: BID.toString(), budgetStroops: BUDGET.toString(), dailyCapPerMember: 50 })
    expect(created.status).toBe(201)
    const { code, id } = await json(created)
    expect(code).toMatch(/^HACK-/)

    expect((await call('POST', '/v1/me/pool/join', TOK.alice, { code })).status).toBe(200)
    expect((await call('POST', '/v1/me/pool/join', TOK.bob, { code })).status).toBe(200)

    const proj = await call('POST', '/v1/me/pool/project', TOK.bob, { brand: 'BobApp', text: 'our hackathon project', cta: 'bob.dev' })
    expect(proj.status).toBe(201)
    expect((await json(proj)).status).toBe('active')

    const mine = await json(await call('GET', '/v1/me/pool', TOK.bob))
    expect(mine.pool).toMatchObject({ code, status: 'open', members: 2 })
    expect(mine.project.brand).toBe('BobApp')

    const list = await json(await call('GET', '/v1/advertiser/pools', TOK.sponsor))
    expect(list.pools[0]).toMatchObject({ id, members: 2, budgetStroops: BUDGET.toString(), spentStroops: '0', dailyCapPerMember: 50 })
    expect(list.pools[0].projects).toHaveLength(1)
    expect(JSON.stringify(list)).not.toContain(BOB)

    const pub = await json(await call('GET', `/v1/pools/${code.toLowerCase()}`))
    expect(pub).toEqual({ name: 'Stellar Hack Istanbul', status: 'open', members: 2, projects: [{ brand: 'BobApp', text: 'our hackathon project', cta: 'bob.dev' }] })
  })

  it('takim basina tek proje; havuzsuz proje girilemez', async () => {
    expect((await call('POST', '/v1/me/pool/project', TOK.alice, { brand: 'A', text: 'b', cta: 'a.dev' })).status).toBe(409)
    const p = openPool()
    await call('POST', '/v1/me/pool/join', TOK.alice, { code: p.code })
    expect((await call('POST', '/v1/me/pool/project', TOK.alice, { brand: 'AliceApp', text: 'one', cta: 'alice.dev' })).status).toBe(201)
    expect((await call('POST', '/v1/me/pool/project', TOK.alice, { brand: 'AliceApp2', text: 'two', cta: 'alice2.dev' })).status).toBe(409)
  })

  it('kapsamlar: yayinci havuz acamaz, reklamveren baskasinin havuzunu kapatamaz', async () => {
    expect((await call('POST', '/v1/advertiser/pools', TOK.alice, { name: 'Nope Hack', bidCpmStroops: BID.toString(), budgetStroops: BUDGET.toString() })).status).toBe(403)
    const p = openPool()
    expect((await call('POST', `/v1/advertiser/pools/${p.id}/close`, TOK.adv)).status).toBe(404)
    expect((await call('POST', `/v1/advertiser/pools/${p.id}/close`, TOK.sponsor)).status).toBe(200)
  })

  it('butce guncellenir; kapali havuzun butcesi degismez', async () => {
    const p = openPool()
    const r = await call('POST', `/v1/advertiser/pools/${p.id}/budget`, TOK.sponsor, { budgetStroops: '50000000' })
    expect((await json(r)).budgetStroops).toBe('50000000')
    expect((await call('POST', `/v1/advertiser/pools/${p.id}/budget`, TOK.adv, { budgetStroops: '1' })).status).toBe(404)
    pools.close(p.id, SPONSOR)
    expect((await call('POST', `/v1/advertiser/pools/${p.id}/budget`, TOK.sponsor, { budgetStroops: '1' })).status).toBe(409)
  })

  it('yanlis kod 404, ayrilinca genel aga doner', async () => {
    expect((await call('POST', '/v1/me/pool/join', TOK.alice, { code: 'HACK-NOPE' })).status).toBe(404)
    const p = openPool()
    await call('POST', '/v1/me/pool/join', TOK.alice, { code: p.code })
    await call('POST', '/v1/me/pool/leave', TOK.alice)
    expect(pools.poolOf(ALICE)).toBe(null)
  })
})

describe('cekim — havuza ayrilan para cekilemez', () => {
  class FakeRail implements PaymentRail {
    #n = 0
    now() { return clock.now() }
    async validateDestinations(addrs: readonly string[]) {
      return addrs.map((address) => ({ address, exists: true, trustlineOk: true, authorized: true,
        memoRequired: false, trustlineLimit: 10n ** 15n, trustlineBalance: 0n }))
    }
    async sourceStatus() { return { address: 'GHOT', usdcBalance: stroops(10n ** 12n), availableXlm: 10n ** 9n, sequence: '1' } }
    async prepare(batch: PayoutBatch): Promise<SubmissionReceipt> {
      return { batchId: batch.batchId, txHash: `h${++this.#n}`.padEnd(64, '0'), envelopeXdr: 'x', sourceSeq: String(this.#n),
        maxTime: clock.now() + 180_000, feeBid: 100n, opIndex: batch.items.map((it, index) => ({ publisherId: it.publisherId, index })) }
    }
    async send() {}
    async reconcile(r: SubmissionReceipt) { return { state: 'settled' as const, txHash: r.txHash, ledger: 1, feeCharged: 100n, opResults: [] } }
  }

  const appWithWithdraw = () => createApp({
    clock, ids: { impressionId: () => `id-${seq++}`, randomHex: (n: number) => String(seq++).padStart(n * 2, 'a') },
    pipeline, ledger, tokens, config: () => ({ ...FALLBACK_CONFIG, renderEnabled: true }),
    ipSalt: 's', payoutThreshold: stroops(10_000_000n), campaigns, pools,
    // main.ts'teki reklamveren cekimiyle ayni: havuza ayrilan dusuluyor.
    withdraw: new WithdrawService({
      clock, ledger, rail: new FakeRail(), store: new MemoryPayoutStore(), kind: 'advertiser',
      spendable: (a) => { const l = pipeline.spendable(a) - poolReserve(reserveDeps, a); return stroops(l > 0n ? l : 0n) },
      newBatchId: () => `w-${seq++}`, log: () => {},
    }),
  })

  it('acik havuzun butcesi cekilemez; havuz kapaninca serbest kalir', async () => {
    const w = appWithWithdraw()
    const req = (method: string, path: string, body?: unknown) => w.request(path, {
      method, headers: { authorization: `Bearer ${TOK.sponsor}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })

    // Sponsorun $10'u var, $6'si havuza ayrildi.
    const pool = openPool({ budget: 60_000_000n })
    const me = await (await req('GET', '/v1/advertiser/me')).json() as any
    expect(me.reservedForPoolsStroops).toBe('60000000')
    expect(me.withdrawableStroops).toBe('40000000')

    expect((await req('POST', '/v1/advertiser/withdraw', { amountStroops: '50000000' })).status).toBe(400)
    expect((await req('POST', '/v1/advertiser/withdraw', { amountStroops: '40000000' })).status).toBe(200)

    pools.close(pool.id, SPONSOR)
    const after = await (await req('GET', '/v1/advertiser/me')).json() as any
    expect(after.reservedForPoolsStroops).toBe('0')
    expect(after.withdrawableStroops).toBe('60000000')
  })
})
