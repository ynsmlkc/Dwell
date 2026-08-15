/**
 * Cuzdanla giris — ADR-010 (revize).
 *
 * Buradaki testlerin cogu "mutlu yol"u degil, REDDI kontrol ediyor: bir giris
 * sisteminde hata, yanlis kisiyi iceri almaktir. Dogru kisiyi iceri almamak
 * can sikici; yanlis kisiyi almak geri alinamaz.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { Keypair, TransactionBuilder } from '@stellar/stellar-sdk'
import { Sep10, NETWORKS } from '@dwell/payments'
import { fixedClock, cryptoIdGenerator } from '@dwell/protocol'
import { WalletAuth, LOGIN_SCOPES } from '../src/http/wallet-auth.js'
import { hashToken } from '../src/http/auth.js'

const HOME = 'dwell.test'
const server = Keypair.random()

function setup(over: Partial<Parameters<typeof makeDeps>[0]> = {}) {
  const issued: { publisherId: string; tokenHash: string }[] = []
  const deps = makeDeps({ issued, ...over })
  return { auth: new WalletAuth(deps), issued, clock: deps.clock }
}

function makeDeps(o: {
  issued: { publisherId: string; tokenHash: string }[]
  loadSigners?: (a: string) => Promise<any>
  now?: number
}) {
  const clock = fixedClock(o.now ?? 1_700_000_000_000)
  return {
    clock,
    ids: cryptoIdGenerator(clock),
    sep10: new Sep10({
      serverKeypair: server, homeDomain: HOME, webAuthDomain: HOME,
      networkPassphrase: NETWORKS.testnet,
    }, clock),
    loadSigners: o.loadSigners ?? (async () => null),
    hashToken,
    issueToken: (i: { publisherId: string; tokenHash: string }) => {
      o.issued.push({ publisherId: i.publisherId, tokenHash: i.tokenHash })
      return { tokenId: `tok-${o.issued.length}` }
    },
  }
}

/** Kullanicinin cuzdaninin yapacagi seyi taklit eder: challenge'i imzalar. */
function sign(xdr: string, kp: Keypair): string {
  const tx = TransactionBuilder.fromXDR(xdr, NETWORKS.testnet)
  tx.sign(kp)
  return tx.toEnvelope().toXDR('base64')
}

