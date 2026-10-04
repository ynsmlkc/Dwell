/**
 * `dwell profile` — siralama profilini terminalden yonetir.
 *
 * Korunan: ulke hicbir zaman sessizce doldurulmaz, verilmeyen alanlar
 * mevcut profilden gelir, bilinmeyen ulke kodu sunucuya gitmeden reddedilir.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cmdProfile, parseProfileArgs } from '../src/cli/profile.js'
import { saveCredentials } from '../src/credentials.js'

let dir: string
let yazilan: string[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dwell-prof-'))
  process.env['DWELL_CREDENTIALS'] = join(dir, 'creds.json')
  yazilan = []
  const yakala = (s: any): boolean => { yazilan.push(String(s)); return true }
  vi.spyOn(process.stdout, 'write').mockImplementation(yakala)
  vi.spyOn(process.stderr, 'write').mockImplementation(yakala)
  saveCredentials({ serverUrl: 'https://api.test', token: 'dwl_t', publisherId: 'GADDR', tokenId: 't1', loggedInAt: 1 })
})

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env['DWELL_CREDENTIALS']
  rmSync(dir, { recursive: true, force: true })
})

const ekran = (): string => yazilan.join('')

function server(profile: unknown, suggested: string | null = 'TR') {
  const puts: any[] = []
  const impl = (async (_url: any, init: any = {}) => {
    if ((init.method ?? 'GET') === 'PUT') {
      const body = JSON.parse(String(init.body))
      puts.push(body)
      return new Response(JSON.stringify({ profile: body }), { status: 200 })
    }
    return new Response(JSON.stringify({ profile, suggestedCountry: suggested }), { status: 200 })
  }) as unknown as typeof fetch
  return { impl, puts }
}

describe('parseProfileArgs', () => {
  it('bayraklari okur, ulkeyi buyuk harfe cevirir', () => {
    expect(parseProfileArgs(['--nickname', 'ada', '--country', 'tr', '--listed'])).toEqual({ nickname: 'ada', country: 'TR', listed: true, json: false })
  })
  it('--country none ulkeyi kaldirir', () => {
    expect(parseProfileArgs(['--country', 'none'])).toMatchObject({ country: null })
  })
  it.each([
    [['--country', 'XX'], 'unknown country'],
    [['--country'], 'needs a value'],
    [['--nickname', '--listed'], 'needs a value'],
    [['--listed', '--unlisted'], 'together'],
  ])('reddeder %j', (argv, msg) => {
    const r = parseProfileArgs(argv)
    expect('error' in r && r.error).toContain(msg)
  })
})

describe('cmdProfile', () => {
  it('profil yokken durumu ve onerilen ulkeyi gosterir, hicbir sey yazmaz', async () => {
    const s = server(null)
    await cmdProfile([], s.impl)
    expect(ekran()).toContain('not on the leaderboard')
    expect(ekran()).toContain('--country TR')
    expect(s.puts).toEqual([])
  })

  it('verilmeyen alanlar mevcut profilden gelir', async () => {
    const s = server({ nickname: 'ada', country: 'DE', listed: false })
    await cmdProfile(['--listed'], s.impl)
    expect(s.puts).toEqual([{ nickname: 'ada', country: 'DE', listed: true }])
  })

  it('onerilen ulke sessizce yazilmaz', async () => {
    const s = server(null, 'TR')
    await cmdProfile(['--nickname', 'ada', '--listed'], s.impl)
    expect(s.puts).toEqual([{ nickname: 'ada', country: null, listed: true }])
  })

  it('takma ad yokken katilmaya calismak reddedilir', async () => {
    const s = server(null)
    const exit = vi.spyOn(process, 'exit').mockImplementation(((): never => { throw new Error('exit') }) as any)
    await expect(cmdProfile(['--listed'], s.impl)).rejects.toThrow('exit')
    expect(ekran()).toContain('Pick a nickname first')
    expect(s.puts).toEqual([])
    exit.mockRestore()
  })
})
