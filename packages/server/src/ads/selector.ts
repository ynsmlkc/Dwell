/**
 * Reklam secimi — ADR-009 (revize) + ADR-021.
 *
 * Gercek acik artirma motoru YOK. Ama secim artik teklifle ORANTILI:
 * pürüzsüz agirlikli sira (SWRR, nginx'in yuk dengeleme algoritmasi).
 * 2x odeyen ortalamada 2x gosterim alir. Onceki surum "en yuksek teklif
 * her zaman kazanir, sadece bir onceki tekrari elenir" idi — bu, iki
 * kampanyali her senaryoyu fiyat farkindan bagimsiz %50/%50'ye kilitliyordu
 * (PROBLEMS.md #8). Detay asagida, algoritmanin kendisinde.
 */

import { type Stroops, stroops, rateFromCpm, add } from '@dwell/protocol'
import { MIN_BID_CPM } from './campaign-store.js'
import type { Creative, IdGenerator, Clock } from '@dwell/protocol'

/** Bir blok kac gosterim. Fiyat (`bidCpm`) da 1.000 gosterim icin. */
export const IMPRESSIONS_PER_BLOCK = 1_000

export type CampaignStatus = 'active' | 'paused' | 'suspended' | 'exhausted'

export interface Campaign {
  readonly id: string
  readonly advertiserId: string
  /** Teklif CPM cinsinden — 1.000 gosterim (ADR-009). */
  readonly bidCpm: Stroops
  /** Gosterim aninda dondurulacak pay orani (ADR-011). */
  readonly revShareBps: number
  readonly creative: Creative
  readonly status: CampaignStatus
  /**
   * Tekrar kisitlamasinin genisligi. `0` = kisitlama yok, SWRR'nin dogal
   * orantisina tam guveniliyor (varsayilan — PROBLEMS.md #8 karari).
   * `N > 0` ise bu kampanya son N gosterimden herhangi birinde
   * gorunduyse elenir; yani en az N+1 gosterimde bir gorunebilir ve bu,
   * payini `1/(N+1)`'e kilitler — fiyat ne olursa olsun. `1` klasik
   * "ardisik tekrar yok" kuralidir ve iki kampanyada payi sabit %50 yapar.
   */
  readonly frequencyCap: number
  /**
   * PROBLEMS.md #8c — teklifi 2x yapmak hem fiyati hem SWRR payini 2x
   * yaptigi icin harcama hizi 4x'e cikiyor; reklamveren bunu beklemiyor.
   * Bu, teklikten BAGIMSIZ bir gunluk harcama tavani. `null`/`undefined`
   * = tavan yok (varsayilan — mevcut reklamverenler icin davranis degismez).
   * Asilirsa kampanya o gun icin `spendableBalance` filtresiyle AYNI
   * sekilde elenir; ertesi gun otomatik acilir, ban yok.
   */
  readonly dailyBudgetStroops?: Stroops | null
  /**
   * Satin alinan blok sayisi; 1 blok = 1.000 gosterim. `null`/`undefined` =
   * sinirsiz (bakiye yettigi surece). Teslim edilen gosterim bu sayiya
   * ulasinca kampanya sunulmaz — fazlasi reklamverenden ALINMAZ cunku hic
   * sunulmaz.
   */
  readonly blocks?: number | null
  /**
   * NEXT.md §10 — sponsor havuzu. `null`/`undefined` = genel ag.
   *
   * Havuz kampanyasi YALNIZCA o havuzun uyelerine, genel ag kampanyasi
   * YALNIZCA havuzsuz yayincilara sunulur. Fatura `advertiserId`'ye kesilir;
   * havuzda bu sponsorun adresidir, projeyi giren takim para odemez.
   */
  readonly poolId?: string | null
  /**
   * Havuz projesini giren katilimcinin publisherId'si. Bu kisiye kendi
   * projesi sunulmaz: kapali bir grupta kendi satirini izleyerek sponsorun
   * butcesini kendine aktarmak bedava olurdu.
   */
  readonly submittedBy?: string | null
}

