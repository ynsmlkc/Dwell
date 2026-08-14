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

/**
 * Oturum basina durum.
 *
 * Tur durumu OTURUM BASINADIR, makine genelinde degil. Global tutmak
 * su hataya yol aciyordu: bir oturum tur icindeyken BOSTAKI diger
 * oturumlarda da reklam goruntuleniyordu.
 *
 * ADR-012 "ikinci bir oturum BEKLEMEYE GIRDIGINDE satir yine gosterilir
 * ama sayilmaz" diyor — beklemeye girdiginde. Bostaki oturum reklam gormez.
 */
interface SessionState {
  phase: TurnPhase
  cooldownUntil: number
}

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
  /** Oturum basina tur durumu. */
  readonly #sessions = new Map<string, SessionState>()
  /** ADR-012: gosterim sayma hakki makine kapsaminda TEK oturumdadir. */
  #activeSession: string | null = null
  /** Yalnizca mutex sahibinin gosterimi sayilir. */
  #show: ActiveShow | null = null
  readonly #completed: CompletedImpression[] = []

  constructor(private readonly deps: TurnMachineDeps) {}

  /** Mutex sahibinin durumu — saglik ciktisi icin. */
  get phase(): TurnPhase {
    return (this.#activeSession && this.#sessions.get(this.#activeSession)?.phase) || 'idle'
  }
  get activeSession(): string | null { return this.#activeSession }
  /** Su an tur icinde olan oturum sayisi. */
  get openTurns(): number {
    let n = 0
    for (const s of this.#sessions.values()) if (s.phase !== 'idle') n++
    return n
  }

  /* ── olaylar ── */

  /** `UserPromptSubmit` — tur acilir. */
  onTurnStart(sessionId: string, ts: number = this.deps.clock.now()): void {
    this.#sessions.set(sessionId, { phase: 'showing', cooldownUntil: 0 })

    // ADR-012: mutex bostaysa veya bu oturum zaten tutuyorsa devral.
    // Doluysa devralma — digeri sayiyor, bu oturum SILENT.
    if (this.#activeSession === null || this.#activeSession === sessionId) {
      this.#activeSession = sessionId
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
    const st = this.#sessions.get(sessionId)
    if (!st || st.phase !== 'showing') return

    // Tolerans HER oturum icin ayri isler; mutex sahibi olmasi gerekmez.
    st.phase = 'cooldown'
    st.cooldownUntil = ts + this.deps.config().idleGraceMs
    // `lastSeenAt` burada da guncellenmez — ayni gerekce.
  }

  /**
   * `statusLine` her cagrildiginda — hem render karari hem zaman ilerletme.
   *
   * Bu, sistemin tek gercek "gosterildi" kanitidir: script calistiysa satir
   * ekrana basilmistir. spinner'da boyle bir sinyal yok, o yuzden sayilmaz.
   */
  onTick(sessionId: string, ts: number = this.deps.clock.now()): RenderDecision {
    this.#expireCooldowns(ts)

    // ADR-023, altı şart — biri eksikse hicbir sey basilmaz.
    if (this.deps.isPaused()) return this.#stopAndHide(ts, 'kullanici duraklatti')
    if (!this.deps.isAuthenticated()) return this.#stopAndHide(ts, 'giris yapilmamis')

    const cfg = this.deps.config()
    if (!cfg.renderEnabled) return this.#stopAndHide(ts, 'uzaktan kapatildi')
    if (!cfg.surfaces.statusline) return this.#stopAndHide(ts, 'statusline yuzeyi kapali')

    // Karar BU OTURUMUN durumuna gore verilir.
    //
    // Makine genelindeki duruma bakmak su hataya yol aciyordu: bir oturum
    // tur icindeyken, bostaki diger oturumlarda da reklam goruntuleniyordu.
    // Kullanicinin bakis acisindan reklam "hic kapanmiyor" gorunuyordu.
    const st = this.#sessions.get(sessionId)
    if (!st || st.phase === 'idle') return HIDDEN('idle', 'bu oturumda aktif tur yok')

    // ADR-012: mutex baskasindaysa satir yine GOSTERILIR (kullanici deneyimi
    // tutarli kalsin) ama SAYILMAZ. Bu oturumun da tur icinde olmasi sart —
    // yukarida kontrol edildi.
    const counts = this.#activeSession === sessionId

    if (!counts) {
      // Sayan oturumun reklamini goster; yoksa siradakini al.
      const ad = this.#show?.ad ?? this.deps.nextAd()
      return ad
        ? { ad, phase: st.phase, reason: 'baska oturum sayiyor' }
        : HIDDEN(st.phase, 'reklam yok')
    }

    if (this.#show === null) {
      this.#startShow(ts)
      if (this.#show === null) return HIDDEN(st.phase, 'reklam yok')
    }

    this.#show.lastSeenAt = ts
    // ADR-022: rotasyon suresi dolduysa mevcut gosterimi kapat, yenisini ac.
    if (ts - this.#show.startedAt >= cfg.rotateMs) {
      this.#closeShow(ts)
      this.#startShow(ts)
      if (this.#show === null) return HIDDEN(st.phase, 'reklam yok')
    }

    return { ad: this.#show.ad, phase: st.phase, reason: null }
  }

  /** Kuyruga yazilmak uzere tamamlanmis gosterimleri alir ve listeyi bosaltir. */
  drainImpressions(): CompletedImpression[] {
    return this.#completed.splice(0, this.#completed.length)
  }

  /** Oturum kapandi — mutex serbest kalmali, yoksa makine kilitlenir. */
  onSessionEnd(sessionId: string, ts: number = this.deps.clock.now()): void {
    this.#sessions.delete(sessionId)
    if (this.#activeSession === sessionId) {
      this.#closeShow(ts)
      this.#activeSession = this.#nextMutexHolder()
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

  /** Toleransi dolan her oturum bosa duser. */
  #expireCooldowns(ts: number): void {
    for (const [sid, st] of this.#sessions) {
      if (st.phase !== 'cooldown' || ts < st.cooldownUntil) continue
      st.phase = 'idle'
      if (this.#activeSession === sid) {
        this.#closeShow(ts)
        // Mutex bosaldi — bekleyen baska oturum varsa ona gecer.
        this.#activeSession = this.#nextMutexHolder()
      }
    }
  }

  /** Tur icinde olan bir sonraki oturum. Yoksa null. */
  #nextMutexHolder(): string | null {
    for (const [sid, st] of this.#sessions) if (st.phase !== 'idle') return sid
    return null
  }

  #stopAndHide(ts: number, reason: string): RenderDecision {
    this.#closeShow(ts)
    return HIDDEN('idle', reason)
  }
}
