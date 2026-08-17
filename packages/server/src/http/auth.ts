/**
 * Kimlik ve yetki — ADR-010, ADR-014.
 *
 * Her cagri bir device token tasir. Token'in KAPSAMI (scope) vardir ve bu
 * kapsam ilk surumde bulunmak zorundadir: sonradan eklenirse eski token'lar
 * kapsamsiz olur ve "kapsami olmayan token her seyi yapabilir" varsayimina
 * dusmek zorunda kalirsin.
 *
 * Somut sonucu: daemon yalnizca `report:impressions` + `read:balance` tasir.
 * Calinmis bir daemon token'i cuzdan degistiremez.
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import type { TokenScope } from '@dwell/protocol'

export interface DeviceTokenRecord {
  readonly id: string
  readonly publisherId: string
  /** Ham token ASLA saklanmaz — yalnizca hash'i. */
  readonly tokenHash: string
  readonly scopes: readonly TokenScope[]
  readonly clientVersion: string | null
  readonly revokedAt: number | null
  readonly lastSeenAt: number | null
}

export interface AuthContext {
  readonly publisherId: string
  readonly tokenId: string
  readonly scopes: readonly TokenScope[]
}

export const hashToken = (raw: string): string =>
  createHash('sha256').update(raw).digest('hex')

/**
 * Sabit zamanli karsilastirma. Normal `===` ile token dogrulamak, saldirgana
 * karakter karakter tahmin imkani veren bir zamanlama yan kanali acar.
 */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

/**
 * HTTP katmaninin token'lardan ihtiyaci olan tek sey.
 *
 * Somut sinif yerine arayuz: bellekteki ve SQLite'li surumler ayni yere
 * takilabiliyor. `AppDeps` somut `TokenStore`'a bagliyken kalici surumu
 * gecirmek imkansizdi.
 */
export interface TokenLookup {
  find(rawToken: string): DeviceTokenRecord | null
  touch(tokenId: string, at: number, clientVersion: string | null): void
}

export class TokenStore implements TokenLookup {
  readonly #byHash = new Map<string, DeviceTokenRecord>()

  add(rec: DeviceTokenRecord): void { this.#byHash.set(rec.tokenHash, rec) }

  find(rawToken: string): DeviceTokenRecord | null {
    const rec = this.#byHash.get(hashToken(rawToken))
    if (!rec) return null
    // Hash eslesti ama yine de sabit zamanli dogrula: map lookup'ta erken
    // cikis yok, ama alisilmis olan bu.
    return safeEqual(rec.tokenHash, hashToken(rawToken)) ? rec : null
  }

  revoke(tokenId: string, at: number): boolean {
    for (const [h, r] of this.#byHash) {
      if (r.id === tokenId) { this.#byHash.set(h, { ...r, revokedAt: at }); return true }
    }
    return false
  }

  touch(tokenId: string, at: number, clientVersion: string | null): void {
    for (const [h, r] of this.#byHash) {
      if (r.id === tokenId) {
        this.#byHash.set(h, { ...r, lastSeenAt: at, clientVersion: clientVersion ?? r.clientVersion })
        return
      }
    }
  }

  forPublisher(publisherId: string): readonly DeviceTokenRecord[] {
    return [...this.#byHash.values()].filter((r) => r.publisherId === publisherId)
  }
}

/** `Authorization: Bearer <token>` ayristirir. */
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null
  const m = /^Bearer\s+(.+)$/i.exec(header.trim())
  return m?.[1] ?? null
}
