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

## 1 — Sunucu bağlantısı ✅ bitti (2026-08-15)

- [x] `packages/server/src/main.ts` + `pnpm dev` — bellekte defter, üç kampanya, doğrulama job'ı
- [x] Daemon HTTP istemcisi: reklam prefetch, kuyruk boşaltma, config polling
- [x] Ağ yokken önbellekten servis, kuyruk büyümeye devam

Doğrulandı:

```
1. SUNUCU AÇIK    gösterim gitti → sunucu bakiyesi arttı
2. SUNUCU KAPALI  reklam önbellekten geldi, kuyruk 1→3 büyüdü, hata gösterilmedi
3. SUNUCU DÖNDÜ   kuyruk boşaldı, 3/3 işaretlendi
```

Yolda çıkan iki düzeltme: `EPIPE` gürültüsü (shim cevabını alıp soketi kapatıyor,
sunucunun yazma denemesi hata sayılıyordu) ve kapanışta makinede asılı kalan
gösterimin diske alınması (terminal tur biter bitmez kapanırsa o gösterim
kayboluyordu).

**Kalan:** publisher kimliği. Şu an tek bir geliştirme token'ı var, gösterimler
sabit bir hesaba yazılıyor. Sıradaki madde bunu çözüyor.

---

## 2 — Kimlik ve cüzdan ◐ büyük kısmı bitti (2026-08-15)

Kimlik **cüzdandır** (ADR-010 revizyonu). GitHub yok: `publisherId` doğrudan
Stellar adresinin kendisi.

- [x] `dwell login` — 127.0.0.1'de tek kullanımlık sayfa, Freighter ile imza
- [x] `/v1/auth/challenge` + `/v1/auth/verify` — SEP-10, tek kullanımlık, multisig eşiği
- [x] Device token + kapsam (`report:impressions`, `read:balance`)
- [x] `~/.dwell/credentials.json` 0600 · `dwell whoami` · `dwell logout`
- [x] Daemon kimliği dosyadan okuyor
- [ ] Sponsorlu trustline butonu (ADR-020)
- [ ] `dwell balance` — bekleyen / ödenebilir / ödenmiş + stellar.expert linkleri
- [ ] Token iptal ucu — `logout` şu an yalnızca yerel dosyayı siliyor

Gerçek testnet'e karşı doğrulandı (friendbot'la fonlanmış hesap, Horizon'dan
signer okuma dahil):

```
challenge → Freighter imzası → verify → token
token ile /v1/ads/next 200 · /v1/me/balance 200 · publisherId = adres
REPLAY (aynı imza ikinci kez)        → 401
SAHTE İMZA (başkasının adresi)       → 401
```

Yolda kapatılan bir açık: `verify` içinde Horizon hatası yutulup master key'e
düşülüyordu. Master ağırlığı 0'a çekilmiş multisig bir hesapta bu, atılmış bir
anahtarla giriş demekti — "hesap yok" ile "göremiyorum" aynı sayılamaz. Artık
zincire ulaşılamıyorsa giriş başarısız oluyor; girişi tekrarlamak bedava,
yanlış kimlik bağlamak geri alınamaz.

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