export interface AdSelection {
  readonly campaign: Campaign
  readonly nonce: string
  readonly nonceExpiresAt: number
  /**
   * ADR-011 — bu ANIN fiyati, gosterim kaydina donacak. Ikinci fiyattan
   * gelir (bkz. `clearingCpm`), teklif DEGIL: kazanan bir sonraki teklifi
   * gececek kadarini oder, asla kendi teklifinden fazlasini degil.
   */
  readonly rate: Stroops
  /** Bu gosterimin blok (1.000 gosterim) basina karsiligi — panel ve test icin. */
  readonly clearingCpm: Stroops
}

export interface SelectorDeps {
  readonly clock: Clock
  readonly ids: IdGenerator
  readonly campaigns: () => readonly Campaign[]
  /**
   * Reklamverenin harcanabilir bakiyesi (ADR-021).
   * Ledger'dan gelir; `balance − reserved`.
   */
  readonly spendableBalance: (advertiserId: string) => Stroops
  /** Bu kampanyanin BUGUN (raporlanmis, henuz dogrulanmamis dahil) harcadigi tutar. */
  readonly spentToday: (campaignId: string) => Stroops
  /**
   * Bu kampanyaya ayrilmis gosterim sayisi: faturalanmis + `pending` +
   * teslim edilip henuz raporlanmamis. Blok siniri bununla kontrol edilir.
   * Verilmezse blok siniri uygulanmaz.
   */
  readonly committedImpressions?: (campaignId: string) => number
  /** Yayincinin uye oldugu ACIK havuz; yoksa `null`. Verilmezse herkes genel agda. */
  readonly poolOf?: (publisherId: string) => string | null
  /**
   * Havuz butcesi bir gosterim daha karsilar mi ve uye bugunku sinirinda
   * mi? `false` ise havuz bu kisi icin susar — kapali dongude baska secenek
   * yok, genel aga dusmez.
   */
  readonly poolAllows?: (publisherId: string, poolId: string, rate: Stroops) => boolean
  /**
   * Sponsorun acik havuzlarina ayrilmis tutar. Sponsorun NORMAL
   * kampanyalari bakiyenin yalnizca bu tutarin disinda kalanini harcayabilir;
   * havuz parasi havuzundur.
   */
  readonly reservedForPools?: (advertiserId: string) => Stroops
  readonly nonceTtlMs?: number
  /**
   * Yumusak siklik siniri: ayni yayinciya ayni kampanya son bir saatte bu
   * kadar gosterildiyse, sinirda olmayan kampanyalar once gelir. Herkes
   * sinirdaysa en yuksek teklif yine gosterilir. Varsayilan 3; 0 = kapali.
   */
  readonly hourlyCapPerPublisher?: number
  /**
   * Taban fiyat (reserve), blok basina. Rakipsiz kazanan bunu oder.
   * Varsayilan `MIN_BID_CPM`. Ag buyudukce yukseltilebilir; teklifin
   * ustundeyse fiyat teklife esitlenir (kimse teklifinden fazla odemez).
   */
  readonly reserveCpm?: Stroops
}

/** Ikinci fiyatin ustune eklenen adim: blok basina 1 kurus. */
export const BID_INCREMENT_CPM = stroops(100_000n)
export const DEFAULT_HOURLY_CAP = 3
const HOUR = 3_600_000

/** Nonce omru. Kisa: replay penceresini daraltir. */
export const DEFAULT_NONCE_TTL_MS = 5 * 60_000

export class AdSelector {
  readonly #recentByPublisher = new Map<string, string[]>()
  /** Son bir saatte bu yayinciya sunulanlar — yumusak siklik siniri icin. Bellekte. */
  readonly #shownByPublisher = new Map<string, { id: string; at: number }[]>()

  constructor(private readonly deps: SelectorDeps) {}

