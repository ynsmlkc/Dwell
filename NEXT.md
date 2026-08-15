# Sırada ne var

> Son güncelleme: 2026-08-15. Otorite `PROJECT.md`; burası yalnızca sıradaki işin listesi.

## Nerede duruyoruz

Omurga çalışıyor. Gerçek bir makinede kurulu, üç ayrı Claude Code oturumundan gösterim topluyor.

```
✅ protocol          82 test    para, sanitizer, şemalar, saat enjeksiyonu
✅ sunucu           101 test    reklam seçimi, gösterim kabulü, doğrulama, defter, HTTP
✅ cüzdan + ödeme    72 test    adres kontrolü, SEP-10, batch ödeme, arıza modları
✅ daemon + CLI     114 test    tur makinesi, socket, shim, kuyruk, settings, spinner
────────────────────────────
   369 test
```

Uçtan uca doğrulanmış: `dwell init` → reklam ekranda → tur sayılıyor → diske yazılıyor → spinner tur başına dönüyor.

**Ama bir yere bağlı değil.** Reklamlar daemon'ın içinde gömülü üç sabit kayıt; gösterimler diskte birikiyor, hiçbir yere gitmiyor; kimse kazanmıyor.

---

## 1 — Sunucu bağlantısı ⭐ önce bu

Omurganın tek kopuk halkası. Sunucu kodu yazılı ve testli (101 test), sadece daemon ona bağlı değil.

- [ ] Sunucuyu ayağa kaldıran giriş noktası (`packages/server/src/main.ts` + `pnpm dev`)
- [ ] Daemon'da HTTP istemcisi: `POST /v1/ads/next` ile reklam çek, önbelleğe al
- [ ] Kuyruğu boşalt: `POST /v1/impressions`, kabul edilenleri `markSent`
- [ ] `GET /v1/config` periyodik çekim → kill switch ve `minClientVersion` canlı
- [ ] Ağ yokken davranış: mevcut önbellekten servis, kuyruk büyümeye devam

**Bitti kriteri:** Daemon'ı sunucuya bağla, bir tur çevir, sunucu tarafında `pending` gösterimi gör. Sunucuyu kapat — istemci sessizce çalışmaya devam etsin, kuyruk büyüsün, sunucu dönünce boşalsın.

Bunun sonunda ilk defa **iki taraflı** bir sistem olur.

---

## 2 — Kimlik ve cüzdan

Kimse giriş yapmadığı için gösterimler kimseye yazılmıyor.

- [ ] GitHub device flow (`dwell login`) — tarayıcı yönlendirmesi olmadan CLI'dan
- [ ] Device token + kapsam (`report:impressions`, `read:balance`) — sunucu tarafı hazır
- [ ] Cüzdan bağlama tarayıcı sayfası: SEP-10 + Freighter/LOBSTR
- [ ] Aynı sayfada sponsorlu trustline butonu (ADR-020)
- [ ] `dwell balance` — bekleyen / ödenebilir / ödenmiş + stellar.expert linkleri

**Bitti kriteri:** İki farklı makinede iki hesap, gösterimler doğru hesaba yazılıyor.

---

## 3 — Ödeme (testnet)

`payout-job` yazılı ve 23 testi var ama gerçek raya bağlı değil — şu an yalnızca mock üzerinde çalışıyor.

- [ ] `StellarRail`: `PaymentRail` arayüzünün gerçek uygulaması
- [ ] Circle testnet USDC (kendi asset'imiz değil — §8 tuzak #8)
- [ ] Doğrulama job'ı zamanlanmış çalışsın: `pending` → `verified` → defter
- [ ] Ödeme job'ı günde bir, eşiği geçenleri öde
- [ ] `payout_items` şeması: `op_index`, `envelope_xdr`, `destination_address` snapshot

**Bitti kriteri:** Testnet'te üç adrese tek işlemde ödeme, stellar.expert'te görünüyor; trustline'sız hedef batch'ten düşürülmüş ve işlem yine başarılı.

Bu, SOW'un Deliverable 3 kanıtı.

---

## 4 — Dağıtım

Şu an yalnızca bu makinede çalışıyor; `settings.json`'daki yollar mutlak.

- [ ] npm'e yayın → `npx dwell init`
- [ ] Landing sayfası: ne olduğu, iki buton, canlı örnek satır
- [ ] `/app`: GitHub girişi → cüzdan bağla → kurulum komutu

**Bitti kriteri:** Arkadaşın tek komutla kurup kazanmaya başlayabiliyor.

---

## Küçük ama biriken işler

| # | İş | Nereden |
|---|---|---|
| 1 | OSC 8 satır kurucusu — `shape` daemon'a ulaşıyor, kullanılmıyor | spinner.md §3, yarısı bitti |
| 2 | Attribution URL kısaltıcı (`/c/<token>`), uzun URL'ler `MAX_BARE_URL`'i aşıyor | spinner.md §3 |
| 3 | Zincirleme (chain-capture): mevcut statusLine'ı ezme, altına istifle | PROJECT.md §6.1, spinner.md §4 |
| 4 | Zincir bütçesi kararı: 200 ms içinde mi, opt-in mi | ADR-003 |
| 5 | `dwell pause` gerçekten duraklatsın — şu an yalnızca mesaj basıyor | main.ts'te not düşülü |
| 6 | Link–alan adı eşleşmesi: metinde yazan domain ile tıklama hedefi aynı olmalı | ADR-024 |

**İçerik politikası yazılmayacak** — reklamveren tarafı açık (ADR-024). Yalnızca 6. maddedeki bütünlük kontrolü gerekli: kullanıcı reklamda gördüğü alan adına gitmeli, başka yere değil.

---

## Talep tarafı

Sende. Bu listede yok.

---

## Şimdilik yapılmayacaklar

Bilinçli olarak ertelendi, kapsam kayması olmasın:

- Mainnet
- Tier / günlük tavan / çekim limiti (§13.1 — rakamlar M0 ölçümü sonrası)
- Reklamveren self-servis paneli
- Claude Code dışındaki araçlar (Codex, Gemini CLI, VS Code)
- Gerçek açık artırma motoru
- Tıklama attribution'ı (önce OSC 8 satır kurucusu)

---

## Açık sorular

| # | Soru | Ne zaman |
|---|---|---|
| 1 | `statusLine` boş çıktı verince satır tamamen kayboluyor mu? | Daemon'a dokunurken |
| 2 | Zincirleme bütçe içinde mi yapılabilir? | Zincirleme yazılırken |
| 3 | Anthropic bu yüzeyin paraya çevrilmesine izin veriyor mu? | **Sormak bedava, dört ay sonra öğrenmek ürünü bitirir** |
