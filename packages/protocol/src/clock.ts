/**
 * Saat ve kimlik uretimi — enjekte edilebilir.
 *
 * Sistemin her kritik davranisi bir sureye bagli: 10sn gosterim kurali,
 * 24 saatlik pending, 72 saatlik cuzdan beklemesi, odeme dongusu, 90 gunluk
 * retention. `Date.now()` koda dagilirsa bunlarin hicbiri test edilemez ve
 * sonradan geri takmak her dosyaya dokunmak demektir.
 *
 * Bu yuzden `protocol`'un ILK commit'inde bulunmak zorunda (§12.0).
 *
 * Kural: uretim kodunda `Date.now()`, `new Date()` ve `Math.random()`
 * dogrudan cagrilmaz. Yalnizca bu dosyadaki `systemClock` /
 * `cryptoIdGenerator` fabrikalari cagirir.
 */

/** Epoch milisaniye. */
export type Millis = number

export interface Clock {
  now(): Millis
}

export const systemClock: Clock = { now: () => Date.now() }

/** Testler icin: elle ilerletilebilir saat. */
export function fixedClock(start: Millis = 0): Clock & { advance(ms: number): void; set(ms: Millis): void } {
  let t = start
  return {
    now: () => t,
    advance: (ms) => { t += ms },
    set: (ms) => { t = ms },
  }
}

/* ────────────────────────────── ULID ────────────────────────────── */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'   // I, L, O, U yok
const TIME_LEN = 10
const RAND_LEN = 16

export interface IdGenerator {
  /**
   * Gosterim kimligi — istemcide uretilen ULID.
   *
   * Zaman siralı olmasi ingest tarafinda partition ve index icin kritik.
   * DIKKAT: bu deger istemciden geliyor, yani DUSMAN GIRDISIDIR. Sunucuda
   * tekillik `(publisher_id, impression_id)` uzerinde kurulur — tablo
   * genelinde degil. Aksi halde bir istemci baskasinin ULID'ini gonderip
   * onun kaydini "zaten var" durumuna dusurebilir.
   */
  impressionId(): string
  /** Cakismasi kabul edilemez rastgele deger (nonce, challenge, tuz). */
  randomHex(bytes: number): string
}

function encodeTime(now: Millis): string {
  let t = now
  let out = ''
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    out = CROCKFORD[t % 32]! + out
    t = Math.floor(t / 32)
  }
  return out
}

/**
 * Monotonik ULID. Ayni milisaniyede uretilen ikinci kimlik, oncekinin
 * rastgele kismini bir artirarak siralamayi korur — kuyrukta ayni ms icinde
 * yuzlerce olay olusabilir ve sirasiz ULID index'i bozar.
 */
export function cryptoIdGenerator(clock: Clock = systemClock): IdGenerator {
  let lastTime = -1
  let lastRand: number[] = []

  const randomChars = (n: number): number[] => {
    const buf = new Uint8Array(n)
    globalThis.crypto.getRandomValues(buf)
    return Array.from(buf, (b) => b % 32)
  }

  return {
    impressionId() {
      const now = clock.now()
      if (now === lastTime) {
        // ayni ms — son degeri +1
        for (let i = RAND_LEN - 1; i >= 0; i--) {
          if (lastRand[i]! < 31) { lastRand[i]!++; break }
          lastRand[i] = 0
        }
      } else {
        lastTime = now
        lastRand = randomChars(RAND_LEN)
      }
      return encodeTime(now) + lastRand.map((v) => CROCKFORD[v]!).join('')
    },
    randomHex(bytes) {
      const buf = new Uint8Array(bytes)
      globalThis.crypto.getRandomValues(buf)
      return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
    },
  }
}

/** Testler icin: sirali ve tahmin edilebilir kimlikler. */
export function fakeIdGenerator(prefix = 'test'): IdGenerator {
  let n = 0
  return {
    impressionId: () => `${prefix}-${String(++n).padStart(6, '0')}`,
    randomHex: (bytes) => `${prefix}${String(++n)}`.padEnd(bytes * 2, '0').slice(0, bytes * 2),
  }
}

export const ULID_LENGTH = TIME_LEN + RAND_LEN
export const ULID_RE = new RegExp(`^[${CROCKFORD}]{${ULID_LENGTH}}$`)
export const isUlid = (s: string): boolean => ULID_RE.test(s)

/* ───────────────────────── idempotency ───────────────────────── */

/**
 * Ledger idempotency anahtari — ADR-005.
 * Format sabittir; degistirmek gecmis kayitlarla cakisma yaratir.
 * Cakisma durumunda hata degil, ORIJINAL SONUC dondurulur.
 */
export function idempotencyKey(
  refType: string,
  refId: string,
  accountRole: string,
): string {
  for (const [name, part] of Object.entries({ refType, refId, accountRole })) {
    if (!part || part.includes(':')) {
      throw new Error(`idempotencyKey: "${name}" bos olamaz ve ':' iceremez`)
    }
  }
  return `${refType}:${refId}:${accountRole}`
}
