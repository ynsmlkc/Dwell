# Dwell — loglama / observability planı

Amaç: Dwell'de **her isteği ve her önemli olayı** görebilmek, ve bir tarama / anormal
trafik olduğunda bunu loglardan yakalayabilmek.

Bu dosya bir uygulama planıdır. Dwell'in bir Claude Code (veya kendi) session'ında
aşama aşama uygulanır. Hepsini bir anda yapma; her aşama tek başına işe yarar.

## Mevcut durum (2026-11-06 itibarıyla)

- Sunucu **Hono** + `@hono/node-server`, Node 22, esbuild ile tek dosyaya bundle
  ediliyor (`packages/server/build.mjs` → `dist/server.mjs`).
- Uygulama `createApp(deps)` içinde kuruluyor: `packages/server/src/http/app.ts:121`.
- Zaten global bir middleware var (protokol başlığı): `app.use('*', ...)` ≈ `app.ts:125`.
- Hata yakalayıcı: `app.onError(...)` ≈ `app.ts:792`, tek yaptığı `console.error('[dwell]', e)`.
- **Her istek loglanMIYOR.** Yani şu an bir tarama, hata üretmediği sürece loglarda görünmez.
- Dağıtım: Railway, Dockerfile ile, healthcheck `/health`.

## Uygulama durumu (2026-11-06)

Aşama 1 ve Aşama 2'nin amacı, aşağıdaki plandan farklı bir yolla yapıldı:

- **`hono/logger` kullanılmadı.** Gelen URL'yi sorgu dizesiyle birlikte olduğu gibi yazıyor
  (`/v1/pools/HACK-7F3A2C` gibi yollardaki katılım kodu, `?…` parametreleri) ve IP yazmıyor.
  Yerine `app.ts`'te kendi middleware'imiz var (`AppDeps.accessLog`), istek başına tek JSON satırı:
  `{t, m, route, status, ms, ip, ua}`.
  - `route` rota **kalıbı**dır (`/v1/pools/:code`), gerçek değer değil. Sorgu dizesi ve
    başlıklar yazılmaz.
  - `ip` ham IP değil, fraud kontrolleriyle aynı tuzlu hash'in ilk 12 karakteri. Gizlilik
    sayfası "ham IP hiçbir yere yazılmaz" diyor; log da bir depo. Aynı IP hep aynı hash'i
    verdiği için "tek IP'den patlama" yine aranabilir.
  - Ham `path` yalnızca hiçbir rotaya uymayan isteklerde yazılır (sorgusuz, 120 karakter):
    `/.env`, `/wp-login.php` gibi taramalar burada görünür.
  - `DWELL_ACCESS_LOG=0` ile kapanır.
- **pino eklenmedi.** Erişim satırları zaten JSON; sunucunun olay satırları (`main.ts`'teki
  `log()`) da `{t, msg}` JSON'una çevrildi, hata yakalayıcı da tek JSON satırı yazıyor.
  Yeni bağımlılık ve bundle riski yok.
- **İş olayları ayrı satır değil, aynı satırın `evt` alanı** (Aşama 2 / 4. madde). Bir istek =
  bir satır, arama tek yerden:
  - `/v1/impressions`: `{accepted, duplicates, rejected: {sebep: adet}}`
  - para çekme (yayıncı, reklamveren, platform): `{withdraw, amount, tx}` ya da `{withdraw, failed}`
  - yetki reddi: `{auth: 'missing' | 'unknown' | 'revoked' | 'scope' | 'admin'}`
  - Cüzdan adresi yazılmaz: IP hash'iyle aynı satırda kimliği IP'ye bağlardı. `tx` zaten
    zincirde herkese açık.
- Testler: `packages/server/test/access-log.test.ts` (token, sorgu, havuz kodu, ham IP ve cüzdan
  adresi loga girmiyor; 404 yolu, User-Agent ve olay alanları yazılıyor).

Örnek satır:
```json
{"t":"2026-11-06T20:03:00.000Z","m":"POST","route":"/v1/impressions","status":200,"ms":4,"ip":"9f2c41a07b3e","ua":"dwell/0.1.19","evt":{"accepted":2,"duplicates":0}}
```

**Aşama 3-4 hesap istiyor:** Axiom ya da Better Stack hesabı açılıp Railway'e bağlanınca
yukarıdaki satırlar orada aranabilir olur. Tarama alarmları (`route:null` + 404 patlaması,
`ua` içinde `sqlmap`/`nuclei`) o panelde kurulur; kodda değişiklik gerekmez.

**Aşağıdaki planda düzeltilmesi gerekenler:**
- Repo `npm` değil `pnpm` kullanıyor: `pnpm --filter @dwell/server build`. Sunucu Docker'da Node 24.
- Railway'in resmi dokümanına göre Hobby planda loglar 7 gün görülebiliyor ("son ~500 satır"
  değil). Ayrıca saniyede replika başına 500 satır sınırı var.
- Railway'in dokümanında yerleşik bir "Log Drains" ayarı bulunamadı. Aşama 3 için ya Railway'in
  log iletme şablonları ya da log aracının kendi Railway entegrasyonu araştırılmalı.

## En önemli kural: gizli veri loglanmaz

Dwell gizliliğe dikkatli yazılmış (stack trace dışarı çıkmıyor, `/health` kullanıcı
sayısı sızdırmıyor). Loglama bunu BOZMAMALI. Asla loglanmayacaklar:

- `Authorization` başlığı / bearer token (tam değeri). En fazla "var/yok" ya da ilk 6 karakter.
- Cüzdan secret'ı, imza XDR'ı gibi hassas gövde alanları.
- İstek gövdesinin tamamı. Gerekiyorsa sadece boyutu (`content-length`) loglanır.

