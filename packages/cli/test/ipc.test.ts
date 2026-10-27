/**
 * IPC — shim ile daemon arasindaki yerel protokol.
 */

import { describe, it, expect } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { socketPathFor, isNamedPipe, dwellHome, encode, decode } from '../src/ipc.js'

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

/**
 * Windows: Node unix soket dosyasi dinleyemez, yerel IPC named pipe ile olur.
 * Gercek kurulumda bulundu — `dwell init` her Windows makinesinde DWL-1001
 * ile dusuyordu.
 */
describe('socketPathFor — Windows', () => {
  const win = (h: string) => socketPathFor(h, 'win32')

  it('named pipe verir, soket dosyasi DEGIL', () => {
    const p = win('C:\\Users\\90542\\.dwell')
    expect(p.startsWith('\\\\.\\pipe\\dwell-')).toBe(true)
    expect(isNamedPipe(p)).toBe(true)
  })

  /** Git Bash'ten gelen yol ile PowerShell'den gelen yol ayni pipe'a cikmali. */
  it('ayirac ve buyuk/kucuk harf farki AYNI pipe\'i verir', () => {
    expect(win('C:/Users/90542/.dwell')).toBe(win('c:\\users\\90542\\.dwell'))
  })

  it('farkli ev dizinleri CAKISMAZ', () => {
    expect(win('C:\\Users\\a\\.dwell')).not.toBe(win('C:\\Users\\b\\.dwell'))
  })

  it('unix yollari pipe sayilmaz', () => {
    expect(isNamedPipe('/Users/ali/.dwell/dwelld.sock')).toBe(false)
    expect(isNamedPipe('C:\\Users\\a\\.dwell\\dwelld.sock')).toBe(false)
  })
})

/** `HOME` Windows'ta tanimli degil; ev dizini ondan okunursa yol bozulur. */
describe('dwellHome', () => {
  it('HOME olmadan da mutlak yol verir', () => {
    expect(dwellHome({})).toBe(join(homedir(), '.dwell'))
  })

  it('DWELL_HOME her seyi ezer', () => {
    expect(dwellHome({ DWELL_HOME: '/tmp/x' })).toBe('/tmp/x')
  })
})
