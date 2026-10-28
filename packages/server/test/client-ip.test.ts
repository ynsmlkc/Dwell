/**
 * Istemci adresi. Railway kenarinda olculen davranis (bkz. client-ip.ts):
 * `x-real-ip` gercek adres ve istemci onu ezemez; `x-forwarded-for`'un sag
 * ucu Railway'in her istekte degisen kenar sunucusu.
 */

import { describe, it, expect } from 'vitest'
import { clientIp } from '../src/http/client-ip.js'

const h = (o: Record<string, string>) => (n: string) => o[n]

describe('clientIp', () => {
  /** Canlidaki basliklarin BIREBIR kopyasi — iki istek, iki farkli kenar. */
  it('Railway: x-real-ip alinir, degisen kenar adresi DEGIL', () => {
    const a = clientIp(h({ 'x-forwarded-for': '91.93.229.160, 152.233.12.245', 'x-real-ip': '91.93.229.160' }))
    const b = clientIp(h({ 'x-forwarded-for': '91.93.229.160, 152.233.13.166', 'x-real-ip': '91.93.229.160' }))
    expect(a).toBe('91.93.229.160')
    expect(b).toBe(a)               // ayni istemci → ayni kova
  })

  it('gecersiz x-real-ip yok sayilir', () => {
    expect(clientIp(h({ 'x-real-ip': 'bozuk', 'x-forwarded-for': '203.0.113.9' }))).toBe('203.0.113.9')
  })

  describe('x-real-ip yoksa (Railway disi vekil)', () => {
    it('istemcinin yazdigi ilk degeri DEGIL, vekilin ekledigini alir', () => {
      expect(clientIp(h({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9' }))).toBe('203.0.113.9')
    })

    it('sondaki ic ag vekillerini atlar', () => {
      expect(clientIp(h({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9, 10.0.0.1, 100.64.3.2' })))
        .toBe('203.0.113.9')
      expect(clientIp(h({ 'x-forwarded-for': '203.0.113.9, fd12::1' }))).toBe('203.0.113.9')
    })

    it('hepsi ic ag ise (yerel gelistirme) en soldaki', () => {
      expect(clientIp(h({ 'x-forwarded-for': '192.168.1.5, 10.0.0.1' }))).toBe('192.168.1.5')
    })
  })

  it('hicbir baslik yoksa undefined', () => {
    expect(clientIp(h({}))).toBeUndefined()
  })
})
