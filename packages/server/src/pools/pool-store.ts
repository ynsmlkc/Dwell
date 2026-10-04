/**
 * Sponsor havuzlari — NEXT.md §10.
 *
 * Bir sponsor (hackathon duzenleyicisi, ekosistem fonu, buyuk sirket) kapali
 * bir havuz acar; katilimcilar bir kodla katilir, kendi projelerini tek satir
 * olarak girer ve yalnizca o havuzun projelerini gorur.
 *
 * PARA BURADA DEGIL. Havuz projeleri sponsorun `advertiserId`'siyle
 * faturalaniyor; bakiye, harcama ve geri cekme mevcut reklamveren akisinin
 * aynisi. Bu dosya yalnizca kimlik, uyelik ve kurallari tutuyor — ikinci bir
 * para kaydi, defterle ayrisabilecek ikinci bir gercek demek olurdu.
 */

import { type Stroops } from '@dwell/protocol'
import type { Clock } from '@dwell/protocol'
import type { Db } from '../store/db.js'
import { MIN_BID_CPM } from '../ads/campaign-store.js'

export type PoolStatus = 'open' | 'closed'

export interface Pool {
  readonly id: string
  readonly sponsorId: string
  readonly name: string
  /** Katilim kodu, ornek `HACK-7F3A2C`. Buyuk/kucuk harf duyarsiz. */
  readonly code: string
  /** Havuzdaki her projenin teklifi — takimlar teklif girmez. */
  readonly bidCpm: Stroops
  /**
   * Havuzun harcayabilecegi en fazla tutar. Sponsorun bakiyesinden bu kadari
   * havuza AYRILIR: sponsorun normal kampanyalari bu parayi harcayamaz,
   * havuz da bunun ustune cikamaz (`Pipeline.poolSpent`).
   */
  readonly budget: Stroops
  /**
   * Bir uyenin bu havuzdan bir gunde alabilecegi en fazla gosterim. Kapali
   * grupta biri bilgisayari gece acik birakip butceyi kendine aktarmasin.
   */
  readonly dailyCapPerMember: number
  readonly status: PoolStatus
  readonly createdAt: number
  readonly closedAt: number | null
}

export type PoolResult =
  | { readonly ok: true; readonly pool: Pool }
  | { readonly ok: false; readonly reason: string }

/** Uye basina gunluk gosterim siniri, sponsor belirtmezse. */
export const DEFAULT_DAILY_CAP_PER_MEMBER = 200
export const MAX_DAILY_CAP_PER_MEMBER = 2_000

