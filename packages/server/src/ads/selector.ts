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
import type { Creative, IdGenerator, Clock } from '@dwell/protocol'

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
}

export interface AdSelection {
  readonly campaign: Campaign
  readonly nonce: string
  readonly nonceExpiresAt: number
  /** ADR-011 — bu ANIN fiyati, gosterim kaydina donacak. */
  readonly rate: Stroops
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
  readonly nonceTtlMs?: number
}

/** Nonce omru. Kisa: replay penceresini daraltir. */
export const DEFAULT_NONCE_TTL_MS = 5 * 60_000

export class AdSelector {
  readonly #recentByPublisher = new Map<string, string[]>()
  /** SWRR biriken agirlik durumu, publisher basina, kampanya basina. */
  readonly #weightByPublisher = new Map<string, Map<string, bigint>>()

  constructor(private readonly deps: SelectorDeps) {}

  /**
   * Bu publisher icin sirada hangi reklam var?
   *
   * `null` donerse HICBIR SEY gosterilmez. Bos bir reklam gostermektense
   * susmak dogrudur (ADR-003).
   */
  select(publisherId: string): AdSelection | null {
    const eligible = this.deps.campaigns()
      .filter((c) => c.status === 'active')
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
      .filter((c) => this.deps.spendableBalance(c.advertiserId) >= rateFromCpm(c.bidCpm))
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

    if (eligible.length === 0) return null

    const chosen = this.#swrrPick(publisherId, eligible)

    // Karsilanabilirlik yukaridaki filtrede kontrol edildi; burasi son
    // savunma. Tetiklenirse yukaridaki filtre bozulmus demektir.
    const rate = rateFromCpm(chosen.bidCpm)
    if (this.deps.spendableBalance(chosen.advertiserId) < rate) return null

    this.#remember(publisherId, chosen.id)

    return {
      campaign: chosen,
      nonce: this.deps.ids.randomHex(16),
      nonceExpiresAt: this.deps.clock.now() + (this.deps.nonceTtlMs ?? DEFAULT_NONCE_TTL_MS),
      rate,
    }
  }

  /**
   * Pürüzsüz agirlikli sira (SWRR) — nginx'in upstream yuk dengelemede
   * kullandigi ayni algoritma. Agirlik = `bidCpm` (oran degil, ham teklif;
   * oranti CPM orantisiyla birebir ayni ve bolme kalintisi tasimiyor).
   *
   * Her tikte HER uygun kampanyanin biriken agirligi kendi agirligi kadar
   * artar; en yuksek birikimli olan secilir ve toplam agirlik kadar geriye
   * dusurulur. Bu, uzun vadede payi tam `agirlik / toplam_agirlik` orasina
   * yaklastirir — rastgele agirlikli secimin aksine kumelenme yapmaz ve
   * deterministiktir (bir reklamveren "neden B iki kez ust uste cikti da
   * ben cikmadim" diye panele bakip haksiz yere supheye dusmez).
   *
   * Frekans kurali (`frequencyCap`) SWRR'nin UZERINE, secim anini daraltan
   * bir filtre olarak biner: secilecek aday once bu filtreden gecmek
   * zorunda, ama filtrelenen adayin biriken agirligi KAYBOLMAZ — bir
   * sonraki tikte hala orada durur ve buyumeye devam eder. Bu yuzden
   * kisitlama payi ERTELER, SILMEZ; havuz gercekten tukenirse (fresh bos)
   * en yuksek birikimli olana geri donulur — reklam gostermemektense
   * tekrar etmek iyidir.
   */
  #swrrPick(publisherId: string, eligible: readonly Campaign[]): Campaign {
    const weights = this.#weightState(publisherId, eligible)

    let total = 0n
    for (const c of eligible) {
      const next = (weights.get(c.id) ?? 0n) + c.bidCpm
      weights.set(c.id, next)
      total += c.bidCpm
    }

    const byWeightDesc = (a: Campaign, b: Campaign): number => {
      const wa = weights.get(a.id)!
      const wb = weights.get(b.id)!
      if (wa !== wb) return wa > wb ? -1 : 1
      // Esitlikte: yuksek teklif, sonra id — deterministik.
      if (a.bidCpm !== b.bidCpm) return a.bidCpm > b.bidCpm ? -1 : 1
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    }

    const recent = this.#recentByPublisher.get(publisherId) ?? []
    // frequencyCap 0 → kisitlama yok (bkz. Campaign.frequencyCap dokumani).
    // `slice(-0)` JS'te `slice(0)` ile ayni seydir (tum diziyi doner!) —
    // bu yuzden 0 durumu ayrica ele alinir, yoksa "kisitlama yok" niyeti
    // "hep gosterilmisse hep dislan" gibi tam tersine donerdi.
    const fresh = eligible.filter((c) =>
      c.frequencyCap === 0 ? true : !recent.slice(-c.frequencyCap).includes(c.id)
    )
    const pool = fresh.length > 0 ? fresh : eligible
    const chosen = [...pool].sort(byWeightDesc)[0]!

    weights.set(chosen.id, weights.get(chosen.id)! - total)
    return chosen
  }

  #weightState(publisherId: string, eligible: readonly Campaign[]): Map<string, bigint> {
    let weights = this.#weightByPublisher.get(publisherId)
    if (!weights) {
      weights = new Map()
      this.#weightByPublisher.set(publisherId, weights)
    }
    // Artik uygun olmayan kampanyalarin agirligini birikmeye birakmiyoruz —
    // aksi halde uzun sure pasif kalip sonra donen bir kampanya, hakkinin
    // cok ustunde bir baslangic avantajiyla geri gelir.
    const eligibleIds = new Set(eligible.map((c) => c.id))
    for (const id of weights.keys()) {
      if (!eligibleIds.has(id)) weights.delete(id)
    }
    return weights
  }

  #remember(publisherId: string, campaignId: string): void {
    const list = this.#recentByPublisher.get(publisherId) ?? []
    list.push(campaignId)
    if (list.length > 32) list.shift()
    this.#recentByPublisher.set(publisherId, list)
  }
}
