# Site — tasarım brief'i

> 2026-08-17 · **v2** — reklamveren paneli artık gerçek, eklendi.
>
> Tasarım araçlarına (v0, Lovable, Bolt, Figma Make) verilecek prompt aşağıda,
> `PROMPT` başlığı altında. Öncesi senin için: neyin gerçek olduğu, neyin
> olmadığı.

## Değişen ne

v1'de "reklamveren panelini tasarlatma, arka ucu yok" yazıyordu. Artık var:
cüzdanla giriş, zincirden para yatırma, kampanya oluşturma, yayına alma.
Hepsi canlı sunucuda çalışıyor ve test edildi.

## Dört alan

| Alan | Rota | Arka uç | Durum |
|---|---|---|---|
| Landing | `/` | gerekmiyor | yap |
| Yayıncı paneli | `/app` | hazır | yap |
| Reklamveren tanıtım | `/advertisers` | gerekmiyor | yap |
| Reklamveren paneli | `/advertisers/app` | **hazır** | yap |
| Gizlilik | `/privacy` | gerekmiyor | yap |

## Gerçekten var olan uçlar

```
GET  /health
GET  /v1/config

POST /v1/auth/challenge   { address }
                          → { transaction, network_passphrase, expiresAt }
POST /v1/auth/verify      { address, transaction, role? }
                          → { token, tokenId, publisherId, role }
                            role: "publisher" (varsayılan) | "advertiser"

── yayıncı ──
GET  /v1/me/balance

── reklamveren ──
GET  /v1/advertiser/me
POST /v1/advertiser/campaigns              { brand, text, cta, bidCpmStroops }
POST /v1/advertiser/campaigns/:id/status   { status: "active" | "paused" }
```

Canlı: `https://dwellserver-production.up.railway.app`

### `/v1/me/balance` — yayıncı paneli

```json
{
  "pendingStroops": "0",
  "payableStroops": "575000",
  "inFlightStroops": "0",
  "lifetimeStroops": "575000",
  "payoutThresholdStroops": "10000000",
  "recentPayouts": [],
  "blockedReason": "esik 10000000 stroop, bakiye 575000"
}
```

### `/v1/advertiser/me` — reklamveren paneli

```json
{
  "advertiserId": "GBOYXJ4JZLZY72GZIFXZSX7HVKDDITADWUDGDYE3EML24GXDV3K7KX7C",
  "balanceStroops": "20000000",
  "spendableStroops": "18400000",
  "deposit": {
    "address": "GB56NGRB2G66BYYMSRWND4WLGB7H6TTXTL3GGFXRY3ENB65QMCIGDEHN",
    "assetCode": "USDC",
    "assetIssuer": "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    "note": "Yalnizca <kendi adresin> adresinden gonderilen odemeler hesabina yazilir"
  },
  "campaigns": [
    {
      "id": "c-01M07QTJMKWEK07FCT7EFJMYD2",
      "brand": "Resend",
      "text": "email API for developers",
      "cta": "resend.com",
      "bidCpmStroops": "400000000",
      "status": "active",
      "preview": "✶ Resend — email API for developers · resend.com"
    }
  ]
}
```

Stroop = USDC'nin 10 milyonda biri. `400000000` = **$40 CPM** = gösterim
başına $0,04.

`balanceStroops` ile `spendableStroops` farkı **rezerve**: teslim edilmiş ama
henüz raporlanmamış reklamlar ve doğrulanmayı bekleyen gösterimler.
Reklamveren "param var ama harcanmıyor" dediğinde cevabı bu.

## Doğrulama kuralları — formda göstermek zorunda

| Kural | Değer |
|---|---|
| Satır uzunluğu | `✶ {brand} — {text} · {cta}` **≤ 80 karakter** |
| `cta` | yalnızca alan adı — `firecrawl.dev` ✓, `https://x.com/a` ✗ |
| Kaçış/kontrol karakteri | reddedilir (temizlenmez) |
| Minimum teklif | 1.000.000 stroop CPM = **$0,10 / 1000** |
| Yayıncı payı | **%50, sabit** — reklamveren değiştiremez |
| Yeni kampanya | **`paused` başlar** |
| Bakiyesiz yayına alma | **402** döner |

Hata cevabı hangi alanın bozuk olduğunu söylüyor:

```json
{ "code": "DWL_9001", "message": "...", "hint": "satir 94 karakter, en fazla 80 olabilir", "field": "text" }
```

## Var OLMAYAN şeyler — tasarlatma

- Cüzdan değiştirme ucu (panelde görünür, düzenlenemez)
- Cihaz/oturum iptal ucu
- Kampanya **silme** veya metnini **düzenleme** (sadece oluştur + duraklat/başlat)
- Günlük bütçe, hedefleme, zamanlama, A/B
- Grafik/istatistik — gösterim sayısı, tıklama, CTR **hiçbiri yok**
- E-posta/şifre girişi — kimlik cüzdandır, hep öyle kalacak

## Yayıncı tarafında kritik bir sorun: trustline

Stellar'da bir cüzdan, kabul edeceği her varlık için önce **trustline**
açmak zorunda. Bu olmadan USDC gönderilemez.

Gerçek testte yaşandı: yayıncı eşiği aştı, ödeme çıkmadı, parası defterde
bekledi. Sebep trustline eksikliğiydi ve kullanıcının bunu bilmesinin
hiçbir yolu yoktu.

**Panel bunu tespit edip çözmeli.** Tarayıcı Horizon'dan cüzdanın
bakiyelerini okuyabilir; USDC trustline'ı yoksa açık bir uyarı ve
Freighter'a `changeTrust` imzalatan bir buton göstermeli.

Maliyeti: cüzdanda 0,5 XLM kilitleniyor (silinince geri geliyor). Kullanıcıda
XLM yoksa bunu da söylemek gerekiyor.

> İleride bu ücreti biz üstleneceğiz (ADR-020, sponsorlu trustline) ama o
> sunucu tarafı iş; şimdilik kullanıcı kendi açıyor.

## Dil

Prompt İngilizce (tasarım araçları İngilizce'de belirgin şekilde daha iyi).
Site metni Türkçe olacaksa prompt'un son satırını değiştir.

---

## Prompt nerede

`DESIGN-PROMPT.md` — sadece prompt, başka hiçbir şey yok. Tasarım aracına
o dosyanın tamamını yapıştır.

Bu dosya (`DESIGN-BRIEF.md`) senin için: neyin gerçek olduğu, hangi uçların
var olduğu, hangi kuralların neden konduğu.

## v2'de eklenen: reklam önizleme bileşeni

Sitenin en önemli bileşeni. Bir kez yazılıp üç yerde kullanılıyor:
landing hero'da (canlı, beliren-kaybolan), reklamveren formunda (yazarken
canlı), kampanya listesinde (her satırda).

Reklamın terminalde **gerçekte nasıl göründüğünü** basıyor — süslenmiş bir
pazarlama görseli değil. Yanında asistanın o an ne yaptığı da var
(`Edit · 2.8s`), çünkü statusLine kullanıcının kendi alanı; oraya konuk
oluyoruz ve o da bir şey almalı.

Reklamveren tarafında bir de **görsel indirme** var: satırı PNG olarak
dışa aktarıyor. Reklamverenin ilk sorusu "nasıl görünüyor" oluyor ve cevabı
Slack'e yapıştıracak birine gönderiyor. Ona dosya ver.

Logo yuvası **yok** — satır düz metin, görsel kanalı yok. Mock-up'a logo
koymak ürün hakkında yalan söylemek olurdu.
