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
- [x] `dwell balance` — bekleyen / ödenebilir / yolda + stellar.expert linkleri
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

## 3 — Ödeme (testnet) ◐ ray bağlandı (2026-08-15)

`StellarRail` yazıldı ve **gerçek testnet'te para gönderdi**. SOW Teslim 3'ün
bitti kriteri karşılandı:

```
https://stellar.expert/explorer/testnet/tx/927959207ac20892ee189c86ef26c0f1f00b70a15c18156f53451572ec038b62

başarılı  true          ledger 4152729
op sayısı 2             ücret 200 stroop        memo it-R40HARXW00
  → GCMZNNFR…MEC3   2.5000000
  → GAHP3W44…CORM   1.3500000
  → carol           DÜŞÜRÜLDÜ (trustline yok)
```

- [x] `StellarRail`: `PaymentRail`'in gerçek uygulaması
- [x] Trustline / yetki / SEP-29 memo kontrolü zincirden okunuyor
- [x] Harcanabilir XLM ayrı hesaplanıyor (min bakiye + satış yükümlülükleri düşülmüş)
- [x] Retry aynı byte'ları gönderiyor — ikinci ödeme oluşmuyor (kanıtlandı)
- [x] `successful === true` dışında hiçbir şey "ödendi" sayılmıyor (kanıtlandı)
- [x] Ödeme job'ı zamanlanmış çalışıyor (`schedulePayouts`, turlar üst üste binmiyor)
- [x] `payout_items`: `op_index`, `envelope_xdr`, `destination_address` snapshot
- [x] Yeniden başlatmada askıda kalan batch zincire sorulup çözülüyor
- [ ] Circle testnet USDC — faucet elle dolduruluyor, testte kendi varlığımız

**Yolda bulunan sıra hatası.** `PaymentRail` tek bir `submitBatch` çağrısıydı:
zarfı kurup gönderiyordu. Bu yüzden defter ancak gönderimden *sonra*
yazılabiliyordu ve arada düşen bir sunucu, parayı zincirde gönderilmiş ama
defterde hâlâ ödenebilir bırakırdı — aynı para ikinci kez ödenirdi.

Arayüz `prepare` + `send` olarak ayrıldı. Artık hash gönderimden önce
biliniyor, defter önce yazılıyor. En kötü ihtimalle para "yolda" askıda kalır;
bu geri alınabilir ve `resumeUnresolved` onu çözüyor.

Varlık notu: entegrasyon testi `TSTUSD` basıyor çünkü Circle'ın testnet
USDC'si otomatik alınamıyor. Kanıtlanan mekanizma aynı; hangi varlık olduğu
yalnızca config meselesi (`TESTNET_USDC` sabiti hazır).

Test: `pnpm --filter @dwell/payments test:testnet` (ağ ister, varsayılanda atlanır)

---

## 4 — Dağıtım ◐ paket hazır, yayınlanmadı

Paket adı **`dwellsh`** — npm'de `dwell` dolu (2015'ten kalma alakasız bir
modül). Kurulduktan sonra komut yine `dwell`.

- [x] `package.json` yayına hazır: `files`, `bin`, `engines`, `prepack`
- [x] `@dwell/protocol` `devDependencies`'e alındı — bundle'a gömülüyor
- [x] README (npm sayfası)
- [x] Temiz makinede tarball kurulumu doğrulandı: init → reklam → uninstall
- [x] Giriş yapılmamışken `init` "demo modu, kazanç yok" diyor
- [x] `npm publish` — yayında
- [ ] Landing sayfası — **sende**

**Yolda bulunan iki hata.** İkisi de ancak gerçekten kurmayı deneyince çıktı:

1. `@dwell/protocol` `dependencies`'teydi. Yayınlanan pakette `workspace:*`
   yazıyordu, npm'de öyle bir paket yok, kurulum daha başlarken patlıyordu:
   `npm error Unsupported URL Type "workspace:"`.

2. Uzun ev dizinlerinde daemon hiç başlamıyordu. Unix soket yolu `sun_path`
   sınırını (macOS 104, Linux 108 **byte**) aşınca `listen` hata vermiyor —
   yolu sessizce kesiyor. Sonra `chmod` dosyayı bulamayıp ham bir `ENOENT`
   stack trace'i basıyor. Artık sınır aşılırsa `tmpdir` altında kısa ve
   deterministik bir yola düşülüyor (shim ile daemon aynı yolu bağımsız
   hesaplamak zorunda). Türkçe karakterli kullanıcı adları bu sınıra iki kat
   hızlı yaklaşıyor — sınır karakter değil byte.

**Bitti kriteri:** Arkadaşın tek komutla kurup kazanmaya başlayabiliyor.
Kurulum tarafı tamam; kazanç tarafı sunucu bekliyor (madde 5).

---

## 6 — Uçtan uca para akışı ✅ (2026-08-17)

Reklamverenin cebinden yayıncının cüzdanına, tek elle müdahale olmadan:

