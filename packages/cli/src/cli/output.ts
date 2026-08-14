/**
 * CLI ciktisi.
 *
 * Kural (ADR-016 / hata taksonomisi): kullaniciya ASLA stack trace basilmaz.
 * Hata = `DWL-xxxx` kodu + tek cumle + ne yapmasi gerektigi.
 */

const isTty = process.stdout.isTTY === true
const noColor = process.env['NO_COLOR'] !== undefined || !isTty

const c = (code: string) => (s: string) => (noColor ? s : `\x1B[${code}m${s}\x1B[0m`)

export const dim = c('2')
export const bold = c('1')
export const green = c('32')
export const yellow = c('33')
export const red = c('31')
export const orange = c('38;5;208')

export const out = (s = ''): void => { process.stdout.write(s + '\n') }
export const errOut = (s = ''): void => { process.stderr.write(s + '\n') }

export const ok = (s: string): void => out(`${green('✓')} ${s}`)
export const warn = (s: string): void => out(`${yellow('!')} ${s}`)
export const info = (s: string): void => out(`  ${s}`)

/** Hata cikisi — kod, cumle, ipucu. Stack YOK. */
export function fail(code: string, message: string, hint?: string): never {
  errOut(`${red('✗')} ${bold(code)}  ${message}`)
  if (hint) errOut(`  ${dim('→')} ${hint}`)
  process.exit(1)
}

/** Iki sutunlu hizali liste. */
export function rows(pairs: readonly (readonly [string, string])[]): void {
  const w = Math.max(...pairs.map(([k]) => k.length))
  for (const [k, v] of pairs) out(`  ${dim(k.padEnd(w))}  ${v}`)
}

/** stroop → okunabilir USDC. */
export function usdc(stroops: bigint | string): string {
  const v = typeof stroops === 'string' ? BigInt(stroops) : stroops
  const neg = v < 0n
  const abs = neg ? -v : v
  const whole = abs / 10_000_000n
  const frac = (abs % 10_000_000n).toString().padStart(7, '0').replace(/0+$/, '')
  return `${neg ? '-' : ''}$${whole}${frac ? '.' + frac : ''}`
}

export const banner = (): void => {
  out()
  out(`  ${orange('✶')} ${bold('Dwell')}`)
  out()
}
