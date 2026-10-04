/**
 * Ortam degiskenleri — uretimde EKSIK OLANA VARSAYILAN YOK.
 *
 * Denetimde bulundu: `.env.railway` `DWELL_PENDING_MS` icermiyordu ve kod
 * gelistirme varsayilanina (30 saniye) dusuyordu. Tasarimin dayandigi
 * 24 saatlik dogrulama penceresi (§9 katman 2) uretimde hic calismiyordu —
 * kimse fark etmeden. Para yolunu etkileyen bir ayar eksikse sunucu
 * ACILMAMALI; sessizce gevsek bir degerle calismak, hic calismamaktan kotu.
 */

import { semverSchema } from '@dwell/protocol'

type Env = Readonly<Record<string, string | undefined>>

const DAY_MS = 86_400_000

export interface ServerEnv {
  readonly isProd: boolean
  /** Gosterimin dogrulanmadan once bekledigi sure. */
  readonly pendingMs: number
  /** ADR-016 — bunun altindaki istemciler reddedilir. */
  readonly minClientVersion: string
  readonly ipSalt: string
}

/**
 * Uretimde eksik ya da gecersiz olan her sey icin bir satir doner.
 * Bos dizi = acilabilir.
 */
export function prodProblems(env: Env): string[] {
  if (env['DWELL_ENV'] !== 'production') return []
  const out: string[] = []

  for (const k of ['DWELL_DB', 'DWELL_SEP10_SECRET', 'DWELL_HOME_DOMAIN', 'DWELL_IP_SALT'] as const) {
    if (!env[k]) out.push(`${k} tanimli degil`)
  }

  // Acikca verilmisse bile alt sinir var: uretimde birkac saniyelik pencere,
  // anomali kontrolunun para cikmadan once calismasini anlamsiz kilar.
  const pending = env['DWELL_PENDING_MS']
  if (pending !== undefined && !(Number(pending) >= 3600_000)) {
    out.push(`DWELL_PENDING_MS uretimde en az 1 saat olmali (verilen: ${pending})`)
  }

  const min = env['DWELL_MIN_CLIENT_VERSION']
  if (min !== undefined && !semverSchema.safeParse(min).success) {
    out.push(`DWELL_MIN_CLIENT_VERSION gecerli bir surum degil: ${min}`)
  }

  return out
}

export function readServerEnv(env: Env): ServerEnv {
  const problems = prodProblems(env)
  if (problems.length > 0) {
    throw new Error(`uretim ayarlari eksik — sunucu acilmiyor:\n  • ${problems.join('\n  • ')}`)
  }
  const isProd = env['DWELL_ENV'] === 'production'

  return {
    isProd,
    // Uretimde varsayilan 24 saat; gelistirmede 30 saniye (24 saat beklemek
    // gelistirmeyi imkansiz kilar).
    pendingMs: Number(env['DWELL_PENDING_MS'] ?? (isProd ? DAY_MS : 30_000)),
    minClientVersion: env['DWELL_MIN_CLIENT_VERSION'] ?? '0.0.0',
    ipSalt: env['DWELL_IP_SALT'] ?? 'dev-salt-degistir',
  }
}
