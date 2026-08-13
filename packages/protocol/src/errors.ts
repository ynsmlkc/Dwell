/**
 * Hata taksonomisi.
 *
 * Kapali bir union; yeni kod eklemek bilincli bir karardir. CLI asla stack
 * trace basmaz — kullaniciya `DWL-xxxx` kodu ve tek cumlelik aciklama gider.
 *
 * Kod araliklari:
 *   1xxx  istemci / kurulum
 *   2xxx  kimlik ve yetki
 *   3xxx  gosterim ingest
 *   4xxx  cuzdan ve adres
 *   5xxx  odeme ve ledger
 *   9xxx  sunucu / beklenmeyen
 */

export const ERROR_CODES = {
  // 1xxx — istemci
  DWL_1001: 'Daemon calismiyor',
  DWL_1002: 'Daemon soketine baglanilamadi',
  DWL_1003: 'Claude Code settings.json bulunamadi',
  DWL_1004: 'settings.json zaten baska bir statusLine iceriyor',
  DWL_1005: 'Istemci surumu cok eski — guncelleme gerekli',
  DWL_1006: 'Kurulum bozuk — `dwell doctor` calistir',

  // 2xxx — kimlik
  DWL_2001: 'Giris yapilmamis',
  DWL_2002: 'Device token gecersiz veya iptal edilmis',
  DWL_2003: 'Bu islem icin yetki yok',
  DWL_2004: 'GitHub dogrulamasi tamamlanmadi',

  // 3xxx — gosterim
  DWL_3001: 'Gosterim suresi esigin altinda',
  DWL_3002: 'Nonce gecersiz veya suresi dolmus',
  DWL_3003: 'Gosterim zaten kaydedilmis',
  DWL_3004: 'Aktif kampanya yok',
  DWL_3005: 'Render uzaktan kapatildi',

  // 4xxx — cuzdan
  DWL_4001: 'Gecersiz Stellar adresi',
  DWL_4002: 'Hesap zincirde bulunamadi veya fonlanmamis',
  DWL_4003: 'USDC trustline yok',
  DWL_4004: 'USDC trustline yetkilendirilmemis',
  DWL_4005: 'Trustline limiti yetersiz',
  DWL_4006: 'Bu adres memo gerektiriyor — borsa adresi baglanamaz',
  DWL_4007: 'Bu adres baska bir hesaba bagli',
  DWL_4008: 'Adres degisikligi bekleme suresinde',
  DWL_4009: 'Desteklenmeyen adres tipi',
  DWL_4010: 'Adres sahipligi dogrulanamadi',

  // 5xxx — odeme
  DWL_5001: 'Bakiye odeme esiginin altinda',
  DWL_5002: 'Odeme zaten islemde',
  DWL_5003: 'Odeme gonderildi ama henuz onaylanmadi',
  DWL_5004: 'Odeme basarisiz — ters kayit yazildi',
  DWL_5005: 'Kampanya butcesi yetersiz',
  DWL_5006: 'Ledger invariant ihlali',

  // 9xxx
  DWL_9001: 'Sunucu hatasi',
  DWL_9002: 'Hiz siniri asildi',
} as const

export type ErrorCode = keyof typeof ERROR_CODES

/** Tel uzerinden giden hata sekli. `v1` icinde bu sekil degismez. */
export interface ErrorEnvelope {
  readonly code: ErrorCode
  /** Kullaniciya gosterilecek tek cumle. */
  readonly message: string
  /** Kullanicinin ne yapmasi gerektigi. Varsa CLI bunu ikinci satira basar. */
  readonly hint?: string
  /** Yalnizca sunucu log'unda iz surmek icin. Kullaniciya gosterilmez. */
  readonly traceId?: string
}

export class DwellError extends Error {
  override readonly name = 'DwellError'
  readonly code: ErrorCode
  readonly hint: string | undefined
  readonly traceId: string | undefined

  constructor(code: ErrorCode, opts: { hint?: string; traceId?: string; cause?: unknown } = {}) {
    super(ERROR_CODES[code], opts.cause !== undefined ? { cause: opts.cause } : undefined)
    this.code = code
    this.hint = opts.hint
    this.traceId = opts.traceId
  }

  toEnvelope(): ErrorEnvelope {
    return {
      code: this.code,
      message: ERROR_CODES[this.code],
      ...(this.hint !== undefined ? { hint: this.hint } : {}),
      ...(this.traceId !== undefined ? { traceId: this.traceId } : {}),
    }
  }

  /** CLI ciktisi. Stack trace ASLA basilmaz. */
  toDisplayString(): string {
    return this.hint
      ? `${this.code}: ${this.message}\n  → ${this.hint}`
      : `${this.code}: ${this.message}`
  }
}

export const isErrorCode = (v: unknown): v is ErrorCode =>
  typeof v === 'string' && v in ERROR_CODES
