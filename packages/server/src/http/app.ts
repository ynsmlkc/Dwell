/**
 * HTTP katmani — §6.3.
 *
 * Ince tutuluyor: dogrulama, yetki, sekil donusumu. Butun karar mantigi
 * `Pipeline` ve `Ledger`'da; buraya is kurali sizarsa test edilemez hale
 * gelir.
 *
 * Uyumluluk (ADR-016): `v1` icinde semalar yalnizca ADDITIVE degisir.
 * Istemci bilinmeyen alanlari yok sayar, sunucu fazlalik alanlari strip eder.
 */

import { Hono } from 'hono'
import { createHash } from 'node:crypto'
import {
  impressionBatchSchema, remoteConfigSchema, PROTOCOL_HEADER, PROTOCOL_VERSION,
  ERROR_CODES, type ErrorCode, type RemoteConfig, type TokenScope,
  stroops, type Stroops,
} from '@dwell/protocol'
import type { Clock, IdGenerator } from '@dwell/protocol'
import type { Pipeline } from '../pipeline.js'
import type { Ledger } from '../ledger/ledger.js'
import { accountId } from '../ledger/accounts.js'
import { bearerToken, type AuthContext, type TokenLookup } from './auth.js'
import type { WalletAuth } from './wallet-auth.js'
import type { PayoutStore } from '../payouts/store.js'
import type { CampaignStore } from '../ads/campaign-store.js'
import { compareVersions } from '../impressions/ingest.js'

export interface AppDeps {
  readonly clock: Clock
  readonly ids: IdGenerator
  readonly pipeline: Pipeline
  readonly ledger: Ledger
  readonly tokens: TokenLookup
  readonly config: () => RemoteConfig
  /** IP'yi hash'lemek icin yerel tuz. Ham IP ASLA saklanmaz (§10). */
  readonly ipSalt: string
  readonly payoutThreshold: Stroops
  readonly explorerBase?: string
  /** Odeme gecmisi. Verilmezse `recentPayouts` bos doner. */
  readonly payouts?: PayoutStore
  /** Reklamveren tarafi. Verilmezse `/v1/advertiser/*` uclari acilmaz. */
  readonly campaigns?: CampaignStore
  /** Sicak cuzdan adresi — reklamveren parayi buraya gonderir. */
  readonly depositAddress?: string
  readonly assetCode?: string
  readonly assetIssuer?: string
  /** Cuzdanla giris. Verilmezse `/v1/auth/*` uclari acilmaz. */
  readonly walletAuth?: WalletAuth
  /** USDC kabulu icin imzasiz islem kurar. */
  readonly trustlineXdr?: (address: string) => Promise<
    | { ok: true; xdr: string; networkPassphrase: string }
    | { ok: false; reason: string }
  >
}

type Vars = { auth: AuthContext }

const err = (code: ErrorCode, hint?: string) => ({
  code, message: ERROR_CODES[code], ...(hint ? { hint } : {}),
})

/** §10 — IP yalnizca hash'lenerek saklanir, ham hali hicbir yere yazilmaz. */
const hashIp = (ip: string | undefined, salt: string): string | null =>
  ip ? createHash('sha256').update(salt).update(ip).digest('hex').slice(0, 32) : null

/** Kampanyanin disariya gorunen sekli. Ic alanlar sizmaz. */
const toCampaignJson = (c: import('../ads/selector.js').Campaign) => ({
  id: c.id,
  brand: c.creative.brand,
  text: c.creative.text,
  cta: c.creative.cta,
  bidCpmStroops: c.bidCpm.toString(),
  status: c.status,
  // Onizleme: reklamverenin gorecegi satir, kullanicinin gordugunun aynisi.
  preview: `✶ ${c.creative.brand} — ${c.creative.text} · ${c.creative.cta ?? ''}`,
})

