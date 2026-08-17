/**
 * Kalici depolar.
 *
 * Her biri mevcut bellek surumunun yerine geciyor ve AYNI arayuzu
 * uyguluyor — cagiran taraf hicbir sey bilmiyor.
 *
 * Ortak desen: bellekte tut, yazarken diske de yaz, acilista diskten yukle.
 * Yukleme sirasi onemli degil cunku her depo bagimsiz.
 */

import { stroops, add, ZERO, type Stroops, type Clock, type TokenScope } from '@dwell/protocol'
import type { LedgerStore, Entry, NewEntry, RefType, Asset } from '../ledger/ledger.js'
import type { AccountId } from '../ledger/accounts.js'
import { hashToken, type DeviceTokenRecord } from '../http/auth.js'
import type { PayoutStore, PayoutItemRecord, PayoutItemState } from '../payouts/store.js'
import type { StoredImpression, DeliveredAd } from '../impressions/ingest.js'
import type { SubmissionReceipt, WalletBinding } from '@dwell/payments'
import { type Db, numOrNull, strOrNull, toInt, toBool } from './db.js'

/* ─────────────────────────── defter ─────────────────────────── */

export class SqliteLedgerStore implements LedgerStore {
  readonly #entries: Entry[] = []
  readonly #byKey = new Map<string, Entry>()

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly newId: () => string,
  ) {
    this.#load()
  }

  #load(): void {
    const rows = this.db.prepare('SELECT * FROM ledger_entries ORDER BY created_at, id').all() as any[]
    for (const r of rows) {
      const e: Entry = {
        id: String(r.id),
        accountId: String(r.account_id) as AccountId,
        amount: stroops(BigInt(r.amount)),
        asset: String(r.asset) as Asset,
        type: String(r.type) as Entry['type'],
        refType: String(r.ref_type) as RefType,
        refId: String(r.ref_id),
        idempotencyKey: String(r.idempotency_key),
        createdAt: Number(r.created_at),
        campaignId: strOrNull(r.campaign_id),
        publisherId: strOrNull(r.publisher_id),
        rateStroops: r.rate_stroops === null ? null : stroops(BigInt(r.rate_stroops)),
      }
      this.#entries.push(e)
      this.#byKey.set(e.idempotencyKey, e)
    }
  }

  append(entries: readonly NewEntry[]): readonly Entry[] {
    const existing = entries.map((e) => this.#byKey.get(e.idempotencyKey)).filter(Boolean) as Entry[]
    if (existing.length > 0) {
      if (existing.length !== entries.length) {
        throw new Error(
          `kismi idempotency cakismasi: ${existing.length}/${entries.length} — grup atomik yazilmamis`,
        )
      }
      return existing
    }

    const now = this.clock.now()
    const written = entries.map((e) => ({ ...e, id: this.newId(), createdAt: now }))

    // TEK TRANSACTION. Cift kayitli defterin butun anlami grubun BOLUNMEZ
    // olmasi: yarisi yazilirsa bakiyeler tutmaz ve `audit()` bunu ancak
    // sonradan fark eder.
    const stmt = this.db.prepare(`
      INSERT INTO ledger_entries
        (id, account_id, amount, asset, type, ref_type, ref_id, idempotency_key,
         created_at, campaign_id, publisher_id, rate_stroops)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this.db.exec('BEGIN')
    try {
      for (const e of written) {
        stmt.run(
          e.id, e.accountId, e.amount.toString(), e.asset, e.type, e.refType, e.refId,
          e.idempotencyKey, e.createdAt, e.campaignId, e.publisherId,
          e.rateStroops === null ? null : e.rateStroops.toString(),
        )
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }

    // Diske yazma BASARILI olduktan sonra bellege al. Tersi olsaydi, disk
    // yazmasi patladiginda bellek diskten ileri giderdi ve yeniden
    // baslatmada para "kaybolmus" gorunurdu.
    for (const e of written) {
      this.#entries.push(e)
      this.#byKey.set(e.idempotencyKey, e)
    }
    return written
  }

  byIdempotencyKey(key: string): Entry | null { return this.#byKey.get(key) ?? null }

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

/* ─────────────────────────── token'lar ─────────────────────────── */

/**
 * `TokenStore`'un kalici surumu.
 *
 * Kalici olmasi sart: token kaybolursa kullanici SESSIZCE cikis yapmis olur.
 * Daemon reklam istemeye devam eder, 401 alir, hicbir sey basmaz — kullanici
 * yalnizca reklamlarin durdugunu gorur ve sebebini bilemez.
 */
export class SqliteTokenStore {
  readonly #byHash = new Map<string, DeviceTokenRecord>()

  constructor(private readonly db: Db) {
    const rows = this.db.prepare('SELECT * FROM tokens').all() as any[]
    for (const r of rows) {
      this.#byHash.set(String(r.token_hash), {
        id: String(r.id),
        publisherId: String(r.publisher_id),
        tokenHash: String(r.token_hash),
        scopes: JSON.parse(String(r.scopes)) as TokenScope[],
        clientVersion: strOrNull(r.client_version),
        revokedAt: numOrNull(r.revoked_at),
        lastSeenAt: numOrNull(r.last_seen_at),
      })
    }
  }

  add(rec: DeviceTokenRecord): void {
    this.db.prepare(`
      INSERT INTO tokens (id, publisher_id, token_hash, scopes, client_version, revoked_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(token_hash) DO UPDATE SET
        client_version = excluded.client_version,
        revoked_at     = excluded.revoked_at,
        last_seen_at   = excluded.last_seen_at
    `).run(
      rec.id, rec.publisherId, rec.tokenHash, JSON.stringify(rec.scopes),
      rec.clientVersion, rec.revokedAt, rec.lastSeenAt,
    )
    this.#byHash.set(rec.tokenHash, rec)
  }

  find(rawToken: string): DeviceTokenRecord | null {
    return this.#byHash.get(hashToken(rawToken)) ?? null
  }

  revoke(tokenId: string, at: number): boolean {
    for (const [h, r] of this.#byHash) {
      if (r.id !== tokenId) continue
      this.db.prepare('UPDATE tokens SET revoked_at = ? WHERE id = ?').run(at, tokenId)
      this.#byHash.set(h, { ...r, revokedAt: at })
      return true
    }
    return false
  }

  /**
   * Son gorulme zamani.
   *
   * Her istekte cagriliyor ve her seferinde diske yazmak bosuna I/O olurdu:
   * bu bilgi yalnizca teshis icin, bir dakika eski olmasi kimseyi
   * ilgilendirmiyor. Bellekte hemen, diske seyrek.
   */
  touch(tokenId: string, at: number, clientVersion: string | null): void {
    for (const [h, r] of this.#byHash) {
      if (r.id !== tokenId) continue
      this.#byHash.set(h, { ...r, lastSeenAt: at, clientVersion: clientVersion ?? r.clientVersion })
      const oncekiYazma = this.#lastFlush.get(tokenId) ?? 0
      if (at - oncekiYazma > 60_000) {
        this.#lastFlush.set(tokenId, at)
        this.db.prepare('UPDATE tokens SET last_seen_at = ?, client_version = ? WHERE id = ?')
          .run(at, clientVersion, tokenId)
      }
      return
    }
  }

  readonly #lastFlush = new Map<string, number>()

  forPublisher(publisherId: string): readonly DeviceTokenRecord[] {
    return [...this.#byHash.values()].filter((r) => r.publisherId === publisherId)
  }
}

/* ─────────────────────────── odeme kayitlari ─────────────────────────── */

export class SqlitePayoutStore implements PayoutStore {
  readonly #items: PayoutItemRecord[] = []
  readonly #receipts = new Map<string, SubmissionReceipt>()

  constructor(private readonly db: Db) {
    const rows = this.db.prepare('SELECT * FROM payout_items ORDER BY submitted_at').all() as any[]
    for (const r of rows) {
      const rec: PayoutItemRecord = {
        batchId: String(r.batch_id),
        publisherId: String(r.publisher_id),
        destinationAddress: String(r.destination_address),
        amount: stroops(BigInt(r.amount)),
        opIndex: Number(r.op_index),
        txHash: String(r.tx_hash),
        envelopeXdr: String(r.envelope_xdr),
        sourceSeq: String(r.source_seq),
        maxTime: Number(r.max_time),
        state: String(r.state) as PayoutItemState,
        submittedAt: Number(r.submitted_at),
        settledAt: numOrNull(r.settled_at),
        failureReason: strOrNull(r.failure_reason),
      }
      this.#items.push(rec)
      this.#rebuildReceipt(rec)
    }
  }

  /**
   * Makbuzu kayitlardan yeniden kurar.
   *
   * Ayri bir tabloda tutmuyoruz cunku butun alanlari zaten kalemlerde var.
   * `opIndex` eslemesi de oradan geliyor — hangi odemenin hangi operasyonda
   * oldugu, kismi basarisizlikta tek dogru kaynak.
   */
  #rebuildReceipt(rec: PayoutItemRecord): void {
    const mevcut = this.#receipts.get(rec.batchId)
    const opIndex = [...(mevcut?.opIndex ?? []), { publisherId: rec.publisherId, index: rec.opIndex }]
    this.#receipts.set(rec.batchId, {
      batchId: rec.batchId, txHash: rec.txHash, envelopeXdr: rec.envelopeXdr,
      sourceSeq: rec.sourceSeq, maxTime: rec.maxTime,
      feeBid: 0n,                       // yalnizca teshis icin; mutabakati etkilemiyor
      opIndex,
    })
  }

  recordSubmit(input: {
    receipt: SubmissionReceipt
    items: readonly { publisherId: string; address: string; amount: Stroops }[]
    at: number
  }): readonly PayoutItemRecord[] {
    const { receipt } = input
    const varolan = this.byBatch(receipt.batchId)
    if (varolan.length > 0) return varolan

    const indexOf = new Map(receipt.opIndex.map((o) => [o.publisherId, o.index]))
    const yeni = input.items.map((it): PayoutItemRecord => {
      const opIndex = indexOf.get(it.publisherId)
      if (opIndex === undefined) {
        throw new Error(`op_index eksik: ${it.publisherId} (batch ${receipt.batchId})`)
      }
      return {
        batchId: receipt.batchId, publisherId: it.publisherId, destinationAddress: it.address,
        amount: it.amount, opIndex, txHash: receipt.txHash, envelopeXdr: receipt.envelopeXdr,
        sourceSeq: receipt.sourceSeq, maxTime: receipt.maxTime, state: 'submitted',
        submittedAt: input.at, settledAt: null, failureReason: null,
      }
    })

    const stmt = this.db.prepare(`
      INSERT INTO payout_items
        (batch_id, publisher_id, destination_address, amount, op_index, tx_hash,
         envelope_xdr, source_seq, max_time, state, submitted_at, settled_at, failure_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this.db.exec('BEGIN')
    try {
      for (const r of yeni) {
        stmt.run(
          r.batchId, r.publisherId, r.destinationAddress, r.amount.toString(), r.opIndex,
          r.txHash, r.envelopeXdr, r.sourceSeq, r.maxTime, r.state, r.submittedAt, null, null,
        )
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }

    this.#items.push(...yeni)
    this.#receipts.set(receipt.batchId, receipt)
    return yeni
  }

  markSettled(batchId: string, txHash: string, at: number): number {
    return this.#transition(
      batchId,
      (r) => ({ ...r, state: 'settled', txHash, settledAt: at }),
      'UPDATE payout_items SET state = \'settled\', tx_hash = ?, settled_at = ? WHERE batch_id = ? AND state != \'settled\'',
      [txHash, at, batchId],
    )
  }

  markFailed(batchId: string, reason: string, at: number): number {
    return this.#transition(
      batchId,
      (r) => ({ ...r, state: 'failed', settledAt: at, failureReason: reason }),
      'UPDATE payout_items SET state = \'failed\', settled_at = ?, failure_reason = ? WHERE batch_id = ? AND state != \'settled\'',
      [at, reason, batchId],
    )
  }

  #transition(
    batchId: string,
    fn: (r: PayoutItemRecord) => PayoutItemRecord,
    sql: string,
    params: unknown[],
  ): number {
    // `settled` SON DURAKTIR — hem bellekte hem SQL'de. Zincirde onaylanmis
    // bir odemeyi sonradan `failed` yapmak, olmamis bir iadeyi yazmak olurdu.
    this.db.prepare(sql).run(...(params as never[]))
    let n = 0
    for (let i = 0; i < this.#items.length; i++) {
      const r = this.#items[i]!
      if (r.batchId !== batchId || r.state === 'settled') continue
      this.#items[i] = fn(r)
      n++
    }
    return n
  }

  forPublisher(publisherId: string, limit = 20): readonly PayoutItemRecord[] {
    return this.#items
      .filter((r) => r.publisherId === publisherId)
      .sort((a, b) => b.submittedAt - a.submittedAt)
      .slice(0, limit)
  }

  byBatch(batchId: string): readonly PayoutItemRecord[] {
    return this.#items.filter((r) => r.batchId === batchId)
  }

  unresolved(): readonly { batchId: string; receipt: SubmissionReceipt }[] {
    const acik = new Set(this.#items.filter((r) => r.state === 'submitted').map((r) => r.batchId))
    return [...acik].flatMap((b) => {
      const receipt = this.#receipts.get(b)
      return receipt ? [{ batchId: b, receipt }] : []
    })
  }

  all(): readonly PayoutItemRecord[] { return this.#items }
}

/* ─────────────────────── gosterimler ve sunumlar ─────────────────────── */

/**
 * Gosterimleri ve sunulan reklamlari diske yansitir.
 *
 * `Pipeline` bunlari kendi `Map`'lerinde tutuyor; burasi yalnizca yazma
 * tarafina takiliyor ve acilista geri yukluyor.
 */
export class SqliteImpressionMirror {
  constructor(private readonly db: Db) {}

  loadImpressions(): StoredImpression[] {
    return (this.db.prepare('SELECT * FROM impressions').all() as any[]).map((r) => ({
      id: String(r.id),
      publisherId: String(r.publisher_id),
      campaignId: String(r.campaign_id),
      advertiserId: String(r.advertiser_id),
      sessionId: String(r.session_id),
      nonce: String(r.nonce),
      durationMs: Number(r.duration_ms),
      rateStroops: stroops(BigInt(r.rate_stroops)),
      revShareBps: Number(r.rev_share_bps),
      clientTs: Number(r.client_ts),
      serverTs: Number(r.server_ts),
      projectKey: String(r.project_key),
      clientVersion: String(r.client_version),
      ipHash: strOrNull(r.ip_hash),
      state: String(r.state) as StoredImpression['state'],
      rejectReason: strOrNull(r.reject_reason),
    }))
  }

  saveImpression(i: StoredImpression): void {
    this.db.prepare(`
      INSERT INTO impressions
        (publisher_id, id, campaign_id, advertiser_id, session_id, nonce, duration_ms,
         rate_stroops, rev_share_bps, client_ts, server_ts, project_key, client_version,
         ip_hash, state, reject_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(publisher_id, id) DO UPDATE SET
        state = excluded.state, reject_reason = excluded.reject_reason
    `).run(
      i.publisherId, i.id, i.campaignId, i.advertiserId, i.sessionId, i.nonce, i.durationMs,
      i.rateStroops.toString(), i.revShareBps, i.clientTs, i.serverTs, i.projectKey,
      i.clientVersion, i.ipHash, i.state, i.rejectReason,
    )
  }

  loadDeliveries(): DeliveredAd[] {
    return (this.db.prepare('SELECT * FROM deliveries').all() as any[]).map((r) => ({
      nonce: String(r.nonce),
      publisherId: String(r.publisher_id),
      campaignId: String(r.campaign_id),
      advertiserId: String(r.advertiser_id),
      rate: stroops(BigInt(r.rate)),
      revShareBps: Number(r.rev_share_bps),
      expiresAt: Number(r.expires_at),
      consumed: toBool(r.consumed),
    }))
  }

  saveDelivery(d: DeliveredAd): void {
    this.db.prepare(`
      INSERT INTO deliveries
        (nonce, publisher_id, campaign_id, advertiser_id, rate, rev_share_bps, expires_at, consumed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(nonce) DO UPDATE SET consumed = excluded.consumed
    `).run(
      d.nonce, d.publisherId, d.campaignId, d.advertiserId, d.rate.toString(),
      d.revShareBps, d.expiresAt, toInt(d.consumed),
    )
  }
}

/* ─────────────────────────── cuzdanlar ─────────────────────────── */

/** `WalletStore`'un kalicilik kancasi. */
export function walletPersistence(db: Db) {
  return {
    load: (): readonly WalletBinding[] =>
      (db.prepare('SELECT * FROM wallets').all() as any[]).map((r) => ({
        publisherId: String(r.publisher_id),
        address: String(r.address),
        network: String(r.network) as WalletBinding['network'],
        verifiedAt: Number(r.verified_at),
        holdUntil: numOrNull(r.hold_until),
        previousAddress: strOrNull(r.previous_address),
      })),

    save: (b: WalletBinding): void => {
      db.prepare(`
        INSERT INTO wallets (publisher_id, address, network, verified_at, hold_until, previous_address)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(publisher_id) DO UPDATE SET
          address          = excluded.address,
          network          = excluded.network,
          verified_at      = excluded.verified_at,
          hold_until       = excluded.hold_until,
          previous_address = excluded.previous_address
      `).run(b.publisherId, b.address, b.network, b.verifiedAt, b.holdUntil, b.previousAddress)
    },
  }
}
