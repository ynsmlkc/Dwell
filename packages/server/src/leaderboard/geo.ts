/**
 * IP'den ulke TAHMINI — yalnizca profil formunu onceden doldurmak icin.
 *
 * CCgather ile ayni yaklasim: kayitta bir kez tahmin edilir, kullanici
 * onaylar ya da degistirir; son soz kullanicinin. Bu bir DOGRULAMA degil
 * (VPN, seyahat, sirket agi yaniltir) ve oyle kullanilmamali.
 *
 * Gizlilik: IP hicbir yere gonderilmez ve saklanmaz. Ya barindirma
 * platformunun koydugu ulke basligi okunur, ya da sunucunun icindeki yerel
 * veritabanina bakilir; geriye yalnizca "TR" gibi iki harf kalir.
 */

import { readFileSync, existsSync } from 'node:fs'
import { Reader, type CountryResponse } from 'maxmind'
import { COUNTRY_CODES } from './countries.js'

export type CountryLookup = (ip: string) => string | null

/**
 * Platformlarin istege kendiliginden ekledigi ulke basliklari. Railway
 * eklemiyor; onune Cloudflare konursa `cf-ipcountry` dogrudan calisir.
 */
const COUNTRY_HEADERS = ['cf-ipcountry', 'x-vercel-ip-country', 'cloudfront-viewer-country'] as const

const valid = (raw: string | null | undefined): string | null => {
  const code = raw?.trim().toUpperCase()
  // `XX` / `T1` (Tor) gibi bilinmeyen kodlar profilde secilemiyor.
  return code && COUNTRY_CODES.has(code) ? code : null
}

/** Istegin ulkesi: once platform basligi, yoksa yerel veritabani. */
export function countryFromRequest(
  header: (name: string) => string | undefined,
  lookup: CountryLookup | null,
): string | null {
  for (const h of COUNTRY_HEADERS) {
    const c = valid(header(h))
    if (c) return c
  }
  if (!lookup) return null
  // Ilk adres istemcinin kendisi; arkadakiler araya giren vekiller.
  const ip = header('x-forwarded-for')?.split(',')[0]?.trim() ?? header('x-real-ip')?.trim()
  if (!ip) return null
  try {
    return valid(lookup(ip))
  } catch {
    return null   // bozuk adres tahmini durdurur, istegi degil
  }
}

/**
 * DB-IP "IP to Country Lite" (CC BY 4.0, https://db-ip.com) — MaxMind
 * GeoLite2-Country ile ayni bicim. Dosya yoksa tahmin sessizce kapanir;
 * kullanici ulkesini elle secer, baska hicbir sey etkilenmez.
 */
export function openCountryDb(path: string): CountryLookup | null {
  if (!existsSync(path)) return null
  const reader = new Reader<CountryResponse>(readFileSync(path))
  return (ip) => reader.get(ip)?.country?.iso_code ?? null
}
