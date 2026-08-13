/**
 * Tur state machine'i — daemon'in kalbi.
 *
 * Burasi saf: ag yok, disk yok, `Date.now()` yok. Saat ve kimlik uretici
 * disaridan enjekte edilir (protocol/clock). Boylece 10 saniye, 20 saniyelik
 * rotasyon ve 4 saniyelik tolerans gibi her sey testte milisaniye hassasiyetle
 * dogrulanabilir.
 *
 * Uyguladigi kararlar:
 *   ADR-001  yalnizca statusLine olculur; spinner sayilmaz
 *   ADR-012  makine kapsaminda ayni anda tek aktif gosterim (mutex)
 *   ADR-022  tur icinde reklam rotasyonu
 *   ADR-023  reklam yalnizca tur icinde + 4sn tolerans; bosta ekran temiz
 */

import type { Clock, IdGenerator, AdPayload, RemoteConfig, Surface } from '@dwell/protocol'

/* ─────────────────────────── tipler ─────────────────────────── */

export type TurnPhase = 'idle' | 'showing' | 'cooldown'

/** Bir gosterimin tamamlanmis hali — kuyruga bu yazilir. */
export interface CompletedImpression {
  readonly id: string
  readonly campaignId: string
  readonly nonce: string
  readonly sessionId: string
  readonly surface: Surface
  readonly durationMs: number
  readonly clientTs: number
  /** Sayilmadiysa sebebi. Sayildiysa null. */
  readonly rejectedReason: string | null
}

/** Shim'e verilecek cevap. */
export interface RenderDecision {
  /** Basilacak reklam; `null` ise HICBIR SEY basilmaz (bos string bile degil). */
  readonly ad: AdPayload | null
  readonly phase: TurnPhase
  /** Neden gosterilmiyor — `dwell doctor` bunu gosterir. */
  readonly reason: string | null
}

const HIDDEN = (phase: TurnPhase, reason: string): RenderDecision =>
  ({ ad: null, phase, reason })

interface ActiveShow {
  readonly ad: AdPayload
  readonly startedAt: number
  readonly sessionId: string
  /** Gosterimin kesintiye ugramadigi son an. */
  lastSeenAt: number
}

export interface TurnMachineDeps {
  readonly clock: Clock
  readonly ids: IdGenerator
  /** Sirada bekleyen reklami verir. Yoksa `null` — o zaman hicbir sey basilmaz. */
  readonly nextAd: () => AdPayload | null
  readonly config: () => RemoteConfig
  /** Kullanici `dwell pause` demis mi? */
  readonly isPaused: () => boolean
  /** Giris yapilmis ve token gecerli mi? */
  readonly isAuthenticated: () => boolean
}

/* ─────────────────────────── makine ─────────────────────────── */

export class TurnMachine {
  #phase: TurnPhase = 'idle'
  /** ADR-012: makine kapsaminda TEK aktif oturum. */
  #activeSession: string | null = null
  /** Aktif turu olan oturumlar — mutex'i kim tutarsa o sayar. */
  readonly #openTurns = new Set<string>()
  #show: ActiveShow | null = null
  /** Tur bittiginde tolerans sayaci baslar. */
  #cooldownUntil = 0
  readonly #completed: CompletedImpression[] = []

  constructor(private readonly deps: TurnMachineDeps) {}

