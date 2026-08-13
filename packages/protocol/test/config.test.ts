import { describe, it, expect } from 'vitest'
import { remoteConfigSchema, FALLBACK_CONFIG, isMeasurable } from '../src/schemas.js'

describe('RemoteConfig', () => {
  it('varsayilan gecerli', () => {
    expect(() => remoteConfigSchema.parse(FALLBACK_CONFIG)).not.toThrow()
  })

  it('ulasilamiyorsa GOSTERMEZ — fail closed', () => {
    expect(FALLBACK_CONFIG.renderEnabled).toBe(false)
    expect(Object.values(FALLBACK_CONFIG.surfaces).every((v) => v === false)).toBe(true)
  })

  it('rotateMs < minImpressionMs reddedilir — ADR-022', () => {
    // Rotasyon esikten kisa olursa hicbir reklam nitelikli sureyi dolduramaz
    // ve envanter sessizce sifira duser.
    const bad = { ...FALLBACK_CONFIG, rotateMs: 5_000, minImpressionMs: 10_000 }
    expect(() => remoteConfigSchema.parse(bad)).toThrow(/rotateMs/)
  })

  it('rotateMs == minImpressionMs kabul edilir', () => {
    expect(() => remoteConfigSchema.parse({
      ...FALLBACK_CONFIG, rotateMs: 10_000, minImpressionMs: 10_000,
    })).not.toThrow()
  })

  it('idleGraceMs varsayilani 4sn — ADR-023', () => {
    expect(FALLBACK_CONFIG.idleGraceMs).toBe(4_000)
  })

  it('ADR-016: minClientVersion ve yuzey bayraklari ilk surumde var', () => {
    for (const k of ['minClientVersion', 'surfaces', 'renderEnabled'] as const) {
      expect(FALLBACK_CONFIG).toHaveProperty(k)
    }
  })

  it('bilinmeyen alanlar sessizce dusurulur — ileri uyumluluk', () => {
    const parsed = remoteConfigSchema.parse({ ...FALLBACK_CONFIG, gelecekteAlan: 42 })
    expect(parsed).not.toHaveProperty('gelecekteAlan')
  })
})

describe('yuzey olculebilirligi — ADR-001', () => {
  it('yalnizca statusline gosterim sayabilir', () => {
    expect(isMeasurable('statusline')).toBe(true)
    expect(isMeasurable('spinner_verb')).toBe(false)
    expect(isMeasurable('spinner_tip')).toBe(false)
  })
})
