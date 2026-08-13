/**
 * @dwell/protocol — istemci ve sunucunun paylastigi tek gercek kaynagi.
 *
 * Bu paket ag erisimi yapmaz, dosya okumaz, `Date.now()` cagirmaz.
 * Saf tipler, semalar ve saf fonksiyonlar.
 */

export const PROTOCOL_VERSION = 'v1'
export const PROTOCOL_HEADER = 'X-Dwell-Protocol-Version'

export * from './money.js'
export * from './clock.js'
export * from './errors.js'
export * from './schemas.js'
export * from './sanitize.js'
