/**
 * Sunucu derlemesi.
 *
 * Node'un tip siyirma modu `.js` importlarini `.ts`'e cozemiyor; cok dosyali
 * bir sunucu bu yuzden kaynaktan calistirilamiyor.
 */
import { build } from 'esbuild'
import { statSync } from 'node:fs'

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/server.mjs',
  bundle: true, platform: 'node', target: 'node20', format: 'esm',
  // @dwell/protocol bir workspace paketi ve KAYNAK TypeScript. Disarida
  // birakilirsa calisma aninda .ts cozumleyemez; bundle'a katilmali.
})
console.log(`  dist/server.mjs  ${(statSync('dist/server.mjs').size / 1024).toFixed(1)} KB`)