export function createApp(deps: AppDeps) {
  const app = new Hono<{ Variables: Vars }>()

  app.use('*', async (c, next) => {
    c.header(PROTOCOL_HEADER, PROTOCOL_VERSION)
    await next()
  })

  /* ─────────────────── yetki ─────────────────── */

  const requireScope = (...needed: TokenScope[]) =>
    async (c: any, next: any) => {
      const raw = bearerToken(c.req.header('authorization'))
      if (!raw) return c.json(err('DWL_2001', '`dwell login` calistir'), 401)

      const rec = deps.tokens.find(raw)
      if (!rec || rec.revokedAt !== null) {
        return c.json(err('DWL_2002', 'Token iptal edilmis veya gecersiz'), 401)
      }

      // Kapsam kontrolu. Daemon token'i cuzdan degistiremez.
      const missing = needed.filter((s) => !rec.scopes.includes(s))
      if (missing.length > 0) {
        return c.json(err('DWL_2003', `gerekli kapsam: ${missing.join(', ')}`), 403)
      }

      const version = c.req.header('x-dwell-client-version') ?? null
      deps.tokens.touch(rec.id, deps.clock.now(), version)
      c.set('auth', { publisherId: rec.publisherId, tokenId: rec.id, scopes: rec.scopes })
      await next()
    }

  /**
   * ADR-016 — surum kapisi.
   *
   * Kill switch (ADR-008) toptan kapatir; bu SECICI kapatir. Olcum veya odeme
   * protokolunde bir hata bulunursa yalnizca hatali surumleri devre disi
   * birakabilmek gerekir.
   */
  const requireVersion = async (c: any, next: any) => {
    const v = c.req.header('x-dwell-client-version')
    const min = deps.config().minClientVersion
    if (v && compareVersions(v, min) < 0) {
      return c.json(err('DWL_1005', `en az ${min} gerekli, guncelle: npm i -g dwell`), 426)
    }
    await next()
  }

  /* ─────────────────── uclar ─────────────────── */

  /**
   * Remote config. Yetki İSTEMEZ — kill switch'in ulasabilmesi icin.
   * Token'i bozulmus bir istemcinin de susturulabilmesi gerekiyor.
   */
  app.get('/v1/config', (c) => c.json(remoteConfigSchema.parse(deps.config())))

  /**
   * Saglik kontrolu — Railway ve benzeri platformlar bunu cagirir.
   *
   * Yetki ISTEMEZ ve istememeli: platformun elinde token yok. Icerde ne
   * oldugunu da SIZDIRMAZ — kampanya sayisi, bakiye, kullanici sayisi gibi
   * seyler kimlik dogrulamasi olmayan bir uctan disari cikmaz.
   */
  app.get('/health', (c) => c.json({ ok: true, version: PROTOCOL_VERSION }))

  /* ─────────────────── cuzdanla giris ─────────────────── */

  /**
   * ADR-010 (revize) — kimlik cuzdandir.
   *
   * Bu iki uc YETKI ISTEMEZ; yetkinin kendisi burada uretiliyor. Guvenlik
   * imzadan gelir: kullanici challenge'i yalnizca ozel anahtariyla
   * imzalayabilir, biz de o anahtari hicbir zaman gormeyiz.
   */
  if (deps.walletAuth) {
    const wa = deps.walletAuth

    app.post('/v1/auth/challenge', async (c) => {
      const body = await c.req.json().catch(() => null)
      const address = typeof body?.address === 'string' ? body.address.trim() : ''

      const r = wa.challenge(address)
      if (!r.ok) return c.json(err('DWL_4001', r.reason), 400)

      return c.json({
        transaction: r.xdr,                       // SEP-10 alan adi: `transaction`
        network_passphrase: r.networkPassphrase,
        expiresAt: r.expiresAt,
      })
    })

    app.post('/v1/auth/verify', async (c) => {
      const body = await c.req.json().catch(() => null)
      const address = typeof body?.address === 'string' ? body.address.trim() : ''
      const signed = typeof body?.transaction === 'string' ? body.transaction : ''
      if (!address || !signed) {
        return c.json(err('DWL_9001', '`address` ve `transaction` gerekli'), 400)
      }

      // Rol token'in kapsamini belirliyor. Bilinmeyen deger yayinci sayilir
      // — sessizce reklamveren yetkisi vermek yanlis tarafta hata olurdu.
      const role = body?.role === 'advertiser' ? 'advertiser' : 'publisher'
      const r = await wa.verify(address, signed, role)
      // 401: imza gecerli degil. Bu bir sunucu hatasi degil, kimlik reddi.
      if (!r.ok) return c.json(err('DWL_2002', r.detail ? `${r.reason}: ${r.detail}` : r.reason), 401)

      // Ham token YALNIZCA burada gorunur. Tekrar okunamaz — kaybedilirse
      // yeniden giris yapilir. Sunucuda yalnizca hash'i var.
      return c.json({ token: r.token, tokenId: r.tokenId, publisherId: r.publisherId, role })
    })
  }

  /**
   * Kullanicinin cuzdanina USDC kabulu ekleyecek IMZASIZ islemi kurar.
   *
   * Neden sunucuda: bunu tarayicida kurmak Stellar SDK'sini indirmek demek
   * (~1 MB) ve tek ihtiyacimiz bir `changeTrust` operasyonu. Sunucu kuruyor,
   * kullanici Freighter'da imzaliyor, tarayici dogrudan Horizon'a gonderiyor.
   *
   * Yetki ISTEMEZ ve gerekmiyor: islem kullanicinin KENDI hesabinda, kendi
   * imzasiyla gecerli oluyor. Biz yalnizca zarfi hazirliyoruz.
   */
  app.post('/v1/wallet/trustline-xdr', async (c) => {
    if (!deps.trustlineXdr) return c.json(err('DWL_9001', 'kapali'), 404)
    const body = await c.req.json().catch(() => null)
    const address = typeof body?.address === 'string' ? body.address.trim() : ''

    const r = await deps.trustlineXdr(address)
    if (!r.ok) return c.json(err('DWL_4001', r.reason), 400)
    return c.json({ xdr: r.xdr, network_passphrase: r.networkPassphrase })
  })

  app.post('/v1/ads/next', requireVersion, requireScope('report:impressions'), (c) => {
    const { publisherId } = c.get('auth')

    if (!deps.config().renderEnabled) {
      return c.json(err('DWL_3005'), 503)
    }

    const sel = deps.pipeline.serveAd(publisherId)
    // Kampanya yoksa 404 degil 204: bu bir hata degil, "su an gosterecek bir
    // sey yok" durumu. Istemci sessizce hicbir sey basmaz.
    if (!sel) return c.body(null, 204)

    return c.json({
      campaignId: sel.campaign.id,
      nonce: sel.nonce,
      nonceExpiresAt: sel.nonceExpiresAt,
      creative: sel.campaign.creative,
      // DIKKAT: `rate` BURADA YOK ve olmayacak (ADR-011). Fiyat sunucu
      // tarafinda dondurulur; istemciye gondermek hem gereksiz hem
      // manipulasyon yuzeyi.
    })
  })

  app.post('/v1/impressions', requireVersion, requireScope('report:impressions'), async (c) => {
    const { publisherId } = c.get('auth')

    const body = await c.req.json().catch(() => null)
    const parsed = impressionBatchSchema.safeParse(body)
    if (!parsed.success) {
      return c.json(err('DWL_9001', parsed.error.issues[0]?.message ?? 'gecersiz govde'), 400)
    }

    const ipHash = hashIp(
      c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? c.req.header('x-real-ip'),
      deps.ipSalt,
    )

    const result = deps.pipeline.ingest.ingest(publisherId, parsed.data.events, { ipHash })

    // Kismi basari 200 doner: istemci hangi ID'lerin kabul edildigini bilir
    // ve yalnizca onlari kuyrugundan siler. Toptan hata donmek, iyi kayitlari
    // da yeniden gondermeye zorlardi.
    return c.json({
      accepted: result.accepted,
      rejected: result.rejected.map((r) => ({ id: r.id, reason: r.reason })),
      duplicates: result.duplicates,
    })
  })

  app.get('/v1/me/balance', requireScope('read:balance'), (c) => {
    const { publisherId } = c.get('auth')
    const pubAcc = accountId('publisher', publisherId)
    const payable = deps.ledger.balance(pubAcc)
    const inFlight = deps.ledger.balance(accountId('payouts_in_flight'))

    // Bekleyen: henuz dogrulanmamis gosterimlerin degeri. Ledger'da YOK,
    // cunku dogrulanana kadar para degil.
    let pending = 0n
    for (const i of deps.pipeline.impressions()) {
      if (i.publisherId === publisherId && i.state === 'pending') {
        pending += (BigInt(i.rateStroops) * BigInt(i.revShareBps)) / 10_000n
      }
    }

    return c.json({
      pendingStroops: pending.toString(),
      payableStroops: payable.toString(),
      inFlightStroops: inFlight.toString(),
      lifetimeStroops: payable.toString(),
      payoutThresholdStroops: deps.payoutThreshold.toString(),
      // Odeme gecmisi kayittan. "Param nerede" sorusunun cevabi burada:
      // her kalem bir islem hash'i tasir, kullanici zincirde dogrulayabilir.
      recentPayouts: (deps.payouts?.forPublisher(publisherId, 10) ?? []).map((p) => ({
        txHash: p.txHash,
        amountStroops: p.amount.toString(),
        at: p.submittedAt,
        state: p.state,
        // Adres SNAPSHOT — o an nereye gonderildigi. Guncel cuzdan DEGIL.
        destination: p.destinationAddress,
      })),
      // Odeme neden bloke — kullaniciya sebep gosterilmek zorunda (§6.5).
      blockedReason: payable < deps.payoutThreshold
        ? `esik ${deps.payoutThreshold} stroop, bakiye ${payable}`
        : null,
    })
  })

  /* ─────────────────── reklamveren ─────────────────── */

  /**
   * Reklamveren de CUZDANLA giris yapiyor — yayincilarla ayni SEP-10 akisi,
   * farkli kapsamlar. `advertiserId` adresin kendisi (ADR-010).
   *
   * Kapsam ayrimi onemli: calinmis bir daemon token'i kampanya olusturup
   * baskasinin butcesini harcayamaz.
   */
  if (deps.campaigns) {
    const store = deps.campaigns

    /** Reklamverenin ozeti: bakiye, para yatirma bilgisi, kampanyalar. */
    app.get('/v1/advertiser/me', requireScope('read:spend'), (c) => {
      const { publisherId: advertiserId } = c.get('auth')
      const bakiye = deps.ledger.balance(accountId('advertiser', advertiserId))

      return c.json({
        advertiserId,
        balanceStroops: bakiye.toString(),
        // Rezerve: teslim edilmis ama henuz raporlanmamis reklamlar + bekleyen
        // gosterimler. Reklamveren "param var ama harcayamiyorum" dedigi anda
        // cevabi bu.
        spendableStroops: deps.pipeline.spendable(advertiserId).toString(),
        deposit: deps.depositAddress
          ? {
              address: deps.depositAddress,
              assetCode: deps.assetCode ?? 'USDC',
              assetIssuer: deps.assetIssuer ?? null,
              // KRITIK: para KENDI cuzdanindan gelmeli. Eslesme gonderen
              // adrese gore yapiliyor; borsadan gonderilen para sahipsiz kalir.
              note: `Yalnizca ${advertiserId} adresinden gonderilen odemeler hesabina yazilir`,
            }
          : null,
        campaigns: store.forAdvertiser(advertiserId).map(toCampaignJson),
      })
    })

    app.post('/v1/advertiser/campaigns', requireScope('manage:campaigns'), async (c) => {
      const { publisherId: advertiserId } = c.get('auth')
      const body = await c.req.json().catch(() => null)

      const bid = typeof body?.bidCpmStroops === 'string' ? body.bidCpmStroops : null
      if (bid === null || !/^\d+$/.test(bid)) {
        return c.json(err('DWL_9001', '`bidCpmStroops` tam sayi metni olmali'), 400)
      }

      const r = store.create({
        advertiserId,
        brand: String(body?.brand ?? ''),
        text: String(body?.text ?? ''),
        cta: String(body?.cta ?? ''),
        bidCpm: stroops(BigInt(bid)),
      })
      // Red sebebi ALANIYLA birlikte donuyor: form hangi kutuyu
      // kirmizi yapacagini bilsin.
      if (!r.ok) return c.json({ ...err('DWL_9001', r.reason), field: r.field }, 400)

      return c.json(toCampaignJson(r.campaign), 201)
    })

    app.post('/v1/advertiser/campaigns/:id/status', requireScope('manage:campaigns'), async (c) => {
      const { publisherId: advertiserId } = c.get('auth')
      const body = await c.req.json().catch(() => null)
      const durum = body?.status

      if (durum !== 'active' && durum !== 'paused') {
        return c.json(err('DWL_9001', '`status` yalnizca active veya paused olabilir'), 400)
      }

      // Yayina almadan once para kontrolu. Bos butceyle "aktif" gorunen bir
      // kampanya, reklamvereni hicbir sey olmadigini anlamadan bekletir.
      if (durum === 'active') {
        const spendable = deps.pipeline.spendable(advertiserId)
        if (spendable <= 0n) {
          return c.json(err('DWL_3004', 'bakiye yok — once para yatir'), 402)
        }
      }

      const r = store.setStatus(c.req.param('id'), advertiserId, durum)
      if (!r.ok) return c.json(err('DWL_9001', r.reason), 404)
      return c.json(toCampaignJson(r.campaign))
    })
  }

  app.notFound((c) => c.json(err('DWL_9001', 'bilinmeyen uc'), 404))

  app.onError((e, c) => {
    // Stack trace ASLA disari cikmaz — istemciye kod ve tek cumle gider.
    console.error('[dwell]', e)
    return c.json(err('DWL_9001'), 500)
  })

  return app
}
