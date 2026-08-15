/**
 * IPC — shim ile daemon arasindaki yerel protokol.
 */

import { describe, it, expect } from 'vitest'
import { socketPathFor, encode, decode } from '../src/ipc.js'

describe('encode/decode', () => {
  it('gidis donus bozulmaz', () => {
    expect(decode(encode({ t: 'health' }))).toEqual({ t: 'health' })
  })

  /** Bozuk satiri atmak patlamaktan iyidir — bu yol her saniye kat ediliyor. */
  it('bozuk satir null doner, patlamaz', () => {
    expect(decode('{ yarim')).toBeNull()
  })
})

/**
 * Soket yolu uzunlugu.
 *
 * Gercek bir kurulumda bulundu: yol `sun_path` sinirini asinca `listen`
 * hata VERMIYOR, yolu sessizce kesiyor. Ardindan `chmod` beklenen yerde
 * dosya bulamayip ham bir `ENOENT` stack trace'i basiyor ve kullanici
 * neden kurulamadigini asla anlamiyor.
 */
describe('socketPathFor', () => {
  const LIMIT = process.platform === 'linux' ? 107 : 103

  it('normal ev dizininde alisildik yolu kullanir', () => {
    expect(socketPathFor('/Users/ali/.dwell')).toBe('/Users/ali/.dwell/dwelld.sock')
  })

  it('uzun yolda tmpdir altina duser ve SINIRIN ALTINDA kalir', () => {
    const uzun = `/Users/${'x'.repeat(140)}/.dwell`
    const p = socketPathFor(uzun)

    expect(p).not.toContain('x'.repeat(140))
    expect(Buffer.byteLength(p)).toBeLessThanOrEqual(LIMIT)
    expect(p.endsWith('.sock')).toBe(true)
  })

  /**
   * DETERMINIZM sart. Shim ile daemon ayri sureclerdir ve ayni yolu bagimsiz
   * hesaplar; ayrisirlarsa shim bos doner ve hicbir reklam gorunmez.
   */
  it('ayni girdi HER ZAMAN ayni yolu verir', () => {
    const uzun = `/home/${'k'.repeat(140)}/.dwell`
    expect(socketPathFor(uzun)).toBe(socketPathFor(uzun))
  })

  it('farkli ev dizinleri CAKISMAZ', () => {
    const a = socketPathFor(`/home/${'a'.repeat(140)}/.dwell`)
    const b = socketPathFor(`/home/${'b'.repeat(140)}/.dwell`)
    expect(a).not.toBe(b)
  })

  /** Sinir BYTE cinsinden: Turkce karakterler iki byte. */
  it('sinir karakter degil BYTE olarak olculur', () => {
    const turkce = `/Users/${'ş'.repeat(60)}/.dwell`      // 60 karakter, 120 byte
    expect(turkce.length).toBeLessThan(LIMIT)
    expect(Buffer.byteLength(socketPathFor(turkce))).toBeLessThanOrEqual(LIMIT)
  })
})
