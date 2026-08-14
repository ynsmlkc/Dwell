/**
 * Testler DERLENMIS shim'i kullanir, TypeScript kaynagini degil.
 *
 * Iki sebep:
 *   1. Dagitimda giden sey derlenmis surum (ADR-003 olcumu) — test ettigimiz
 *      sey gonderdigimiz sey olmali.
 *   2. Node'un tip siyirma modu `.js` importlarini `.ts`'e cozemiyor; shim
 *      bir modul import ettigi anda kaynaktan calistirilamiyor.
 */
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export default function setup(): void {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  execFileSync(process.execPath, [join(root, 'build.mjs')], { cwd: root, stdio: 'ignore' })
}
