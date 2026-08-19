/**
 * Paket surumu — derleme aninda gomulur.
 *
 * Onceden `daemon/index.ts` icinde `const VERSION = '0.0.0'` yaziyordu ve
 * hicbir yere bagli degildi. Iki sonucu vardi:
 *
 *   • `dwell status` her surumde "0.0.0" gosteriyordu
 *   • Sunucuya giden `x-dwell-client-version` basligi da "0.0.0" idi
 *
 * Ikincisi sessiz ve tehlikeliydi: sunucudaki `minClientVersion` kapisi
 * boylece ISLEVSIZ. Bir gun eski istemcileri kesmek icin esik yukseltilse,
 * en guncel istemci de "0.0.0" bildirdigi icin HERKES kesilirdi. Kapinin
 * calismadigi ancak o gun anlasilirdi.
 *
 * Deger `build.mjs` icinde esbuild `define` ile `package.json`'dan
 * gomuluyor. `tsx` ile dogrudan kaynaktan calistirildiginda (testler,
 * gelistirme) degisken tanimsiz olur ve `dev` degerine duseriz —
 * `0.0.0` DEGIL, cunku o gercek bir surum gibi gorunup ayni sessiz
 * yanilgiyi tekrar uretirdi.
 */

declare const __DWELL_VERSION__: string | undefined

export const VERSION: string =
  typeof __DWELL_VERSION__ === 'string' ? __DWELL_VERSION__ : 'dev'
