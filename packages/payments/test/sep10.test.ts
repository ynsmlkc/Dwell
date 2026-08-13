import { describe, it, expect, beforeEach } from 'vitest'
import { Keypair, TransactionBuilder, Networks } from '@stellar/stellar-sdk'
import { fixedClock } from '@dwell/protocol'
import { Sep10 } from '../src/sep10.js'

const SERVER = Keypair.random()
const USER = Keypair.random()
const OTHER = Keypair.random()

let clock: ReturnType<typeof fixedClock>
let sep10: Sep10

beforeEach(() => {
  clock = fixedClock(1_700_000_000_000)
  sep10 = new Sep10({
    serverKeypair: SERVER,
    homeDomain: 'dwell.dev',
    webAuthDomain: 'auth.dwell.dev',
    networkPassphrase: Networks.TESTNET,
  }, clock)
})

/** Kullanicinin cuzdaninin yaptigi sey: challenge'i imzala. */
function sign(xdr: string, kp: Keypair, network = Networks.TESTNET): string {
  const tx = TransactionBuilder.fromXDR(xdr, network)
  tx.sign(kp)
  return tx.toXDR()
}

const single = (kp: Keypair) => ({ signers: [{ key: kp.publicKey(), weight: 1 }], medThreshold: 1 })

describe('challenge uretimi', () => {
  it('gecerli bir challenge uretir', () => {
    const c = sep10.challenge(USER.publicKey())
    expect(c.xdr).toBeTruthy()
    expect(c.networkPassphrase).toBe(Networks.TESTNET)
    expect(c.expiresAt).toBeGreaterThan(clock.now())
  })

  it('challenge AGA SUBMIT EDILEMEZ — sequence sifir', () => {
    // SEP-10'un butun guvenligi buradan geliyor: kullanici kor imzalasa bile
    // bu transaction hicbir zaman islenemez.
    const c = sep10.challenge(USER.publicKey())
    const tx = TransactionBuilder.fromXDR(c.xdr, Networks.TESTNET)
    expect('sequence' in tx && tx.sequence).toBe('0')
  })

  it('her challenge farkli — replay yok', () => {
    expect(sep10.challenge(USER.publicKey()).xdr).not.toBe(sep10.challenge(USER.publicKey()).xdr)
  })
})

describe('dogrulama', () => {
  it('dogru kullanici imzalarsa gecer', () => {
    const c = sep10.challenge(USER.publicKey())
    const r = sep10.verify(sign(c.xdr, USER), USER.publicKey(), single(USER))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.signers).toContain(USER.publicKey())
  })

  it('imzasiz challenge reddedilir', () => {
    const c = sep10.challenge(USER.publicKey())
    const r = sep10.verify(c.xdr, USER.publicKey(), single(USER))
    expect(r.ok).toBe(false)
  })

  it('BASKASI imzalarsa reddedilir', () => {
    const c = sep10.challenge(USER.publicKey())
    const r = sep10.verify(sign(c.xdr, OTHER), USER.publicKey(), single(USER))
    expect(r.ok).toBe(false)
  })

  it('yanlis hesap icin uretilmis challenge reddedilir', () => {
    const c = sep10.challenge(OTHER.publicKey())
    const r = sep10.verify(sign(c.xdr, OTHER), USER.publicKey(), single(USER))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('yanlis_hesap')
  })

  it('BASKA AGDA imzalanmis challenge reddedilir', () => {
    // Testnette uretilmis bir imza mainnette gecerli SAYILMAMALI.
    const c = sep10.challenge(USER.publicKey())
    const r = sep10.verify(sign(c.xdr, USER, Networks.PUBLIC), USER.publicKey(), single(USER))
    expect(r.ok).toBe(false)
  })

  it('cop XDR reddedilir', () => {
    const r = sep10.verify('bu-xdr-degil', USER.publicKey(), single(USER))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('gecersiz_xdr')
  })

  it('red sebebi HER ZAMAN raporlanir — kullaniciya "gecersiz" demek yetmez', () => {
    const cases = [
      sep10.verify('cop', USER.publicKey(), single(USER)),
      sep10.verify(sep10.challenge(USER.publicKey()).xdr, USER.publicKey(), single(USER)),
      sep10.verify(sign(sep10.challenge(OTHER.publicKey()).xdr, OTHER), USER.publicKey(), single(USER)),
    ]
    for (const r of cases) {
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.reason).toBeTruthy()
        expect(r.detail.length).toBeGreaterThan(0)
      }
    }
  })
})

describe('multisig — ADR-014', () => {
  const CO1 = Keypair.random()
  const CO2 = Keypair.random()

  /** LOBSTR 2FA veya kurumsal treasury: master key agirligi 0. */
  const multisigAccount = {
    signers: [
      { key: USER.publicKey(), weight: 0 },      // master devre disi
      { key: CO1.publicKey(), weight: 1 },
      { key: CO2.publicKey(), weight: 1 },
    ],
    medThreshold: 2,
  }

  it('master key agirligi 0 olan hesapta tek imza YETMEZ', () => {
    const c = sep10.challenge(USER.publicKey())
    const r = sep10.verify(sign(c.xdr, USER), USER.publicKey(), multisigAccount)
    expect(r.ok).toBe(false)
  })

  it('esigi karsilayan imzalar gecer — ham ed25519 bunu REDDEDERDI', () => {
    // Iste bu yuzden kendi dogrulamamizi yazmiyoruz: imzalayan anahtarlar
    // adresin kendisi degil, ama hesap tamamen gecerli bir odeme hedefi.
    const c = sep10.challenge(USER.publicKey())
    const tx = TransactionBuilder.fromXDR(c.xdr, Networks.TESTNET)
    tx.sign(CO1); tx.sign(CO2)

    const r = sep10.verify(tx.toXDR(), USER.publicKey(), multisigAccount)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.signers).toHaveLength(2)
  })

  it('esigin altinda kalan imza sayisi reddedilir ve sebebi soylenir', () => {
    const c = sep10.challenge(USER.publicKey())
    const r = sep10.verify(sign(c.xdr, CO1), USER.publicKey(), multisigAccount)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('esik_altinda')
  })
})

describe('zincirde olmayan hesap', () => {
  it('master key\'e karsi dogrulanir', () => {
    const c = sep10.challenge(USER.publicKey())
    const r = sep10.verify(sign(c.xdr, USER), USER.publicKey(), null)
    expect(r.ok).toBe(true)
  })
})