```
reklamveren cüzdanla giriş yaptı
15 USDC kasaya gönderdi          → izleyici gördü, deftere yazdı
iki kampanya oluşturdu, yayına aldı
yayıncı cüzdanla giriş yaptı     → cüzdanı otomatik bağlandı
22 gösterim                       → doğrulandı → $1.32 ödenebilir
eşik ($1) aşıldı                  → ödeme turu çalıştı

💸 https://stellar.expert/explorer/testnet/tx/b54a5980b1e66d742099dc3946bc9542909bcc22b1cf19d05353eb561f61e6a0
   1.3200000 USDC · başarılı · ledger 4188711
   yayıncının cüzdanındaki bakiye: 1.3200000 USDC
```

Yolda iki şey kanıtlandı:

**Bütçe bitince reklam duruyor.** İlk denemede CPM'i gerçekçi olmayan bir
seviyeye ($200/1000) koymuştum; $5 bütçe 25 gösterimde bitti ve sistem
sunmayı bıraktı. Doğru davranış.

**Parayı alamayacak hesaba ödeme yapılmıyor.** USDC trustline'ı olmayan bir
yayıncı eşiği aştı ama ödeme çıkmadı — parası defterde duruyor, kaybolmadı.
Trustline eklenince ödeniyor. (ADR-020'deki sponsorlu trustline butonu tam
bu yüzden gerekli.)

**Yolda bulunan hata:** girişte cüzdan `WalletStore`'a bağlanmıyordu, yani
ödeme işi HERKESİ "cüzdan bağlı değil" diye atlıyordu. Hiçbir hata
görünmüyor, sadece para hiç gitmiyordu.

---

## 5 — Sunucu ✅ canlı (2026-08-17)

```
https://dwellserver-production.up.railway.app
```

Railway, Dockerfile ile derleniyor, SQLite bir Volume üzerinde.

- [x] Deploy — Railway, iki aşamalı Docker imajı (~50 MB)
- [x] `/health`, temiz kapanış (SIGTERM'de ödeme turu durur)
- [x] Kalıcı depolama — SQLite, `/data/dwell.db`
- [x] `DWELL_HOT_SECRET` + sıcak cüzdan — **ödeme açık**

Gerçek dağıtımda uçtan uca doğrulandı:

```
giriş (SEP-10)  → token, publisherId = cüzdan adresi
3 gösterim      → kabul
45 sn sonra     → bekleyen 0 · ödenebilir 425.000
REDEPLOY
eski token      → hâlâ geçerli, yeniden giriş gerekmedi
ödenebilir      → 425.000 (birebir aynı)
yeni gösterim   → 575.000 (üstüne biniyor, sıfırlanmıyor)
aynı gösterim   → yinelenen olarak reddedildi
```

Deploy sırasında çıkan ve düzeltilen hatalar `git log`'da: bundle'ın ESM'de
hiç açılmaması, üretimde oluşan geliştirme token'ı, her yeniden başlatmada
değişen SEP-10 anahtarı, Railway'in enjekte ettiği `PORT`, root'a ait
bağlanan Volume.

---

## 7 — Reklamveren para çekme ✅ (2026-08-17)

Denetimde çıktı: para giriyordu, çıkmıyordu. `POST /v1/advertiser/withdraw`
ve panelde çekme kutusu eklendi. Ödeme makinesinin aynısını kullanıyor —
ayrı bir akış, test edilmiş mantığın daha az bakımlı bir kopyası olurdu.

Gerçek testnet'te doğrulandı:

```
2 USDC yatırıldı            → defterde $2, cüzdan 0
$9,90 çekmeyi dene          → 400 (bakiye yetmiyor)
$0,00001 çekmeyi dene       → 400 (eşiğin altı)
$1,50 çek                   → 200 · cüzdan 1.5 USDC · defterde $0,50
   tx 254163c2519ae86d8254792daebf0db81024a2f957b1b5f7cdc38c7c122dd3a4

9 reklam teslim edildi, raporlanmadı
çekilebilir $0,50 → $0,32   (rezerve $0,18)
tüm bakiyeyi çekmeyi dene   → 400 REDDEDİLDİ
```

Son satır en önemlisi: gösterilmiş ama henüz raporlanmamış reklamların
karşılığı çekilemiyor. Çekilebilseydi reklamveren reklamını gösterttirip
parasını geri alır, yayıncı karşılığını alamazdı.

---

## Küçük ama biriken işler

| # | İş | Nereden |
|---|---|---|
| 1 | OSC 8 satır kurucusu — `shape` daemon'a ulaşıyor, kullanılmıyor | spinner.md §3, yarısı bitti |
| 2 | Attribution URL kısaltıcı (`/c/<token>`), uzun URL'ler `MAX_BARE_URL`'i aşıyor | spinner.md §3 |
| 3 | Zincirleme (chain-capture): mevcut statusLine'ı ezme, altına istifle | PROJECT.md §6.1, spinner.md §4 |
| 4 | Zincir bütçesi kararı: 200 ms içinde mi, opt-in mi | ADR-003 |
| 5 | ~~`dwell pause` gerçekten duraklatsın~~ ✅ 2026-08-17 — diske yazılıyor, yeniden başlatmada sürüyor | denetim |
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
