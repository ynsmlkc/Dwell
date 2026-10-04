/**
 * `dwell profile` — siralama profilini terminalden gor ve degistir.
 *
 * `dwell login` sirasindaki istege bagli adimin terminal karsiligi: o adimi
 * atlayan ya da zaten giris yapmis olan kullanici buradan katilir.
 *
 *   dwell profile                                  durumu goster
 *   dwell profile --nickname ada --country TR --listed
 *   dwell profile --unlisted                       listeden cik
 *   dwell profile --country none                   ulkeyi gizle
 *
 * Verilmeyen alan mevcut profilden alinir. Ulke HICBIR ZAMAN sessizce
 * doldurulmaz: baglantidan tahmin edilen ulke yalnizca ONERILIR, yazilmasi
 * icin `--country` ile acikca verilmesi gerekir.
 */

import { COUNTRY_CODES } from '@dwell/protocol'
import { loadCredentials } from '../credentials.js'
import { out, ok, warn, info, fail, dim, bold, banner, rows } from './output.js'

interface Profile {
  readonly nickname: string
  readonly country: string | null
  readonly listed: boolean
}

interface ProfileResponse {
  readonly profile: Profile | null
  readonly suggestedCountry?: string | null
}

export interface ProfileArgs {
  readonly nickname?: string
  /** `null` = ulkeyi kaldir (`--country none`). */
  readonly country?: string | null
  readonly listed?: boolean
  readonly json: boolean
}

export function parseProfileArgs(argv: readonly string[]): ProfileArgs | { error: string } {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 ? argv[i + 1] : undefined
  }
  if (argv.includes('--listed') && argv.includes('--unlisted')) {
    return { error: '--listed and --unlisted together' }
  }

  const nickname = flag('nickname')
  if (argv.includes('--nickname') && (nickname === undefined || nickname.startsWith('--'))) {
    return { error: '--nickname needs a value' }
  }

  let country: string | null | undefined
  if (argv.includes('--country')) {
    const raw = flag('country')
    if (raw === undefined || raw.startsWith('--')) return { error: '--country needs a value (e.g. TR, or none)' }
    if (raw.toLowerCase() === 'none') country = null
    else {
      const c = raw.toUpperCase()
      if (!COUNTRY_CODES.has(c)) return { error: `unknown country code: ${raw} (ISO 3166-1 alpha-2, e.g. TR)` }
      country = c
    }
  }

  return {
    ...(nickname !== undefined ? { nickname } : {}),
    ...(country !== undefined ? { country } : {}),
    ...(argv.includes('--listed') ? { listed: true } : argv.includes('--unlisted') ? { listed: false } : {}),
    json: argv.includes('--json'),
  }
}

const wantsChange = (a: ProfileArgs): boolean =>
  a.nickname !== undefined || a.country !== undefined || a.listed !== undefined

export async function cmdProfile(
  argv: readonly string[] = [],
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const creds = loadCredentials()
  if (!creds) fail('DWL-2001', 'Not logged in', '`dwell login` to connect your wallet')

  const args = parseProfileArgs(argv)
  if ('error' in args) fail('DWL-9001', args.error, '`dwell profile --nickname ada --country TR --listed`')

  const call = async (method: 'GET' | 'PUT', body?: unknown): Promise<Response> => {
    try {
      return await fetchImpl(`${creds.serverUrl}/v1/me/profile`, {
        method,
        headers: { authorization: `Bearer ${creds.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15_000),
      })
    } catch (e) {
      fail('DWL-3001', 'Could not reach the server', e instanceof Error ? e.message : String(e))
    }
  }

  const res = await call('GET')
  if (res.status === 401) fail('DWL-2002', 'Token is invalid', '`dwell login --force` to reconnect')
  if (!res.ok) fail('DWL-3001', `Server error (HTTP ${res.status})`)
  const current = (await res.json()) as ProfileResponse

  if (!wantsChange(args)) {
    if (args.json) { out(JSON.stringify(current)); return }
    show(current, creds.serverUrl)
    return
  }

  const nickname = args.nickname ?? current.profile?.nickname
  if (!nickname) {
    fail('DWL-9001', 'Pick a nickname first', '`dwell profile --nickname <name> --listed`')
  }
  const next = {
    nickname,
    country: args.country !== undefined ? args.country : (current.profile?.country ?? null),
    listed: args.listed ?? current.profile?.listed ?? false,
  }

  const put = await call('PUT', next)
  const body = (await put.json().catch(() => ({}))) as { profile?: Profile; hint?: string; message?: string }
  if (put.status === 409) fail('DWL-9001', 'That nickname is taken', 'pick another one')
  if (!put.ok || !body.profile) fail('DWL-9001', body.hint ?? body.message ?? `Server error (HTTP ${put.status})`)

  if (args.json) { out(JSON.stringify(body)); return }
  ok(body.profile.listed
    ? `listed as ${bold(body.profile.nickname)}${body.profile.country ? ` · ${body.profile.country}` : ''}`
    : `profile saved — ${bold('not listed')}`)
  if (body.profile.listed) {
    info(dim('you appear within a minute once you have earnings from other advertisers'))
    info(dim(`${creds.serverUrl}/#board`))
  }
}

function show(r: ProfileResponse, serverUrl: string): void {
  banner()
  const p = r.profile
  if (!p) {
    info('not on the leaderboard')
    if (r.suggestedCountry) info(dim(`your connection looks like ${r.suggestedCountry}`))
    out()
    const c = r.suggestedCountry ? ` --country ${r.suggestedCountry}` : ''
    info(`join: ${bold(`dwell profile --nickname <name>${c} --listed`)}`)
    out()
    return
  }
  rows([
    ['nickname', bold(p.nickname)],
    ['country', p.country ?? dim('not shown')],
    ['leaderboard', p.listed ? bold('listed') : dim('not listed')],
  ])
  out()
  if (!p.listed) warn(`not visible — ${bold('dwell profile --listed')} to join`)
  else info(dim(`${serverUrl}/#board`))
  out()
}
