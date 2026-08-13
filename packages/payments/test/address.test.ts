import { describe, it, expect } from 'vitest'
import { Keypair, Asset } from '@stellar/stellar-sdk'
import {
  checkAddressFormat, checkAddressOnChain, checkAddress, shortAddress,
  type OnChainAccount,
} from '../src/address.js'

const kp = Keypair.random()
const ADDRESS = kp.publicKey()
const ISSUER = Keypair.random().publicKey()

const account = (over: Partial<OnChainAccount> = {}): OnChainAccount => ({
  exists: true,
  trustline: { exists: true, authorized: true, limit: 10_000_000_000n, balance: 0n },
  memoRequired: false,
  ...over,
})

const input = (over: Partial<Parameters<typeof checkAddressOnChain>[0]> = {}) => ({
  address: ADDRESS,
  account: account(),
  plannedAmount: 1_000_000n,
  assetIssuer: ISSUER,
  boundToOther: false,
  ...over,
})

describe('bicimsel kontroller', () => {
  it('gecerli G adresi gecer', () => {
    expect(checkAddressFormat(ADDRESS).ok).toBe(true)
  })

  it('bastaki/sondaki bosluk sorun degil', () => {
    expect(checkAddressFormat(`  ${ADDRESS}  `).ok).toBe(true)
  })

  it('SECRET KEY yapistirilirsa durur ve degeri ifsa ETMEZ', () => {
    const r = checkAddressFormat(kp.secret())
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('secret_key')
    // Hata mesaji anahtarin kendisini ICERMEMELI — log'a, ekrana, hata
    // takip sistemine sizmasin.
    expect(r.message).not.toContain(kp.secret())
    expect(r.hint).not.toContain(kp.secret())
    expect(r.hint).toMatch(/ARTIK KULLANMA/)
  })

  it('muxed (M...) adres reddedilir ama sebebi soylenir', () => {
    // M adres 69 karakter — `varchar(56)` kolonlar sessizce kirilir.
    const muxed = 'MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAAAAAAAAAAAAJLK'
    const r = checkAddressFormat(muxed)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('desteklenmeyen_tip_muxed')
    expect(muxed).toHaveLength(69)
  })

  it('contract (C...) adres reddedilir', () => {
    const c = 'CA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUWDA'
    const r = checkAddressFormat(c)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('desteklenmeyen_tip_contract')
  })

  it('cop girdi reddedilir', () => {
    for (const bad of ['', 'merhaba', '0x1234', ADDRESS.slice(0, 55), ADDRESS + 'A']) {
      expect(checkAddressFormat(bad).ok, JSON.stringify(bad)).toBe(false)
    }
  })

  it('checksum bozuksa yakalanir', () => {
    // Son karakteri degistir — StrKey checksum'i tutmaz.
    const broken = ADDRESS.slice(0, -1) + (ADDRESS.at(-1) === 'A' ? 'B' : 'A')
    expect(checkAddressFormat(broken).ok).toBe(false)
  })
})

describe('zincir ustu kontroller — ADR-020', () => {
  it('saglikli adres gecer', () => {
    expect(checkAddressOnChain(input()).ok).toBe(true)
  })

  it('hesap yoksa reddedilir', () => {
    const r = checkAddressOnChain(input({ account: account({ exists: false }) }))
    expect(r.reason).toBe('hesap_yok')
  })

  it('trustline yoksa reddedilir ve COZUM sunulur', () => {
    const r = checkAddressOnChain(input({ account: account({ trustline: null }) }))
    expect(r.reason).toBe('trustline_yok')
    expect(r.hint, 'kullanici cikmaza sokulmaz').toMatch(/aktiflestir/)
  })

  it('yetkisiz trustline reddedilir — listede gorunse bile', () => {
    // `authorized_to_maintain_liabilities` sinsi ara durum.
    const r = checkAddressOnChain(input({
      account: account({ trustline: { exists: true, authorized: false, limit: 1n, balance: 0n } }),
    }))
    expect(r.reason).toBe('trustline_yetkisiz')
  })

  it('trustline limiti yetmezse reddedilir — op_line_full tum batch\'i duserdi', () => {
    const r = checkAddressOnChain(input({
      plannedAmount: 5_000_000n,
      account: account({ trustline: { exists: true, authorized: true, limit: 6_000_000n, balance: 2_000_000n } }),
    }))
    expect(r.reason).toBe('trustline_limiti_yetersiz')
  })

  it('limit tam yeterse gecer', () => {
    expect(checkAddressOnChain(input({
      plannedAmount: 4_000_000n,
      account: account({ trustline: { exists: true, authorized: true, limit: 6_000_000n, balance: 2_000_000n } }),
    })).ok).toBe(true)
  })

  it('memo gerektiren adres reddedilir — borsa adresi', () => {
    const r = checkAddressOnChain(input({ account: account({ memoRequired: true }) }))
    expect(r.reason).toBe('memo_gerekiyor')
    expect(r.message).toMatch(/borsa/)
  })

  it('issuer adresine odeme engellenir — varlik yakilirdi', () => {
    const r = checkAddressOnChain(input({ address: ISSUER }))
    expect(r.reason).toBe('issuer_adresi')
  })

  it('baska hesaba bagli adres reddedilir — sybil savunmasi', () => {
    const r = checkAddressOnChain(input({ boundToOther: true }))
    expect(r.reason).toBe('baska_hesaba_bagli')
  })
})

describe('kontrol sirasi', () => {
  it('secret key kontrolu HER SEYDEN once', () => {
    // Diger her sey bozuk olsa bile once secret uyarisi gelmeli, cunku
    // digerleri degeri log'lamaya yol acabilir.
    const r = checkAddress({ ...input(), address: kp.secret(), account: account({ exists: false }) })
    expect(r.reason).toBe('secret_key')
  })

  it('bicim bozuksa zincire hic gidilmez', () => {
    const r = checkAddress({ ...input(), address: 'cop' })
    expect(r.reason).toBe('gecersiz_bicim')
  })
})

describe('gosterim', () => {
  it('adres kisaltilir', () => {
    expect(shortAddress(ADDRESS)).toMatch(/^.{6}….{4}$/)
    expect(shortAddress('kisa')).toBe('kisa')
  })
})
