/**
 * Bellekte defter deposu.
 *
 * Uretimde Postgres olacak, ama arayuz ayni kalacak. Once bellekte olmasi
 * defterin mantigini veritabani kurmadan sikica test etmeyi sagliyor —
 * mantik dogru degilse Postgres'in faydasi yok.
 *
 * Postgres surumunun ek olarak saglamasi gerekenler:
 *   • `append` tek transaction icinde
 *   • `idempotency_key` uzerinde UNIQUE index
 *   • `(ref_type, ref_id)` uzerinde index
 */

import { type Stroops, stroops, add, ZERO } from '@dwell/protocol'
import type { Clock } from '@dwell/protocol'
import type { LedgerStore, Entry, NewEntry, RefType, Asset } from './ledger.js'
import type { AccountId } from './accounts.js'

export class MemoryLedgerStore implements LedgerStore {
  readonly #entries: Entry[] = []
  readonly #byKey = new Map<string, Entry>()

  constructor(
    private readonly clock: Clock,
    private readonly newId: () => string,
  ) {}

  append(entries: readonly NewEntry[]): readonly Entry[] {
    // Idempotency: gruptaki anahtarlardan HERHANGI biri varsa, bu grup zaten
    // yazilmis demektir. Hata degil, ORIJINAL SONUC doner (ADR-005).
    const existing = entries.map((e) => this.#byKey.get(e.idempotencyKey)).filter(Boolean) as Entry[]
    if (existing.length > 0) {
      if (existing.length !== entries.length) {
        // Bu bir bug isareti: grubun yarisi yazilmis. Postgres'te transaction
        // bunu imkansiz kilacak; bellekte de sessizce gecmemeli.
        throw new Error(
          `kismi idempotency cakismasi: ${existing.length}/${entries.length} — ` +
          `grup atomik yazilmamis`,
        )
      }
      return existing
    }

    const now = this.clock.now()
    const written = entries.map((e) => ({ ...e, id: this.newId(), createdAt: now }))
    for (const e of written) {
      this.#entries.push(e)
      this.#byKey.set(e.idempotencyKey, e)
    }
    return written
  }

  byIdempotencyKey(key: string): Entry | null {
    return this.#byKey.get(key) ?? null
  }

  byRef(refType: RefType, refId: string): readonly Entry[] {
    return this.#entries.filter((e) => e.refType === refType && e.refId === refId)
  }

  balance(account: AccountId, asset: Asset): Stroops {
    let total = ZERO
    for (const e of this.#entries) {
      if (e.accountId === account && e.asset === asset) total = add(total, stroops(e.amount))
    }
    return total
  }

  all(): readonly Entry[] { return this.#entries }
}
