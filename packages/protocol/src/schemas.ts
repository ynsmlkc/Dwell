/**
 * Tel uzerindeki sekiller — istemci ve sunucunun paylastigi tek kaynak.
 *
 * UYUMLULUK KURALI (§12.0 / ADR-016):
 *   `v1` icinde semalar yalnizca **additive** degisir. Alan silmek, yeniden
 *   adlandirmak veya tipini daraltmak breaking'dir ve `v2` gerektirir.
 *
 *   Istemci bilinmeyen alanlari **yok sayar** (`.passthrough()` degil, sessiz
 *   strip — zod varsayilani). Boylece sunucu alan ekledigi gun eski
 *   istemciler kirilmaz. Sunucu ise gelen fazlalik alanlari reddeder.
 */

import { z } from 'zod'
import { ULID_LENGTH } from './clock.js'

/* ─────────────────────────── ortak ─────────────────────────── */

export const ulidSchema = z.string().length(ULID_LENGTH).regex(/^[0-9A-HJKMNP-TV-Z]+$/)
export const semverSchema = z.string().regex(/^\d+\.\d+\.\d+(-[\w.]+)?$/)

/** Ham `cwd` ASLA gonderilmez — ADR-013. Yerel tuzla turetilmis HMAC gider. */
export const projectKeySchema = z.string().length(64).regex(/^[0-9a-f]+$/)

/* ─────────────────────────── reklam ─────────────────────────── */

/**
 * Reklamverenin gonderebildigi tek sey: anlamsal alanlar.
 * Stil alani YOK ve eklenmeyecek — stili biz uretiriz (ADR-007).
 */
export const creativeSchema = z.object({
  brand: z.string().min(1).max(40),
  text: z.string().min(1).max(120),
  cta: z.string().max(60).optional(),
})

export const adPayloadSchema = z.object({
  campaignId: z.string().min(1),
  /** Her teslimatta uretilir; gosterim raporu bunu geri getirmek zorunda. */
  nonce: z.string().length(32),
  /** Nonce'un son kullanma zamani (epoch ms). */
  nonceExpiresAt: z.number().int().positive(),
  creative: creativeSchema,
})

/**
 * DIKKAT: `rate` burada YOK ve olmayacak.
 * Fiyat sunucu tarafinda, gosterim dogrulandiginda dondurulur (ADR-011).
 * Istemciye fiyat gondermek hem gereksiz hem de manipulasyon yuzeyi.
 */

/* ─────────────────────────── gosterim ─────────────────────────── */

/** Reklamin gosterildigi yuzey. Faturalama yalnizca olculebilir olanlardan. */
export const surfaceSchema = z.enum(['statusline', 'spinner_verb', 'spinner_tip'])
export type Surface = z.infer<typeof surfaceSchema>

/** ADR-001: yalnizca bu yuzey gosterim sayabilir. */
export const MEASURABLE_SURFACES: readonly Surface[] = ['statusline']
export const isMeasurable = (s: Surface): boolean => MEASURABLE_SURFACES.includes(s)

/**
 * Gosterim raporu. Alanlar §10'daki listeyle **birebir** ayni olmak zorunda;
 * buraya alan eklemek `dwell privacy` ciktisini da degistirmeyi gerektirir.
 */
export const impressionEventSchema = z.object({
  /** Istemci uretimi ULID — idempotent ingest. Dusman girdisidir. */
  id: ulidSchema,
  campaignId: z.string().min(1),
  nonce: z.string().length(32),
  /** Oturuma ozel rastgele kimlik. Kullanici kimligi degil. */
  sessionId: z.string().min(1).max(128),
  surface: surfaceSchema,
  durationMs: z.number().int().nonnegative().max(24 * 60 * 60 * 1000),
  clientTs: z.number().int().positive(),
  projectKey: projectKeySchema,
  clientVersion: semverSchema,
  os: z.enum(['darwin', 'linux', 'win32']),
  arch: z.string().max(16),
})

export const impressionBatchSchema = z.object({
  events: z.array(impressionEventSchema).min(1).max(500),
})

export const impressionAckSchema = z.object({
  accepted: z.array(ulidSchema),
  rejected: z.array(z.object({ id: ulidSchema, reason: z.string() })),
})

/* ─────────────────────────── remote config ─────────────────────────── */

/**
 * ADR-008 + ADR-016 + ADR-020.
 *
 * `renderEnabled`, `minClientVersion` ve `surfaces` ILK SURUMDE bulunmak
 * zorunda: eski istemciler bilmedikleri alani okumaz, dolayisiyla sonradan
 * eklenen bir kill switch eski istemcilere ulasmaz.
 */
