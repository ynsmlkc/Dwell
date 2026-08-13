import { describe, it, expect, beforeEach } from 'vitest'
import { fixedClock } from '@dwell/protocol'
import { WalletStore, DEFAULT_HOLD_MS, type WalletChangeNotice } from '../src/wallet.js'

const PUB = 'pub-1'
const A1 = 'GA' + 'A'.repeat(54)
const A2 = 'GB' + 'B'.repeat(54)

let clock: ReturnType<typeof fixedClock>
let notices: WalletChangeNotice[]
let store: WalletStore

beforeEach(() => {
  clock = fixedClock(1_700_000_000_000)
  notices = []
  store = new WalletStore({ clock, notify: (n) => notices.push(n) })
})

describe('ilk baglama', () => {
  it('bekleme YOK — ilk adreste beklemek anlamsiz', () => {
    const b = store.bind(PUB, A1, 'testnet')
    expect(b.holdUntil).toBeNull()
    expect(store.payoutBlock(PUB).blocked).toBe(false)
  })

  it('ilk baglamada da bildirim gider', () => {
    // Kullanici kendisi yapmadiysa bunu ancak bildirimle ogrenir.
    store.bind(PUB, A1, 'testnet')
    expect(notices).toHaveLength(1)
    expect(notices[0]!.kind).toBe('ilk_baglama')
  })

  it('cuzdan bagli degilse odeme bloke', () => {
    expect(store.payoutBlock('bilinmeyen')).toMatchObject({ blocked: true, reason: 'cuzdan bagli degil' })
  })
})

describe('ADR-014 — adres degisikligi 72 saat bekler', () => {
  beforeEach(() => { store.bind(PUB, A1, 'testnet'); notices = [] })

  it('degisiklik sonrasi odeme bloke', () => {
    store.bind(PUB, A2, 'testnet')
    const block = store.payoutBlock(PUB)
    expect(block.blocked).toBe(true)
    if (block.blocked) expect(block.reason).toMatch(/72 saat kaldi/)
  })

  it('71 saat sonra hala bloke, 73 saat sonra serbest', () => {
    store.bind(PUB, A2, 'testnet')
    clock.advance(71 * 3600_000)
    expect(store.payoutBlock(PUB).blocked).toBe(true)
    clock.advance(2 * 3600_000)
    expect(store.payoutBlock(PUB).blocked).toBe(false)
  })

  it('kalan sure kullaniciya SOYLENIR', () => {
    store.bind(PUB, A2, 'testnet')
    clock.advance(50 * 3600_000)
    const block = store.payoutBlock(PUB)
    if (block.blocked) expect(block.reason).toMatch(/22 saat/)
  })

  it('AYNI adresi yeniden baglamak bekleme BASLATMAZ', () => {
    // Aksi halde kullanici dogrulamayi her tazeledinde 72 saat cezalanirdi.
    store.bind(PUB, A1, 'testnet')
    expect(store.payoutBlock(PUB).blocked).toBe(false)
  })

  it('degisiklik bildirimi eski ve yeni adresi tasir', () => {
    store.bind(PUB, A2, 'testnet')
    expect(notices[0]).toMatchObject({ kind: 'adres_degisti', previousAddress: A1, newAddress: A2 })
  })
})

describe('§E1 — "ben degilim" kurtarma yolu', () => {
  it('degisiklik geri alinir, eski adrese donulur', () => {
    store.bind(PUB, A1, 'testnet')
    store.bind(PUB, A2, 'testnet')

    const restored = store.revert(PUB)
    expect(restored?.address).toBe(A1)
  })

  it('geri donuste bekleme YOK — kullanici adresi aktif olarak sahiplendi', () => {
    store.bind(PUB, A1, 'testnet')
    store.bind(PUB, A2, 'testnet')
    store.revert(PUB)
    expect(store.payoutBlock(PUB).blocked).toBe(false)
  })

  it('ilk baglama geri alinirsa cuzdan tamamen kaldirilir', () => {
    store.bind(PUB, A1, 'testnet')
    expect(store.revert(PUB)).toBeNull()
    expect(store.get(PUB)).toBeNull()
  })

  it('geri alinan adres baskasina serbest kalir', () => {
    store.bind(PUB, A1, 'testnet')
    store.revert(PUB)
    expect(store.boundToOther(A1, 'baska-pub')).toBe(false)
  })
})

describe('ADR-020 #9 — bir adres bir hesaba', () => {
  it('baska hesaba bagli adres tespit edilir', () => {
    // 500 GitHub hesabi tek cuzdana odeme yapamasin.
    store.bind(PUB, A1, 'testnet')
    expect(store.boundToOther(A1, 'pub-2')).toBe(true)
    expect(store.boundToOther(A1, PUB), 'kendi adresi degil').toBe(false)
  })

  it('adres degisince eskisi serbest kalir', () => {
    store.bind(PUB, A1, 'testnet')
    store.bind(PUB, A2, 'testnet')
    expect(store.boundToOther(A1, 'pub-2')).toBe(false)
    expect(store.boundToOther(A2, 'pub-2')).toBe(true)
  })
})

describe('ag gecisi', () => {
  it('testnet baglamalari mainnet\'e TASINMAZ', () => {
    // Pilotta kullanicilar deneme keypair'i baglayip secret'ini atacak.
    // Tasinirsa gercek USDC erisilemez adreslere gider.
    store.bind('p1', A1, 'testnet')
    store.bind('p2', A2, 'pubnet')

    expect(store.invalidateForNetwork('pubnet')).toBe(1)
    expect(store.get('p1')).toBeNull()
    expect(store.get('p2')).not.toBeNull()
  })

  it('gecersiz kilinan adres serbest kalir', () => {
    store.bind('p1', A1, 'testnet')
    store.invalidateForNetwork('pubnet')
    expect(store.boundToOther(A1, 'p2')).toBe(false)
  })
})
