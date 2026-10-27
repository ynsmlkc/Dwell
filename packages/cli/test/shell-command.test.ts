/**
 * `settings.json`'a yazilan komut satiri.
 *
 * Claude Code Windows'ta komutlari Git Bash ile calistirir. Ters bolu orada
 * kacis karakteri, "Program Files" ise bosluktan bolunur — ikisi de shim'in
 * hic calismamasi demek.
 */

import { describe, it, expect } from 'vitest'
import { shellCommand } from '../src/settings.js'

describe('shellCommand', () => {
  it('bosluksuz unix yolu ESKISIYLE birebir ayni kalir', () => {
    expect(shellCommand(['/usr/local/bin/node', '/a/dist/hook.mjs'], 'darwin'))
      .toBe('/usr/local/bin/node /a/dist/hook.mjs')
  })

  it('Windows: ters bolu ileri boluye doner, bosluklu parca tirnaklanir', () => {
    expect(shellCommand([
      'C:\\Program Files\\nodejs\\node.exe',
      'C:\\Users\\90542\\AppData\\Roaming\\npm\\node_modules\\dwellsh\\dist\\hook.mjs',
    ], 'win32')).toBe(
      '"C:/Program Files/nodejs/node.exe" C:/Users/90542/AppData/Roaming/npm/node_modules/dwellsh/dist/hook.mjs',
    )
  })

  it('unix\'te de bosluklu yol tirnaklanir', () => {
    expect(shellCommand(['/Users/Ali Veli/.nvm/node', '/x/s.mjs'], 'linux'))
      .toBe('"/Users/Ali Veli/.nvm/node" /x/s.mjs')
  })
})
