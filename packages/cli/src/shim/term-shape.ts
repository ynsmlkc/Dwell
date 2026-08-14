/**
 * Terminal yetenegi parmak izi — OSC 8 (tiklanabilir link) icin.
 *
 * NEDEN SHIM'DE: terminalin kimligi yalnizca shim'in env'inde var. Shim
 * terminalin ICINDE calisir; daemon calismaz. Daemon OSC 8 basip
 * basmayacagina karar veremez — bastigi anda tmux altindaki bir kullanici
 * ekranda cop gorur.
 *
 * Bu yuzden shim yalnizca "hangi sekil" bilgisini uretir ve tick payload'ina
 * koyar; satiri kurma karari daemon'da kalir.
 *
 * MALIYET: saf env okumasi, olculebilir maliyeti yok. Shim'in 200 ms
 * butcesine dokunmaz (ADR-003).
 *
 * ⚠ AKTIF TTY SORGUSU YASAK. Terminal yetenegini `XTVERSION` / `DA` gibi
 * escape sorgulariyla ogrenmek cazip ama YAPILAMAZ: cevap TTY'nin input
 * stream'ine duser ve orayi Claude Code'un TUI'si okuyor. Kullanicinin
 * terminaline cop enjekte edersin. Yalnizca PASIF env okumasi.
 */

export type TermShape =
  /** Temiz hyperlink — terminal OSC 8 destekliyor. */
  | 'osc8'
  /** Metin + ciplak URL; terminal URL'i kendi algilar. */
  | 'plain'
  /** Ikisi birden — hicbir durumda daha kotu degil. */
  | 'hybrid'

/**
 * Siralamanin kendisi bir karar.
 *
 *   1. TMUX EN BASTA — dis terminal ne olursa olsun, tmux `allow-passthrough`
 *      olmadan OSC 8'i yutar. Ic terminale bakmak yaniltir.
 *   2. SSH sonra — env UZAKTA, tiklayan terminal YERELDE. Yerel terminalin
 *      destegini bilmek imkansiz, o yuzden hybrid.
 *   3. Terminale ozgu degiskenler.
 *   4. `WT_SESSION` en sonda — sizintiya acik, baska terminallerde de gorulur.
 */
export function termShape(env: NodeJS.ProcessEnv = process.env): TermShape {
  if (env['TMUX']) return 'plain'
  if (env['SSH_TTY'] || env['SSH_CONNECTION']) return 'hybrid'

  if (env['KITTY_WINDOW_ID']) return 'osc8'
  if (env['WEZTERM_PANE']) return 'osc8'
  if (env['ITERM_SESSION_ID']) return 'osc8'
  if (env['ALACRITTY_SOCKET'] || env['ALACRITTY_WINDOW_ID']) return 'plain'
  if (env['KONSOLE_VERSION']) return 'plain'
  if (env['GHOSTTY_RESOURCES_DIR']) return 'hybrid'

  // VTE 0.50+ (GNOME Terminal, Tilix…) OSC 8 destekliyor.
  const vte = Number.parseInt(env['VTE_VERSION'] ?? '', 10)
  if (Number.isFinite(vte)) return vte >= 5000 ? 'osc8' : 'plain'

  if ((env['TERMINAL_EMULATOR'] ?? '').includes('JediTerm')) return 'plain'

  switch (env['TERM_PROGRAM']) {
    case 'vscode':
    case 'iTerm.app':
    case 'WezTerm': return 'osc8'
    case 'Apple_Terminal':
    case 'WarpTerminal': return 'plain'
    case 'ghostty': return 'hybrid'
  }

  if (env['WT_SESSION']) return 'osc8'

  return env['OS'] === 'Windows_NT' || process.platform === 'win32' ? 'plain' : 'hybrid'
}
