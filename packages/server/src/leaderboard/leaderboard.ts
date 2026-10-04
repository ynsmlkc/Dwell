/**
 * Genel siralama ve ulke dagilimi — sitenin ana sayfasi icin.
 *
 * KAYNAK DEFTER, gosterim tablosu DEGIL: `impressions` 90 gunden eski
 * kararlanmis kayitlari siliyor (`vacuumExpired`), defter ise hicbir zaman
 * temizlenmiyor. "Tum zamanlar" ancak defterden dogru hesaplanir.
 *
 * Sayilan: yayinci hesabina yazilan `impression` kayitlari ve onlarin
 * `reversal`'lari. Odeme kayitlari (`payout_*`) kazanc degil, yalnizca
 * paranin yer degistirmesi — sayilmaz. Ayirt edici `campaignId`: odeme
 * kayitlarinda ve onlarin ters kayitlarinda yok.
 *
 * KENDI REKLAMI SAYILMAZ (PROBLEMS.md #7): reklamveren ile yayinci ayni
 * cuzdansa o gosterim siralamaya girmez. Kendi butcesini kendine harcayarak
 * listenin basina cikmak bedava olurdu.
 *
 * Gizlilik: yalnizca `listed` profiller sayilir. Ulke dagilimi da dahil —
 * listelenmemis bir yayincinin varligi hicbir genel uctan cikarilamaz.
 */

import type { Entry } from '../ledger/ledger.js'
import { accountId } from '../ledger/accounts.js'
import type { Profile, ProfileStore } from './profiles.js'

export const PERIODS = ['all', '30d', '7d'] as const
export type Period = (typeof PERIODS)[number]

const DAY_MS = 86_400_000
const PERIOD_MS: Record<Period, number | null> = { all: null, '30d': 30 * DAY_MS, '7d': 7 * DAY_MS }

/** Profil kartindaki kazanc grafiginin gun sayisi. */
export const HISTORY_DAYS = 30

export interface Totals {
  earned: bigint
  impressions: number
}

export interface Row {
  readonly rank: number
  readonly nickname: string
  readonly country: string | null
  readonly earnedStroops: string
  readonly impressions: number
}

export interface CountryStat {
  readonly country: string
  readonly devs: number
  readonly impressions: number
  readonly earnedStroops: string
}

export interface ProfileDetail extends Row {
  readonly countryRank: number | null
  /** Son `HISTORY_DAYS` gunun gunluk kazanci, en eskiden en yeniye (UTC gunleri). */
  readonly dailyStroops: readonly string[]
}

export interface LeaderboardDeps {
  readonly entries: () => readonly Entry[]
  readonly profiles: ProfileStore
  /** Kampanyanin reklamvereni — kendi reklamini ayiklamak icin. */
  readonly advertiserOf: (campaignId: string) => string | null
  readonly now: () => number
  /**
   * Genel uclar yetki istemiyor ve her istek butun defteri tariyor. Kisa bir
   * onbellek bunu dakikada birkac taramaya indiriyor.
   */
  readonly cacheMs?: number
}

/** Bir defter kaydinin siralamaya etkisi; sayilmayacaksa `null`. */
function counted(e: Entry, advertiserOf: (campaignId: string) => string | null) {
  if (e.campaignId === null || e.publisherId === null) return null
  if (e.type !== 'impression' && e.type !== 'reversal') return null
  if (e.accountId !== accountId('publisher', e.publisherId)) return null
  if (advertiserOf(e.campaignId) === e.publisherId) return null
  return { publisherId: e.publisherId, amount: e.amount as bigint, count: e.type === 'impression' ? 1 : -1 }
}

export function totalsSince(
  entries: readonly Entry[],
  advertiserOf: (campaignId: string) => string | null,
  since: number | null,
): Map<string, Totals> {
  const out = new Map<string, Totals>()
  for (const e of entries) {
    if (since !== null && e.createdAt < since) continue
    const c = counted(e, advertiserOf)
    if (!c) continue
    const t = out.get(c.publisherId) ?? { earned: 0n, impressions: 0 }
    t.earned += c.amount
    t.impressions += c.count
    out.set(c.publisherId, t)
  }
  return out
}