export const remoteConfigSchema = z.object({
  /** Toptan kill switch. false → tum yuzeylerde render aninda durur. */
  renderEnabled: z.boolean(),
  /** Yuzey bazli kill switch — biri bozulursa digerleri ayakta kalir. */
  surfaces: z.object({
    statusline: z.boolean(),
    spinnerVerb: z.boolean(),
    spinnerTip: z.boolean(),
  }),
  /** Bunun altindaki istemciler render'i durdurur; sunucu da reddeder. */
  minClientVersion: semverSchema,
  /** Nitelikli gosterim esigi. Olcum: turlarin %50'si bunu geciyor (§12.2). */
  minImpressionMs: z.number().int().positive(),
  /**
   * Tur icinde reklam rotasyon araligi — ADR-022.
   * `minImpressionMs`'den kucuk OLAMAZ; aksi halde hicbir reklam nitelikli
   * sureyi dolduramaz. Bu kisit asagida `.refine()` ile zorlaniyor.
   */
  rotateMs: z.number().int().min(5_000).max(300_000),
  /**
   * Tur bittikten sonra reklamin ekranda kalma suresi — ADR-023.
   * Sifir yapmak reklami arka arkaya kisa turlarda yanip sondurur; bu,
   * surekli gostermekten daha rahatsiz edicidir.
   */
  idleGraceMs: z.number().int().min(0).max(30_000),
  /** statusLine `refreshInterval` degeri (saniye, min 1). */
  refreshIntervalSec: z.number().int().min(1).max(60),
  /** Config yeniden cekilme araligi. */
  configPollSec: z.number().int().min(30),
  /** Kuyruk gonderim araligi. */
  reportIntervalSec: z.number().int().min(10),
}).refine((c) => c.rotateMs >= c.minImpressionMs, {
  message: 'rotateMs >= minImpressionMs olmali — aksi halde hicbir reklam nitelikli sureyi dolduramaz (ADR-022)',
  path: ['rotateMs'],
})

export type RemoteConfig = z.infer<typeof remoteConfigSchema>

/** Sunucuya hic ulasilamadiginda kullanilan guvenli varsayilan. */
export const FALLBACK_CONFIG: RemoteConfig = {
  renderEnabled: false,          // ulasilamiyorsa GOSTERME — sessiz kalmak dogru varsayilan
  surfaces: { statusline: false, spinnerVerb: false, spinnerTip: false },
  minClientVersion: '0.0.0',
  minImpressionMs: 10_000,
  rotateMs: 20_000,
  idleGraceMs: 4_000,
  refreshIntervalSec: 1,
  configPollSec: 300,
  reportIntervalSec: 60,
}

/* ─────────────────────────── auth ─────────────────────────── */

/**
 * Token yetki kapsami — ADR-014 / §12.0.
 *
 * `min_client_version` ile ayni argüman: **ilk surumde bulunmak zorunda.**
 * Sonradan eklenirse eski token'lar kapsamsiz olur ve "kapsami olmayan token
 * her seyi yapabilir" varsayimina dusmek zorunda kalirsin.
 *
 * Daemon yalnizca `report:impressions` tasir. Cuzdan degistirmek `wallet:write`
 * ister ve o da taze bir interaktif girisle verilir — calinmis bir daemon
 * token'i cuzdani degistiremesin.
 */
export const tokenScopeSchema = z.enum([
  'report:impressions',
  'read:balance',
  'wallet:write',
  'devices:manage',
  // Reklamveren tarafi. Yayinci token'i bunlari ASLA tasimaz: calinmis bir
  // daemon token'i kampanya olusturup baskasinin parasini harcayamamali.
  'manage:campaigns',
  'read:spend',
])
export type TokenScope = z.infer<typeof tokenScopeSchema>

export const DAEMON_SCOPES: readonly TokenScope[] = ['report:impressions', 'read:balance']
export const ADVERTISER_SCOPES: readonly TokenScope[] = ['manage:campaigns', 'read:spend']

export const deviceTokenSchema = z.object({
  token: z.string().min(32),
  tokenId: z.string().min(1),
  scopes: z.array(tokenScopeSchema).min(1),
  expiresAt: z.number().int().positive().nullable(),
})

export const authStartSchema = z.object({
  deviceCode: z.string().min(1),
  userCode: z.string().min(1),
  verificationUri: z.string().url(),
  intervalSec: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
})

/* ─────────────────────────── cuzdan ─────────────────────────── */

/** ADR-020: yalnizca `G...`. `M...` ve `C...` simdilik reddediliyor. */
export const stellarAddressSchema = z.string()
  .length(56)
  .regex(/^G[A-Z2-7]{55}$/, 'yalnizca G ile baslayan Stellar adresi kabul ediliyor')

/** Kolon genisligi notu: DB'de en az varchar(69) — muxed adres 69 karakter. */
export const ADDRESS_COLUMN_WIDTH = 69

export const walletStatusSchema = z.object({
  address: stellarAddressSchema.nullable(),
  verifiedAt: z.number().int().positive().nullable(),
  network: z.enum(['testnet', 'pubnet']),
  trustline: z.enum(['unknown', 'ok', 'missing', 'unauthorized', 'full']),
  trustlineCheckedAt: z.number().int().positive().nullable(),
  /** Adres degisikligi bekleme suresi bitis zamani (ADR-014). */
  holdUntil: z.number().int().positive().nullable(),
})

/* ─────────────────────────── bakiye ─────────────────────────── */

/** Tutarlar tel uzerinde **string** olarak tasinir — JSON'da bigint yok. */
const stroopsString = z.string().regex(/^-?\d+$/)

export const balanceSchema = z.object({
  pendingStroops: stroopsString,
  payableStroops: stroopsString,
  inFlightStroops: stroopsString,
  lifetimeStroops: stroopsString,
  payoutThresholdStroops: stroopsString,
  recentPayouts: z.array(z.object({
    txHash: z.string().length(64),
    amountStroops: stroopsString,
    settledAt: z.number().int().positive(),
    explorerUrl: z.string().url(),
  })),
  /** Odeme neden bloke? Kullaniciya sebep gosterilmek zorunda. */
  blockedReason: z.string().nullable(),
})

export type AdPayload = z.infer<typeof adPayloadSchema>
export type Creative = z.infer<typeof creativeSchema>
export type ImpressionEvent = z.infer<typeof impressionEventSchema>
export type DeviceToken = z.infer<typeof deviceTokenSchema>
export type WalletStatus = z.infer<typeof walletStatusSchema>
export type Balance = z.infer<typeof balanceSchema>