  get phase(): TurnPhase { return this.#phase }
  get activeSession(): string | null { return this.#activeSession }

  /* ── olaylar ── */

  /** `UserPromptSubmit` — tur acilir. */
  onTurnStart(sessionId: string, ts: number = this.deps.clock.now()): void {
    this.#openTurns.add(sessionId)
    // ADR-012: mutex bostaysa veya bu oturum zaten tutuyorsa devral.
    // Doluysa devralma — digeri sayiyor, bu oturum SILENT.
    if (this.#activeSession === null || this.#activeSession === sessionId) {
      this.#activeSession = sessionId
      this.#phase = 'showing'
      this.#cooldownUntil = 0
      // Cooldown icinde yeni tur geldiyse gosterim KESILMEZ — reklam
      // yanip sonmesin diye ayni show devam eder (ADR-023).
      //
      // DIKKAT: burada `lastSeenAt` GUNCELLENMEZ. Hook, satirin ekranda
      // oldugunun kaniti degildir — yalnizca `onTick` oyle. Bkz. #closeShow.
      if (this.#show === null) this.#startShow(ts)
    }
  }

  /** `Stop` — tur kapanir, tolerans baslar. */
  onTurnEnd(sessionId: string, ts: number = this.deps.clock.now()): void {
    this.#openTurns.delete(sessionId)
    if (this.#activeSession !== sessionId) return
    if (this.#phase !== 'showing') return

    this.#phase = 'cooldown'
    this.#cooldownUntil = ts + this.deps.config().idleGraceMs
    // `lastSeenAt` burada da guncellenmez — ayni gerekce.
  }

  /**
   * `statusLine` her cagrildiginda — hem render karari hem zaman ilerletme.
   *
   * Bu, sistemin tek gercek "gosterildi" kanitidir: script calistiysa satir
   * ekrana basilmistir. spinner'da boyle bir sinyal yok, o yuzden sayilmaz.
   */
  onTick(sessionId: string, ts: number = this.deps.clock.now()): RenderDecision {
    this.#expireCooldown(ts)

    // ADR-023, altı şart — biri eksikse hicbir sey basilmaz.
    if (this.deps.isPaused()) return this.#stopAndHide(ts, 'kullanici duraklatti')
    if (!this.deps.isAuthenticated()) return this.#stopAndHide(ts, 'giris yapilmamis')

    const cfg = this.deps.config()
    if (!cfg.renderEnabled) return this.#stopAndHide(ts, 'uzaktan kapatildi')
    if (!cfg.surfaces.statusline) return this.#stopAndHide(ts, 'statusline yuzeyi kapali')
    if (this.#phase === 'idle') return HIDDEN('idle', 'aktif tur yok')

    // ADR-012: mutex baskasindaysa satir yine GOSTERILIR (kullanici deneyimi
    // tutarli kalsin) ama SAYILMAZ.
    const counts = this.#activeSession === sessionId

    if (this.#show === null) {
      if (!counts) {
        const ad = this.deps.nextAd()
        return ad ? { ad, phase: this.#phase, reason: 'baska oturum sayiyor' }
                  : HIDDEN(this.#phase, 'reklam yok')
      }
      this.#startShow(ts)
      if (this.#show === null) return HIDDEN(this.#phase, 'reklam yok')
    }

    if (counts) {
      this.#show.lastSeenAt = ts
      // ADR-022: rotasyon suresi dolduysa mevcut gosterimi kapat, yenisini ac.
      if (ts - this.#show.startedAt >= cfg.rotateMs) {
        this.#closeShow(ts)
        this.#startShow(ts)
        if (this.#show === null) return HIDDEN(this.#phase, 'reklam yok')
      }
    }

    return {
      ad: this.#show.ad,
      phase: this.#phase,
      reason: counts ? null : 'baska oturum sayiyor',
    }
  }

  /** Kuyruga yazilmak uzere tamamlanmis gosterimleri alir ve listeyi bosaltir. */
  drainImpressions(): CompletedImpression[] {
    return this.#completed.splice(0, this.#completed.length)
  }

  /** Oturum kapandi — mutex serbest kalmali, yoksa makine kilitlenir. */
  onSessionEnd(sessionId: string, ts: number = this.deps.clock.now()): void {
    this.#openTurns.delete(sessionId)
    if (this.#activeSession === sessionId) {
      this.#closeShow(ts)
      this.#activeSession = this.#openTurns.values().next().value ?? null
      this.#phase = this.#activeSession ? 'showing' : 'idle'
    }
  }

  /* ── ic isler ── */

  #startShow(ts: number): void {
    const ad = this.deps.nextAd()
    if (!ad || this.#activeSession === null) { this.#show = null; return }
    this.#show = { ad, startedAt: ts, sessionId: this.#activeSession, lastSeenAt: ts }
  }

  /**
   * Gosterimi kapatir. Sure esigi gecmisse sayilir, gecmemisse
   * `rejectedReason` ile kaydedilir — atilmaz, cunku red orani fraud
   * pipeline'inin girdisi (§9).
   *
   * Sure `lastSeenAt - startedAt`, yani **yalnizca tick'lerle olculen** sure.
   * Hook olaylari (`Stop`, `UserPromptSubmit`) bu sayaci ilerletmez: hook
   * atesledi diye satir ekranda demek degildir. Terminal arka planda kalmis,
   * izin istemi acilmis veya shim carpmis olabilir. Tek gecerli kanit,
   * statusLine script'inin gercekten calismis olmasidir.
   */
  #closeShow(ts: number): void {
    const show = this.#show
    if (!show) return
    this.#show = null

    const durationMs = Math.max(0, show.lastSeenAt - show.startedAt)
    const min = this.deps.config().minImpressionMs
    this.#completed.push({
      id: this.deps.ids.impressionId(),
      campaignId: show.ad.campaignId,
      nonce: show.ad.nonce,
      sessionId: show.sessionId,
      surface: 'statusline',
      durationMs,
      clientTs: ts,
      rejectedReason: durationMs >= min ? null : `sure ${durationMs}ms < ${min}ms`,
    })
  }

  #expireCooldown(ts: number): void {
    if (this.#phase === 'cooldown' && ts >= this.#cooldownUntil) {
      this.#closeShow(ts)
      this.#phase = 'idle'
      this.#activeSession = this.#openTurns.values().next().value ?? null
      if (this.#activeSession) this.#phase = 'showing'
    }
  }

  #stopAndHide(ts: number, reason: string): RenderDecision {
    this.#closeShow(ts)
    this.#phase = 'idle'
    return HIDDEN('idle', reason)
  }
}
