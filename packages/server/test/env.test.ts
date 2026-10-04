/**
 * Uretim ayarlari — eksik olan varsayilana DUSMEZ, sunucuyu durdurur.
 *
 * Denetimde bulundu: `DWELL_PENDING_MS` Railway'de tanimsizdi ve dogrulama
 * penceresi uretimde 24 saat yerine 30 saniyeydi.
 */

import { describe, it, expect } from 'vitest'
import { prodProblems, readServerEnv } from '../src/env.js'

const TAM = {
  DWELL_ENV: 'production',
  DWELL_DB: '/data/dwell.db',
  DWELL_SEP10_SECRET: 'S...',
  DWELL_HOME_DOMAIN: 'dwell.example',
  DWELL_IP_SALT: 'tuz',
}

describe('uretim ayarlari', () => {
  it('gelistirmede hicbir sey zorunlu degil', () => {
    expect(prodProblems({})).toEqual([])
    expect(readServerEnv({}).pendingMs).toBe(30_000)
  })

  it('uretimde DWELL_PENDING_MS verilmezse 24 saat — 30 saniye DEGIL', () => {
    expect(readServerEnv(TAM).pendingMs).toBe(86_400_000)
  })

  it('uretimde eksik zorunlu degisken acilisi durdurur', () => {
    const { DWELL_IP_SALT: _, ...eksik } = TAM
    expect(prodProblems(eksik)).toEqual(['DWELL_IP_SALT tanimli degil'])
    expect(() => readServerEnv(eksik)).toThrow(/DWELL_IP_SALT/)
  })

  it('uretimde birkac saniyelik dogrulama penceresi reddedilir', () => {
    expect(() => readServerEnv({ ...TAM, DWELL_PENDING_MS: '30000' })).toThrow(/en az 1 saat/)
    expect(() => readServerEnv({ ...TAM, DWELL_PENDING_MS: 'abc' })).toThrow(/en az 1 saat/)
    expect(readServerEnv({ ...TAM, DWELL_PENDING_MS: '7200000' }).pendingMs).toBe(7_200_000)
  })

  it('surum kapisi ortamdan ayarlanir, bozuk surum reddedilir', () => {
    expect(readServerEnv({ ...TAM, DWELL_MIN_CLIENT_VERSION: '0.1.13' }).minClientVersion).toBe('0.1.13')
    expect(() => readServerEnv({ ...TAM, DWELL_MIN_CLIENT_VERSION: 'latest' })).toThrow(/surum/)
  })
})
