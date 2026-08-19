/**
 * Surum bildirimi.
 *
 * Gercekte yasandi: `VERSION` elle yazilmis `'0.0.0'` sabitiydi ve
 * `package.json` ile bagi yoktu. Gorunen zarari `dwell status`in yanlis
 * surum yazmasiydi; asil zarari sessizdi — ayni deger sunucuya
 * `x-dwell-client-version` olarak gidiyordu, yani sunucudaki
 * `minClientVersion` kapisi ISLEVSIZDI. Esik bir gun yukseltilse en guncel
 * istemci de "0.0.0" bildirdigi icin herkes kesilirdi.
 *
 * Gercek deger derleme aninda gomuluyor. Kaynaktan calistirmada (`tsx`,
 * testler) `dev` olur — `0.0.0` DEGIL, cunku o gercek bir surum gibi
 * gorunup ayni yanilgiyi uretirdi.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { VERSION } from '../src/version.js'

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as { version: string }

const build = readFileSync(fileURLToPath(new URL('../build.mjs', import.meta.url)), 'utf8')

describe('surum', () => {
  it('kaynaktan calistirmada gercek surum gibi gorunmez', () => {
    expect(VERSION).toBe('dev')
    expect(VERSION).not.toBe('0.0.0')
  })

  it('derleme surumu package.json`dan gomuyor', () => {
    expect(build).toContain('__DWELL_VERSION__')
    expect(build).toMatch(/package\.json/)
  })

  it('elle yazilmis surum sabiti KALMADI', () => {
    const daemon = readFileSync(
      fileURLToPath(new URL('../src/daemon/index.ts', import.meta.url)), 'utf8',
    )
    expect(daemon).not.toMatch(/VERSION\s*=\s*['"]\d+\.\d+\.\d+['"]/)
  })

  it('package.json surumu semver', () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/)
  })
})