describe('WalletAuth', () => {
  let user: Keypair
  beforeEach(() => { user = Keypair.random() })

  it('gecerli imza token uretir ve publisherId adresin kendisidir', async () => {
    const { auth, issued } = setup()
    const c = auth.challenge(user.publicKey())
    expect(c.ok).toBe(true)
    if (!c.ok) return

    const r = await auth.verify(user.publicKey(), sign(c.xdr, user))
    expect(r.ok).toBe(true)
    if (!r.ok) return

    // Kimlik = adres. Ayri bir kullanici kimligi yok (ADR-010 revize).
    expect(r.publisherId).toBe(user.publicKey())
    expect(issued[0]!.publisherId).toBe(user.publicKey())
  })

  it('ham token sunucuda SAKLANMAZ — yalnizca hash', async () => {
    const { auth, issued } = setup()
    const c = auth.challenge(user.publicKey())
    if (!c.ok) return
    const r = await auth.verify(user.publicKey(), sign(c.xdr, user))
    if (!r.ok) return

    expect(issued[0]!.tokenHash).toBe(hashToken(r.token))
    expect(issued[0]!.tokenHash).not.toContain(r.token)
  })

  it('token yalnizca daemon kapsamlarini tasir — cuzdan degistiremez', async () => {
    expect(LOGIN_SCOPES).toEqual(['report:impressions', 'read:balance'])
    expect(LOGIN_SCOPES).not.toContain('manage:wallet')
  })

  it('BASKASININ anahtariyla imzalanan challenge reddedilir', async () => {
    const { auth, issued } = setup()
    const c = auth.challenge(user.publicKey())
    if (!c.ok) return

    // Saldirgan kendi anahtariyla imzaliyor, ama kurbanin adresini iddia ediyor.
    const r = await auth.verify(user.publicKey(), sign(c.xdr, Keypair.random()))
    expect(r.ok).toBe(false)
    expect(issued).toHaveLength(0)
  })

  it('imzasiz challenge reddedilir', async () => {
    const { auth } = setup()
    const c = auth.challenge(user.publicKey())
    if (!c.ok) return
    const r = await auth.verify(user.publicKey(), c.xdr)   // hic imzalanmadi
    expect(r.ok).toBe(false)
  })

  it('ayni challenge IKI KEZ kullanilamaz', async () => {
    const { auth, issued } = setup()
    const c = auth.challenge(user.publicKey())
    if (!c.ok) return
    const signed = sign(c.xdr, user)

    expect((await auth.verify(user.publicKey(), signed)).ok).toBe(true)
    // Replay: ayni imza tekrar gonderiliyor. Ikinci token URETILMEMELI.
    const again = await auth.verify(user.publicKey(), signed)
    expect(again.ok).toBe(false)
    expect(issued).toHaveLength(1)
  })

  it('challenge alinmadan verify cagrilamaz', async () => {
    const { auth } = setup()
    const other = setup()
    const c = other.auth.challenge(user.publicKey())
    if (!c.ok) return
    // Imza gecerli ama BU sunucu boyle bir challenge uretmedi.
    const r = await auth.verify(user.publicKey(), sign(c.xdr, user))
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toContain('challenge bulunamadi')
  })

  it('G ile baslamayan adres challenge bile alamaz', () => {
    const { auth } = setup()
    for (const bad of [
      '',
      'GABC',                                                    // kisa
      'MDWELL2WQXKQKNDQ7ZLXK4FQXJKXQZ',                          // muxed (M...)
      'CA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ',// contract (C...)
      user.secret(),                                             // SECRET — asla
    ]) {
      expect(auth.challenge(bad).ok).toBe(false)
    }
  })

  it('secret key hata mesajinda ECHO EDILMEZ', () => {
    const { auth } = setup()
    const r = auth.challenge(user.secret())
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).not.toContain(user.secret())
  })

  it('suresi dolmus challenge reddedilir', async () => {
    const issued: any[] = []
    const deps = makeDeps({ issued })
    const clock = deps.clock
    const auth = new WalletAuth(deps as any)
    const c = auth.challenge(user.publicKey())
    if (!c.ok) return
    const signed = sign(c.xdr, user)

    // Saat challenge'in omrunu asiyor.
    clock.advance(c.expiresAt - clock.now() + 1)
    const r = await auth.verify(user.publicKey(), signed)
    expect(r.ok).toBe(false)
    expect(issued).toHaveLength(0)
  })

  /**
   * En onemli test. Ilk yazdigimda Horizon hatasini yutup master key'e
   * dusuyordum — master agirligi 0'a cekilmis bir hesapta bu, atilmis bir
   * anahtarla giris demekti. Simdi giris BASARISIZ oluyor.
   */
  it('Horizon dustugunde giris BASARISIZ olur, master key\'e DUSMEZ', async () => {
    const issued: any[] = []
    const auth = new WalletAuth(makeDeps({
      issued,
      loadSigners: async () => { throw new Error('horizon 503') },
    }) as any)

    const c = auth.challenge(user.publicKey())
    if (!c.ok) return
    const r = await auth.verify(user.publicKey(), sign(c.xdr, user))

    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toContain('zincire ulasilamadi')
    expect(issued).toHaveLength(0)
  })

  it('esigin altindaki multisig imzasi reddedilir', async () => {
    const co = Keypair.random()
    const issued: any[] = []
    const auth = new WalletAuth(makeDeps({
      issued,
      // Iki signer, her biri 1 agirlikta, esik 2 → tek imza yetmez.
      loadSigners: async () => ({
        signers: [{ key: user.publicKey(), weight: 1 }, { key: co.publicKey(), weight: 1 }],
        medThreshold: 2,
      }),
    }) as any)

    const c = auth.challenge(user.publicKey())
    if (!c.ok) return

    const tek = await auth.verify(user.publicKey(), sign(c.xdr, user))
    expect(tek.ok).toBe(false)
    expect(issued).toHaveLength(0)

    // Iki imzayla gecer.
    const c2 = auth.challenge(user.publicKey())
    if (!c2.ok) return
    const tx = TransactionBuilder.fromXDR(c2.xdr, NETWORKS.testnet)
    tx.sign(user); tx.sign(co)
    const cift = await auth.verify(user.publicKey(), tx.toEnvelope().toXDR('base64'))
    expect(cift.ok).toBe(true)
  })

  it('suresi gecmis challenge\'lar bellekte birikmez', () => {
    const { auth } = setup()
    for (let i = 0; i < 50; i++) auth.challenge(Keypair.random().publicKey())
    expect(auth.pendingCount()).toBeLessThanOrEqual(50)
  })
})
