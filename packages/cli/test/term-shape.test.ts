/**
 * Terminal parmak izi testleri — §3.
 *
 * Yanlis karar vermenin bedeli: kullanicinin ekraninda cop escape dizisi.
 * Bu yuzden siralamanin kendisi test ediliyor, yalnizca sonuc degil.
 */

import { describe, it, expect } from 'vitest'
import { termShape } from '../src/shim/term-shape.js'

const e = (v: Record<string, string>): NodeJS.ProcessEnv => v

describe('OSC 8 destegi olan terminaller', () => {
  const cases: [string, Record<string, string>][] = [
    ['Kitty', { KITTY_WINDOW_ID: '1' }],
    ['WezTerm', { WEZTERM_PANE: '0' }],
    ['iTerm2', { ITERM_SESSION_ID: 'w0t0p0' }],
    ['VS Code', { TERM_PROGRAM: 'vscode' }],
    ['Windows Terminal', { WT_SESSION: 'abc' }],
    // Onceden `plain` sayiliyordu; gozlemle duzeltildi (2026-08-19).
    ['Warp', { TERM_PROGRAM: 'WarpTerminal' }],
    ['VTE 0.50+', { VTE_VERSION: '6003' }],
  ]
  for (const [name, env] of cases) {
    it(`${name} → osc8`, () => expect(termShape(e(env))).toBe('osc8'))
  }
})

describe('OSC 8 desteklemeyen terminaller — ciplak URL', () => {
  const cases: [string, Record<string, string>][] = [
    ['Alacritty', { ALACRITTY_WINDOW_ID: '1' }],
    ['Konsole', { KONSOLE_VERSION: '220800' }],
    ['Apple Terminal', { TERM_PROGRAM: 'Apple_Terminal' }],
    ['JetBrains', { TERMINAL_EMULATOR: 'JetBrains-JediTerm' }],
    ['eski VTE', { VTE_VERSION: '4600' }],
  ]
  for (const [name, env] of cases) {
    it(`${name} → plain`, () => expect(termShape(e(env))).toBe('plain'))
  }
})

describe('siralama — yanlis sira kullanicinin ekranini bozar', () => {
  it('TMUX HER SEYIN ONUNDE', () => {
    // tmux, `allow-passthrough` olmadan OSC 8'i yutar. Ic terminal ne olursa
    // olsun onemli degil; tmux'un kendisi belirleyici.
    expect(termShape(e({ TMUX: '/tmp/tmux-501/default,123,0', KITTY_WINDOW_ID: '1' }))).toBe('plain')
    expect(termShape(e({ TMUX: 'x', ITERM_SESSION_ID: 'y', TERM_PROGRAM: 'iTerm.app' }))).toBe('plain')
  })

  it('SSH ikinci sirada — env uzakta, tiklayan terminal yerelde', () => {
    // Uzak makinedeki env yerel terminali TARIF ETMEZ. Destegi bilmek
    // imkansiz, o yuzden ikisini birden basan hybrid.
    expect(termShape(e({ SSH_TTY: '/dev/pts/0', KITTY_WINDOW_ID: '1' }))).toBe('hybrid')
    expect(termShape(e({ SSH_CONNECTION: '1.2.3.4 22', TERM_PROGRAM: 'Apple_Terminal' }))).toBe('hybrid')
  })

  it('tmux SSH\'in de onunde', () => {
    expect(termShape(e({ TMUX: 'x', SSH_TTY: '/dev/pts/0' }))).toBe('plain')
  })

  it('WT_SESSION en sonda — sizintiya acik', () => {
    // Bu degisken baska terminallerde de gorulebiliyor; ozgul bir isaret
    // varsa o kazanmali.
    expect(termShape(e({ WT_SESSION: 'x', KONSOLE_VERSION: '220800' }))).toBe('plain')
  })
})

describe('bilinmeyen ortam', () => {
  it('hicbir ipucu yoksa hybrid — hicbir durumda daha kotu degil', () => {
    expect(termShape(e({}))).toBe('hybrid')
  })

  it('ghostty hybrid', () => {
    expect(termShape(e({ GHOSTTY_RESOURCES_DIR: '/x' }))).toBe('hybrid')
    expect(termShape(e({ TERM_PROGRAM: 'ghostty' }))).toBe('hybrid')
  })

  it('Windows plain', () => {
    expect(termShape(e({ OS: 'Windows_NT' }))).toBe('plain')
  })
})