  /**
   * Bu publisher icin sirada hangi reklam var?
   *
   * `null` donerse HICBIR SEY gosterilmez. Bos bir reklam gostermektense
   * susmak dogrudur (ADR-003).
   */
  select(publisherId: string): AdSelection | null {
    const pool = this.deps.poolOf?.(publisherId) ?? null
    const eligible = this.deps.campaigns()
      .filter((c) => c.status === 'active')
      // Kapali dongu: havuz uyesi yalnizca kendi havuzunu, digerleri yalnizca
      // genel agi gorur. Kapanmis havuzun kampanyasi kimseyle eslesmez.
      .filter((c) => (c.poolId ?? null) === pool)
      .filter((c) => c.submittedBy == null || c.submittedBy !== publisherId)
      .filter((c) => pool === null || (this.deps.poolAllows?.(publisherId, pool, rateFromCpm(c.bidCpm)) ?? true))
      // Gosterim basina oran sifira dusuyorsa satacak bir sey yok.
      .filter((c) => rateFromCpm(c.bidCpm) > 0n)
      /**
       * ADR-021: parasi olmayan kampanya servis EDILMEZ.
       *
       * Kosul "bakiyesi var mi" DEGIL, "BU GOSTERIMI karsilayabiliyor mu".
       * Fark hayati ve gercek dagitimda ortaya cikti:
       *
       * Once `> 0n` yaziyordu. Cebinde 16 sent kalmis bir reklamverenin
       * gosterim basina 20 sentlik kampanyasi "uygun" sayiliyor, en yuksek
       * teklif oldugu icin seciliyor, sonra asagidaki kontrol "parasi
       * yetmiyor" deyip `null` donuyordu. Sonuc: parasi TIKIR TIKIR olan
       * diger kampanyalar hic siraya giremiyor ve BUTUN AG duruyordu.
       *
       * Tek bir reklamverenin bakiyesinin dip yapmasi herkesi susturmamali.
       */
      .filter((c) => this.#spendableFor(c) >= rateFromCpm(c.bidCpm))
      /**
       * PROBLEMS.md #8c — gunluk harcama tavani, teklikten bagimsiz.
       *
       * `spendableBalance` gibi "BU gosterimi karsilar mi" sorusu: tavanin
       * TAMAMEN altinda kalmak degil, bir sonraki gosterimin tavani
       * ASMAMASI gerekir. Boylece kampanya tavana carpinca sessizce
       * durur, tavanin uzerine tasmaz.
       */
      .filter((c) => {
        if (c.dailyBudgetStroops == null) return true
        return add(this.deps.spentToday(c.id), rateFromCpm(c.bidCpm)) <= c.dailyBudgetStroops
      })
      /**
       * Blok satin alma: teslim edilmis + bekleyen + yoldaki gosterimler
       * satin alinan miktara ulastiysa kampanya biter. Teslim aninda
       * sayiliyor; raporlamayi beklesek, gecikme kadar fazla gosterim
       * dagitirdik.
       */
      .filter((c) => {
        if (c.blocks == null || !this.deps.committedImpressions) return true
        return this.deps.committedImpressions(c.id) < c.blocks * IMPRESSIONS_PER_BLOCK
      })

    if (eligible.length === 0) return null

    const { chosen, clearingCpm } = this.#auction(publisherId, eligible)

    // Karsilanabilirlik yukaridaki filtrede (teklif uzerinden, yani ust
    // sinirla) kontrol edildi; burasi son savunma.
    const rate = rateFromCpm(clearingCpm)
    if (this.#spendableFor(chosen) < rate) return null

    this.#remember(publisherId, chosen.id)

    return {
      campaign: chosen,
      nonce: this.deps.ids.randomHex(16),
      nonceExpiresAt: this.deps.clock.now() + (this.deps.nonceTtlMs ?? DEFAULT_NONCE_TTL_MS),
      rate,
      clearingCpm,
    }
  }

  /**
   * Bu kampanyanin harcayabilecegi bakiye. Havuz kampanyasi sponsorun
   * bakiyesinin tamamini gorur (havuz siniri `poolAllows`'ta); normal
   * kampanya, sponsorun havuzlara ayirdigi tutari GOREMEZ.
   */
  #spendableFor(c: Campaign): Stroops {
    const all = this.deps.spendableBalance(c.advertiserId)
    if (c.poolId != null) return all
    const left = all - (this.deps.reservedForPools?.(c.advertiserId) ?? 0n)
    return stroops(left > 0n ? left : 0n)
  }

  /**
   * Fiyat sirali kuyruk + ikinci fiyat (NEXT.md "Reklam secimi", ADR-009
   * ikinci revizyon).
   *
   * 1. Aday kumesi: bu yayinciya son bir saatte siklik sinirina ulasmamis
   *    (ve kampanyanin kendi `frequencyCap`'ine takilmamis) kampanyalar.
   *    Bos kalirsa butun uygunlar — sinir sirayi degistirir, kimseyi
   *    susturmaz. Sert sinir az kampanyali agda yayinciyi saatin cogunda
   *    reklamsiz birakirdi (eski %50/%50 kilidiyle ayni tuzak, PROBLEMS.md #8a).
   * 2. En yuksek teklif kazanir. Esitlikte bu yayinciya en uzun suredir
   *    gosterilmeyen; ikisi de hic gosterilmediyse rastgele. Sabit bir ID
   *    sirasi, sik yeniden baslatmada hep ayni reklami kazandiriyordu
   *    (denetim notu, 2026-09-06).
   * 3. Fiyat: ayni aday kumesindeki bir sonraki teklif + 1 kurus, en fazla
   *    kendi teklifi. Ayni reklamverenin diger kampanyalari rakip sayilmaz
   *    (kendi fiyatini kendisi yukseltemez). Rakip yoksa taban fiyat.
   *    Havuz kampanyasinda fiyat havuzun sabit fiyatidir — hepsi sponsorun
   *    adina faturalanir, ikinci fiyat anlamsiz olurdu.
   */
  #auction(publisherId: string, eligible: readonly Campaign[]): { chosen: Campaign; clearingCpm: Stroops } {
    const now = this.deps.clock.now()
    const recent = this.#recentByPublisher.get(publisherId) ?? []
    const shown = (this.#shownByPublisher.get(publisherId) ?? []).filter((x) => now - x.at < HOUR)
    const cap = this.deps.hourlyCapPerPublisher ?? DEFAULT_HOURLY_CAP
    const shownCount = (id: string): number => shown.reduce((n, x) => n + (x.id === id ? 1 : 0), 0)

    // frequencyCap 0 → kisitlama yok. `slice(-0)` tum diziyi doner; bu yuzden
    // 0 ayrica ele aliniyor, yoksa "kisitlama yok" tam tersine donerdi.
    const fresh = eligible.filter((c) =>
      (cap === 0 || shownCount(c.id) < cap)
      && (c.frequencyCap === 0 || !recent.slice(-c.frequencyCap).includes(c.id)))
    const candidates = fresh.length > 0 ? fresh : eligible

    const lastPickIndex = (id: string): number => {
      const idx = recent.lastIndexOf(id)
      return idx === -1 ? -Infinity : idx
    }
    const ranked = [...candidates].sort((a, b) => {
      if (a.bidCpm !== b.bidCpm) return a.bidCpm > b.bidCpm ? -1 : 1
      const la = lastPickIndex(a.id)
      const lb = lastPickIndex(b.id)
      if (la !== lb) return la < lb ? -1 : 1
      return this.deps.ids.randomHex(1) < '8' ? -1 : 1
    })
    const chosen = ranked[0]!

    if (chosen.poolId != null) return { chosen, clearingCpm: chosen.bidCpm }

    const rival = ranked.find((c) => c.advertiserId !== chosen.advertiserId)
    const reserve = this.deps.reserveCpm ?? MIN_BID_CPM
    const second = rival ? add(rival.bidCpm, BID_INCREMENT_CPM) : reserve
    const floor = second > reserve ? second : reserve
    const clearingCpm = floor < chosen.bidCpm ? floor : chosen.bidCpm
    return { chosen, clearingCpm: stroops(clearingCpm) }
  }

  #remember(publisherId: string, campaignId: string): void {
    const list = this.#recentByPublisher.get(publisherId) ?? []
    list.push(campaignId)
    if (list.length > 32) list.shift()
    this.#recentByPublisher.set(publisherId, list)

    const now = this.deps.clock.now()
    const shown = (this.#shownByPublisher.get(publisherId) ?? []).filter((x) => now - x.at < HOUR)
    shown.push({ id: campaignId, at: now })
    this.#shownByPublisher.set(publisherId, shown)
  }
}