/** Havuz adi: panelde ve genel ozette gorunur; reklam metni kadar dar. */
const NAME = /^[\p{L}\p{N} _.&'()-]{3,60}$/u

export class PoolStore {
  readonly #byId = new Map<string, Pool>()
  readonly #byCode = new Map<string, string>()
  readonly #memberOf = new Map<string, string>()   // publisherId → poolId

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly newId: () => string,
    /** 6 karakterlik buyuk harf kod govdesi. Testte sabitlenebilsin diye enjekte. */
    private readonly newCode: () => string,
  ) {
    for (const r of db.prepare('SELECT * FROM pools').all() as any[]) {
      this.#index({
        id: String(r.id), sponsorId: String(r.sponsor_id), name: String(r.name),
        code: String(r.code), bidCpm: BigInt(r.bid_cpm) as Stroops,
        budget: BigInt(r.budget ?? '0') as Stroops,
        dailyCapPerMember: Number(r.daily_cap_per_member ?? DEFAULT_DAILY_CAP_PER_MEMBER),
        status: String(r.status) as PoolStatus, createdAt: Number(r.created_at),
        closedAt: r.closed_at == null ? null : Number(r.closed_at),
      })
    }
    for (const r of db.prepare('SELECT * FROM pool_members').all() as any[]) {
      this.#memberOf.set(String(r.publisher_id), String(r.pool_id))
    }
  }

  get(id: string): Pool | null { return this.#byId.get(id) ?? null }

  byCode(code: string): Pool | null {
    const id = this.#byCode.get(code.trim().toUpperCase())
    return id === undefined ? null : this.get(id)
  }

  forSponsor(sponsorId: string): readonly Pool[] {
    return [...this.#byId.values()].filter((p) => p.sponsorId === sponsorId)
  }

  create(input: {
    sponsorId: string; name: string; bidCpm: Stroops; budget: Stroops; dailyCapPerMember?: number
  }): PoolResult {
    const name = input.name.trim()
    if (!NAME.test(name)) return { ok: false, reason: 'name: 3-60 characters' }
    if (input.bidCpm < MIN_BID_CPM) return { ok: false, reason: `bid must be at least ${MIN_BID_CPM} stroops CPM` }
    const cap = input.dailyCapPerMember ?? DEFAULT_DAILY_CAP_PER_MEMBER
    if (!Number.isInteger(cap) || cap < 1 || cap > MAX_DAILY_CAP_PER_MEMBER) {
      return { ok: false, reason: `daily cap per member: 1-${MAX_DAILY_CAP_PER_MEMBER} impressions` }
    }
    // Butce en az bir gosterimi karsilamali; yoksa havuz acildigi anda susar.
    if (input.budget * 1000n < input.bidCpm) return { ok: false, reason: 'budget must cover at least one impression' }

    // Cakisma olasiligi 16^6'da bir; yine de denetleniyor, sessizce iki
    // havuzu ayni koda baglamak katilimciyi yanlis hackathon'a sokar.
    let code = ''
    for (let i = 0; i < 5 && (!code || this.#byCode.has(code)); i++) code = `HACK-${this.newCode()}`
    if (this.#byCode.has(code)) return { ok: false, reason: 'could not allocate a code, try again' }

    const pool: Pool = {
      id: `pool-${this.newId()}`, sponsorId: input.sponsorId, name, code,
      bidCpm: input.bidCpm, budget: input.budget, dailyCapPerMember: cap,
      status: 'open', createdAt: this.clock.now(), closedAt: null,
    }
    this.db.prepare(`
      INSERT INTO pools (id, sponsor_id, name, code, bid_cpm, budget, daily_cap_per_member, status, created_at, closed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(pool.id, pool.sponsorId, pool.name, pool.code, pool.bidCpm.toString(),
      pool.budget.toString(), pool.dailyCapPerMember, pool.status, pool.createdAt)
    this.#index(pool)
    return { ok: true, pool }
  }

  /**
   * Havuzu kapatir. Uyelik silinmez (gecmis kalsin) ama kapali havuzun
   * uyesi `poolOf`'ta `null` doner, yani genel aga geri duser; havuzun
   * projeleri de kimseyle eslesmedigi icin bir daha gosterilmez.
   * Kalan para sponsorun reklamveren hesabinda — normal cekimle alinir.
   */
  close(id: string, sponsorId: string): PoolResult {
    const p = this.#byId.get(id)
    if (!p || p.sponsorId !== sponsorId) return { ok: false, reason: 'pool not found' }
    if (p.status === 'closed') return { ok: true, pool: p }
    const closed: Pool = { ...p, status: 'closed', closedAt: this.clock.now() }
    this.db.prepare('UPDATE pools SET status = ?, closed_at = ? WHERE id = ?').run('closed', closed.closedAt, id)
    this.#byId.set(id, closed)
    return { ok: true, pool: closed }
  }

  /**
   * Butceyi degistirir — sponsor havuzu buyutebilir ya da kucultebilir.
   * Harcanmis tutarin altina inmek havuzu durdurur, geri odeme yapmaz.
   */
  setBudget(id: string, sponsorId: string, budget: Stroops): PoolResult {
    const p = this.#byId.get(id)
    if (!p || p.sponsorId !== sponsorId) return { ok: false, reason: 'pool not found' }
    if (p.status !== 'open') return { ok: false, reason: 'pool is closed' }
    const next: Pool = { ...p, budget }
    this.db.prepare('UPDATE pools SET budget = ? WHERE id = ?').run(budget.toString(), id)
    this.#byId.set(id, next)
    return { ok: true, pool: next }
  }

  /** Sponsorun ACIK havuzlari — butce ayirmasi bunlar icin yapilir. */
  openForSponsor(sponsorId: string): readonly Pool[] {
    return this.forSponsor(sponsorId).filter((p) => p.status === 'open')
  }

  /** Koda gore katilir; onceki havuzdan otomatik cikar (ayni anda tek havuz). */
  join(code: string, publisherId: string): PoolResult {
    const p = this.byCode(code)
    if (!p || p.status !== 'open') return { ok: false, reason: 'no open pool with that code' }
    this.db.prepare(`
      INSERT INTO pool_members (publisher_id, pool_id, joined_at) VALUES (?, ?, ?)
      ON CONFLICT(publisher_id) DO UPDATE SET pool_id = excluded.pool_id, joined_at = excluded.joined_at
    `).run(publisherId, p.id, this.clock.now())
    this.#memberOf.set(publisherId, p.id)
    return { ok: true, pool: p }
  }

  leave(publisherId: string): void {
    this.db.prepare('DELETE FROM pool_members WHERE publisher_id = ?').run(publisherId)
    this.#memberOf.delete(publisherId)
  }

  /** Yayincinin uye oldugu ACIK havuz; reklam secicisi bunu kullanir. */
  poolOf(publisherId: string): string | null {
    const id = this.#memberOf.get(publisherId)
    if (id === undefined) return null
    return this.#byId.get(id)?.status === 'open' ? id : null
  }

  /** Uyenin kaydi — kapali havuz dahil (panelde "havuz kapandi" demek icin). */
  membership(publisherId: string): Pool | null {
    const id = this.#memberOf.get(publisherId)
    return id === undefined ? null : this.get(id)
  }

  memberCount(poolId: string): number {
    let n = 0
    for (const id of this.#memberOf.values()) if (id === poolId) n++
    return n
  }

  #index(p: Pool): void {
    this.#byId.set(p.id, p)
    this.#byCode.set(p.code, p.id)
  }
}
