/**
 * Sponsorun acik havuzlarina ayrilmis, henuz harcanmamis tutar — NEXT.md §10.
 *
 * TEK YERDE hesaplaniyor ve uc yer kullaniyor: reklam secimi (sponsorun
 * normal kampanyalari bu parayi harcayamaz), reklamveren cekimi (sponsor bu
 * parayi havuz acikken cekemez) ve panel (ne kadarin ayrildigini gosterir).
 * Ucunun ayri hesaplamasi, birinin digerinden farkli rakam soylemesi demek.
 */

import { stroops, type Stroops } from '@dwell/protocol'
import type { PoolStore, Pool } from './pool-store.js'
import type { CampaignStore } from '../ads/campaign-store.js'

export interface ReserveDeps {
  readonly pools: PoolStore
  readonly campaigns: CampaignStore
  /** `Pipeline.spentOn` — teslim edilmis + pending + verified. */
  readonly spentOn: (campaignIds: ReadonlySet<string>) => Stroops
}

export const poolCampaignIds = (deps: Pick<ReserveDeps, 'campaigns'>, poolId: string): Set<string> =>
  new Set(deps.campaigns.forPool(poolId).map((c) => c.id))

export const poolSpent = (deps: ReserveDeps, pool: Pool): Stroops =>
  deps.spentOn(poolCampaignIds(deps, pool.id))

export function poolReserve(deps: ReserveDeps, sponsorId: string): Stroops {
  let reserved = 0n
  for (const p of deps.pools.openForSponsor(sponsorId)) {
    const left = p.budget - poolSpent(deps, p)
    if (left > 0n) reserved += left
  }
  return stroops(reserved)
}
