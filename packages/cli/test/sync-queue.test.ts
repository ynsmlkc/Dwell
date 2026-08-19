/**
 * Reklam onbellegi: kim tuketir, kim yalnizca bakar.
 *
 * Gercekte yasandi: spinner marka adini yazmak icin `nextAd()` cagiriyordu
 * ve reklami kuyruktan SILIYORDU. Spinner ile statusline ayni kuyruktan
 * besleniyor, yani her tur sonunda statusline'in gosterecegi bir reklam
 * hic gosterilmeden gidiyordu. Doluluk dusukken (frekans kurali, az
 * kampanya, sunucu 204) kuyruk dibe vurdugu anda satir bos kaliyordu.
 *
 * Sayim ve odeme yalnizca statusline'dan gelir (ADR-001); spinner bir
 * gorunurluk katmanidir ve hicbir seyi tuketmemelidir.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { FALLBACK_CONFIG, type RemoteConfig, type AdPayload } from '@dwell/protocol'
import { ServerSync } from '../src/daemon/sync.js'
import type { ImpressionQueue } from '../src/daemon/queue.js'

const kreatif = (brand: string) => ({ brand, text: 'metin', cta: 'ornek.com' })

function reklam(brand: string, ttlMs = 600_000): AdPayload {
  return {
    campaignId: `c-${brand}`,
    creative: kreatif(brand),
    nonce: `n-${brand}`,
    nonceExpiresAt: Date.now() + ttlMs,
    rate: '10000',
  } as AdPayload
}

/** Istenen reklamlari sirayla veren sahte sunucu. */
function sahteSunucu(sira: AdPayload[]) {
  let i = 0
  return async (url: string | URL | Request): Promise<Response> => {
    const s = String(url)
    if (s.includes('/v1/config')) {
      return new Response(JSON.stringify(FALLBACK_CONFIG), { status: 200 })
    }
    if (s.includes('/v1/ads/next')) {
      const ad = sira[i++]
      if (!ad) return new Response(null, { status: 204 })
      return new Response(JSON.stringify(ad), { status: 200 })
    }
    return new Response('{}', { status: 200 })
  }
}

const bosKuyruk: ImpressionQueue = {
  add: () => {},
  take: () => [],
  ack: () => {},
  size: () => 0,
} as unknown as ImpressionQueue

let cfg: RemoteConfig

function kur(sira: AdPayload[]) {
  cfg = FALLBACK_CONFIG
  return new ServerSync({
    baseUrl: 'http://yok.local',
    token: 't',
    clientVersion: '0.0.0',
    queue: bosKuyruk,
    config: () => cfg,
    setConfig: (c) => { cfg = c },
    onLog: () => {},
    prefetchCount: 3,
    fetchImpl: sahteSunucu(sira) as unknown as typeof fetch,
  })
}

/** Onbellegi doldurmak icin prefetch'in bitmesini bekle. */
async function doldur(s: ServerSync, hedef: number) {
  for (let i = 0; i < 60 && s.state().adsCached < hedef; i++) {
    s.peekAd()                                  // prefetch'i tetikler
    await new Promise((r) => setTimeout(r, 10))
  }
}

let sync: ServerSync

beforeEach(async () => {
  sync = kur([reklam('A'), reklam('B'), reklam('C'), reklam('D'), reklam('E')])
  await doldur(sync, 2)
})

describe('reklam onbellegi', () => {
  it('peekAd kuyrugu KISALTMAZ', async () => {
    const once = sync.state().adsCached
    sync.peekAd()
    sync.peekAd()
    sync.peekAd()
    expect(sync.state().adsCached).toBe(once)
  })

  it('peekAd her cagrida AYNI reklami verir', () => {
    const a = sync.peekAd()
    expect(sync.peekAd()?.campaignId).toBe(a?.campaignId)
  })

  it('nextAd tuketir — kuyruk kisalir', async () => {
    const once = sync.state().adsCached
    sync.nextAd()
    expect(sync.state().adsCached).toBe(once - 1)
  })

  it('peekAd, nextAd ile ayni reklami gosterir — spinner ile satir ayrismaz', () => {
    const bakilan = sync.peekAd()
    expect(sync.nextAd()?.campaignId).toBe(bakilan?.campaignId)
  })

  /**
   * Asil regresyon: yalnizca spinner calisirken statusline'in reklami
   * tukenmemeli.
   */
  it('yalnizca peek edildiginde statusline hala reklam bulur', async () => {
    for (let i = 0; i < 20; i++) sync.peekAd()          // 20 tur sonu
    expect(sync.nextAd()).not.toBeNull()
  })

  it('bos onbellekte peekAd null doner, patlamaz', async () => {
    const bos = kur([])
    expect(bos.peekAd()).toBeNull()
  })

  it('suresi gecmis reklam peek sirasinda da atilir', async () => {
    const s = kur([reklam('eski', -1000), reklam('yeni')])
    await doldur(s, 1)
    expect(s.peekAd()?.creative.brand).not.toBe('eski')
  })
})