/** Listelenmis profilleri kazanca gore siralar. Hic kazanci olmayan listeye girmez. */
export function rank(
  totals: ReadonlyMap<string, Totals>,
  profiles: readonly Profile[],
  country: string | null = null,
): Row[] {
  return profiles
    .filter((p) => p.listed && (country === null || p.country === country))
    .map((p) => ({ p, t: totals.get(p.publisherId) ?? { earned: 0n, impressions: 0 } }))
    .filter(({ t }) => t.earned > 0n)
    .sort((a, b) =>
      a.t.earned !== b.t.earned ? (b.t.earned > a.t.earned ? 1 : -1)
        : b.t.impressions !== a.t.impressions ? b.t.impressions - a.t.impressions
          : a.p.nickname.localeCompare(b.p.nickname))
    .map(({ p, t }, i) => ({
      rank: i + 1,
      nickname: p.nickname,
      country: p.country,
      earnedStroops: t.earned.toString(),
      impressions: t.impressions,
    }))
}

export class Leaderboard {
  /**
   * YALNIZCA defterden turetilen veri onbellekte (toplamlar, gunluk gecmis).
   * Profiller her istekte taze okunuyor: siralamadan cikan ya da adini
   * degistiren yayinci bir sonraki istekte o haliyle gorunur. Siralama
   * profil sayisi kadar ucuz; pahali olan defter taramasi.
   *
   * Anahtarlar sabit bir kumeden (`totals:<period>`, `daily`) — istekten
   * gelen hicbir deger anahtara girmez, onbellek buyuyemez.
   */
  readonly #cache = new Map<string, { at: number; value: unknown }>()

  constructor(private readonly deps: LeaderboardDeps) {}

  top(period: Period, country: string | null, limit: number): Row[] {
    return rank(this.#totals(period), this.deps.profiles.all(), country).slice(0, limit)
  }

  countries(): CountryStat[] {
    const by = new Map<string, { devs: number; impressions: number; earned: bigint }>()
    for (const row of rank(this.#totals('all'), this.deps.profiles.all())) {
      if (row.country === null) continue
      const s = by.get(row.country) ?? { devs: 0, impressions: 0, earned: 0n }
      s.devs += 1
      s.impressions += row.impressions
      s.earned += BigInt(row.earnedStroops)
      by.set(row.country, s)
    }
    return [...by].map(([country, s]) => ({
      country, devs: s.devs, impressions: s.impressions, earnedStroops: s.earned.toString(),
    })).sort((a, b) => b.devs - a.devs || b.impressions - a.impressions)
  }

  /** Tek bir listelenmis profil; listelenmemisse ya da kazanci yoksa `null`. */
  profile(nickname: string, period: Period): ProfileDetail | null {
    const p = this.deps.profiles.byNickname(nickname)
    if (!p || !p.listed) return null

    const all = rank(this.#totals(period), this.deps.profiles.all())
    const row = all.find((r) => r.nickname === p.nickname)
    if (!row) return null

    const countryRank = p.country === null ? null
      : all.filter((r) => r.country === p.country).findIndex((r) => r.nickname === p.nickname) + 1

    const daily = this.#daily().get(p.publisherId)
    return {
      ...row, countryRank,
      dailyStroops: daily ? daily.map(String) : Array.from({ length: HISTORY_DAYS }, () => '0'),
    }
  }

  /** Son `HISTORY_DAYS` gunun gunluk kazanci, butun yayincilar icin TEK taramada. */
  #daily(): Map<string, bigint[]> {
    return this.#cached('daily', () => {
      const today = Math.floor(this.deps.now() / DAY_MS)
      const first = today - HISTORY_DAYS + 1
      const out = new Map<string, bigint[]>()
      for (const e of this.deps.entries()) {
        const day = Math.floor(e.createdAt / DAY_MS)
        if (day < first || day > today) continue
        const c = counted(e, this.deps.advertiserOf)
        if (!c) continue
        let days = out.get(c.publisherId)
        if (!days) out.set(c.publisherId, days = Array.from({ length: HISTORY_DAYS }, () => 0n))
        days[day - first]! += c.amount
      }
      return out
    })
  }

  #totals(period: Period): Map<string, Totals> {
    const ms = PERIOD_MS[period]
    return this.#cached(`totals:${period}`, () =>
      totalsSince(this.deps.entries(), this.deps.advertiserOf, ms === null ? null : this.deps.now() - ms))
  }

  #cached<T>(key: string, compute: () => T): T {
    const now = this.deps.now()
    const hit = this.#cache.get(key)
    if (hit && now - hit.at < (this.deps.cacheMs ?? 30_000)) return hit.value as T
    const value = compute()
    this.#cache.set(key, { at: now, value })
    return value
  }
}
