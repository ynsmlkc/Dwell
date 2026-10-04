/**
 * Yayinci profili — siralamada gorunen kimlik.
 *
 * Kimlik cuzdan adresi (ADR-010) ama siralamada ADRES ASLA GORUNMEZ: bir
 * Stellar adresi, o kisinin butun zincir gecmisini acar. Yerine kullanicinin
 * sectigi bir takma ad ve istege bagli bir ulke var.
 *
 * Varsayilan GORUNMEZ. Profil olusturmak siralamaya girmek demek degil;
 * `listed` acikca `true` yapilmadikca hicbir genel uc bu yayinciyi saymaz.
 */

import { COUNTRY_CODES } from './countries.js'

export interface Profile {
  readonly publisherId: string
  readonly nickname: string
  /** ISO 3166-1 alpha-2, buyuk harf. `null` = ulke belirtilmedi. */
  readonly country: string | null
  /** Genel siralamada gorunsun mu. */
  readonly listed: boolean
  readonly updatedAt: number
}

export type ProfileInput = Pick<Profile, 'nickname' | 'country' | 'listed'>

/**
 * Takma ad YALNIZCA ASCII harf, rakam, `_ . -`.
 *
 * Reklam metninde oldugu gibi (README: "ad copy is hostile input") takma ad
 * da baskasinin ekraninda gorunen yabanci girdi. Unicode'a izin vermek bidi
 * override, gorunmez karakter ve benzer-harf (`раypal`) kapisini acar;
 * bunlari temizlemeye calismak yerine dar bir alfabe kabul ediliyor.
 */
const NICKNAME = /^[A-Za-z0-9_.-]{3,20}$/

export function validateProfile(raw: unknown):
  | { ok: true; value: ProfileInput }
  | { ok: false; reason: string } {
  const b = raw as Record<string, unknown> | null
  if (!b || typeof b !== 'object') return { ok: false, reason: 'govde JSON nesnesi olmali' }

  const nickname = typeof b['nickname'] === 'string' ? b['nickname'].trim() : ''
  if (!NICKNAME.test(nickname)) {
    return { ok: false, reason: 'nickname: 3-20 characters, letters, digits, _ . -' }
  }

  let country: string | null = null
  if (b['country'] !== null && b['country'] !== undefined && b['country'] !== '') {
    if (typeof b['country'] !== 'string') return { ok: false, reason: 'country: ISO 3166-1 alpha-2' }
    country = b['country'].trim().toUpperCase()
    if (!COUNTRY_CODES.has(country)) return { ok: false, reason: `country: unknown code ${country}` }
  }

  if (typeof b['listed'] !== 'boolean') return { ok: false, reason: 'listed: true or false' }

  return { ok: true, value: { nickname, country, listed: b['listed'] } }
}

export interface ProfilePersistence {
  readonly load: () => readonly Profile[]
  readonly save: (p: Profile) => void
}

export class ProfileStore {
  readonly #byPublisher = new Map<string, Profile>()
  /** Kucuk harfli takma ad → publisherId. `Alice` ile `alice` ayni kisi gibi gorunur. */
  readonly #byNickname = new Map<string, string>()

  constructor(private readonly persist?: ProfilePersistence) {
    for (const p of persist?.load() ?? []) this.#index(p)
  }

  get(publisherId: string): Profile | null {
    return this.#byPublisher.get(publisherId) ?? null
  }

  byNickname(nickname: string): Profile | null {
    const id = this.#byNickname.get(nickname.toLowerCase())
    return id === undefined ? null : this.get(id)
  }

  all(): readonly Profile[] {
    return [...this.#byPublisher.values()]
  }

  set(publisherId: string, input: ProfileInput, now: number):
    | { ok: true; profile: Profile }
    | { ok: false; reason: string } {
    const owner = this.#byNickname.get(input.nickname.toLowerCase())
    if (owner !== undefined && owner !== publisherId) {
      return { ok: false, reason: 'nickname is taken' }
    }

    const previous = this.#byPublisher.get(publisherId)
    if (previous) this.#byNickname.delete(previous.nickname.toLowerCase())

    const profile: Profile = { publisherId, ...input, updatedAt: now }
    this.#index(profile)
    this.persist?.save(profile)
    return { ok: true, profile }
  }

  #index(p: Profile): void {
    this.#byPublisher.set(p.publisherId, p)
    this.#byNickname.set(p.nickname.toLowerCase(), p.publisherId)
  }
}
