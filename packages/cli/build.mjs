/**
 * Derleme.
 *
 * Neden bundler: shim'in HIZLI olmasi gerekiyor (gunde ~13.700 cagri,
 * calisma aninda tip siyirmak maliyeti ikiye katliyor — ADR-003 olcumu).
 * Daemon icin hiz onemsiz (bir kez baslar) ama cok dosyayi birlestirmek
 * gerekiyor; Node'un tip siyirma modu `.js` importlarini `.ts`'e cozemiyor.
 */
import { build } from 'esbuild'
import { chmodSync } from 'node:fs'

const targets = [
  { in: 'src/shim/statusline.ts', out: 'dist/statusline.mjs' },
  { in: 'src/shim/hook.ts', out: 'dist/hook.mjs' },
  { in: 'src/daemon/entry.ts', out: 'dist/daemon.mjs' },
  { in: 'src/cli/main.ts', out: 'dist/dwell.mjs' },
]

for (const t of targets) {
  await build({
    entryPoints: [t.in],
    outfile: t.out,
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    // Shim'in kucuk kalmasi onemli: her cagrida parse ediliyor.
    minify: t.out.includes('statusline') || t.out.includes('hook'),
    // Banner EKLEMIYORUZ: kaynak dosyalarda zaten shebang var ve esbuild
    // onu koruyor. Banner eklemek ikincisini uretip dosyayi bozuyor.
  })
  chmodSync(t.out, 0o755)
}

const { statSync } = await import('node:fs')
for (const t of targets) {
  console.log(`  ${t.out.padEnd(22)} ${(statSync(t.out).size / 1024).toFixed(1)} KB`)
}