Her aşamada bu redaksiyon korunur.

---

## Aşama 1 — Her isteğin erişim logu (önce bu)

Tek başına işin %80'ini çözer: method, path, status, süre Railway Deploy Logs'a düşer.

1. `packages/server/package.json` bağımlılıklarına bir şey EKLEME gerekmez — `hono/logger`
   zaten `hono` paketinin içinde gelir.
2. `packages/server/src/http/app.ts` içinde, `createApp` fonksiyonunda, mevcut
   `app.use('*', ...)` (protokol başlığı, ≈125. satır) bloğunun hemen ÜSTÜNE,
   `const app = new Hono...` satırından sonra şunu ekle:

   ```ts
   import { logger } from 'hono/logger'   // dosyanın en üstündeki importlara
   ```
   ```ts
   // her istek: method, path, status, süre. hono/logger token/gövde yazmaz.
   app.use('*', logger())
   ```

3. Doğrula: `npm run build -w @dwell/server` sonra `npm run dev -w @dwell/server`,
   başka bir terminalden `curl localhost:PORT/health` → terminalde `<-- GET /health`
   ve `--> GET /health 200` satırlarını gör.
4. Commit (İngilizce, repo kuralı): `feat(server): request access logging via hono/logger`.
5. Railway'e push → **Railway paneli → Dwell servisi → Deploy Logs**'ta canlı gör.

> Not: `hono/logger` Authorization başlığını veya gövdeyi yazmaz, o yüzden Aşama 1
> redaksiyon açısından güvenli.

## Aşama 2 — Yapılandırılmış log (pino) + olay logları

Erişim satırı "ne zaman ne geldi"yi verir; bu aşama "içeride ne oldu"yu (ödeme doğrulandı,
kampanya gösterildi, token reddedildi) aranabilir JSON olarak verir.

1. Bağımlılık ekle: `npm i pino -w @dwell/server`.
   - **Bundle uyarısı:** `pino-pretty` ve pino "transport"ları worker thread kullanır,
     esbuild bundle'ında sorun çıkarır. Bu yüzden transport KULLANMA. Düz pino, JSON'u
     doğrudan stdout'a yazar ve bundle'a temiz girer. Pretty çıktı istiyorsan sadece
     lokalde `node dist/server.mjs | npx pino-pretty` şeklinde pipe et.
2. `packages/server/src/http/` altında küçük bir `log.ts` oluştur:

   ```ts
   import pino from 'pino'
   export const log = pino({
     level: process.env.LOG_LEVEL ?? 'info',
     // token, secret, imza gibi alanları otomatik gizle:
     redact: {
       paths: ['req.headers.authorization', '*.token', '*.secret', '*.xdr', '*.signedTransaction'],
       censor: '[gizli]',
     },
   })
   ```

3. Hata yakalayıcıyı (`app.onError`, ≈`app.ts:792`) `console.error('[dwell]', e)` yerine
   `log.error({ err: e, path: c.req.path }, 'istek hatası')` yap.
4. Önemli iş adımlarına `log.info({...}, 'mesaj')` ekle (başlangıç için birkaç tanesi yeter):
   - impression kaydedildi (`/v1/impressions`)
   - ödeme/çekim yapıldı (`/v1/publisher/withdraw`, `/v1/advertiser/withdraw`)
   - token reddi / yetki hatası (`requireScope` içindeki 401/403 dalları)
5. Commit: `feat(server): structured logging with pino and redaction`.

## Aşama 3 — Kalıcı, aranabilir arşiv (log drain)

Railway log'u yalnızca son ~500 satırı canlı tutar, geçmişe dönük arama yoktur.
"Dün gece şu IP ne yaptı"yı istiyorsan log'u dışarı akıtman gerekir.

- Önerilen (küçük proje, cömert ücretsiz katman): **Axiom** veya **Better Stack (Logtail)**.
- Kurulum uygulama kodunu DEĞİŞTİRMEZ: Railway → servis → **Settings → Log Drains / Integrations**
  üzerinden hedefi bağlarsın, Railway stdout'u oraya iletir.
- Bağlandıktan sonra o panelde tarih / IP / path / status'e göre arama, grafik ve alarm kurarsın
  (ör. "1 dakikada 50'den fazla 404" → tarama alarmı).

## Aşama 4 — Taramayı yakalama (opsiyonel, Aşama 3 sonrası)

Drain'de şu sorgularla tarama/anormal trafik aranır:
- Kısa sürede çok sayıda `404` (olmayan uçlara bakan tarayıcılar).
- Tek IP'den ani istek patlaması.
- Bilindik tarama yollarına istek: `/.env`, `/admin`, `/wp-login`, `/.git`.
- `User-Agent` içinde `nuclei`, `zgrab`, `sqlmap`, `masscan` gibi imzalar.

Bu sorgulardan birine alarm bağlarsan, biri Dwell'i taradığında e-posta/bildirim gelir.

---

## Özet sıralama

1. Aşama 1 (`hono/logger`) — hemen, 1 commit, her isteği gör.
2. Aşama 2 (`pino` + redaksiyon) — iş olaylarını JSON olarak gör.
3. Aşama 3 (Axiom/Better Stack drain) — kalıcı arşiv + arama.
4. Aşama 4 — tarama alarmları.

Her aşamadan sonra Railway Deploy Logs'ta çıktıyı gözle doğrula. Gizli veri
(token/secret/XDR) hiçbir aşamada log'a girmemeli — her commit'te buna bak.
