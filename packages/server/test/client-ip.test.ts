/**
 * Istemci adresi — `x-forwarded-for`'un ILK degeri istemcinin kendi yazdigi
 * seydir. Guvenilen, vekillerin sona ekledigi kisim.
 */

import { describe, it, expect } from 'vitest'
import { clientIp } from '../src/http/client-ip.js'

const h = (o: Record<string, string>) => (n: string) => o[n]

describe('clientIp', () => {
  it('istemcinin yazdigi ilk degeri DEGIL, vekilin ekledigini alir', () => {
    expect(clientIp(h({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9' }))).toBe('203.0.113.9')
  })

  it('sondaki ic ag vekillerini atlar', () => {
    expect(clientIp(h({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9, 10.0.0.1, 100.64.3.2' })))
      .toBe('203.0.113.9')
    expect(clientIp(h({ 'x-forwarded-for': '203.0.113.9, fd12::1' }))).toBe('203.0.113.9')
  })

  it('tek deger: o deger', () => {
    expect(clientIp(h({ 'x-forwarded-for': '203.0.113.9' }))).toBe('203.0.113.9')
  })

  it('hepsi ic ag ise (yerel gelistirme) en soldaki', () => {
    expect(clientIp(h({ 'x-forwarded-for': '192.168.1.5, 10.0.0.1' }))).toBe('192.168.1.5')
  })

  it('x-forwarded-for yoksa x-real-ip, o da yoksa undefined', () => {
    expect(clientIp(h({ 'x-real-ip': ' 203.0.113.9 ' }))).toBe('203.0.113.9')
    expect(clientIp(h({}))).toBeUndefined()
  })
})
