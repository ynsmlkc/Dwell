# Spinner & statusLine — Rakip Teardown ve Referans İskelet

> **Kapsam.** Bu dosya PROJECT.md'nin yerine geçmez. Kararların otoritesi PROJECT.md
> ve ADR'lerdir. Burada olan şey: **kickbacks.ai'ın canlı çalışan kurulumunun
> sökülmesi** (gözlem: 2026-08-14, bu makinede kurulu haliyle) ve bundan çıkan,
> Dwell'de **henüz karşılığı olmayan** parçalar.
>
> Kickbacks aynı yüzeyi (Claude Code `statusLine` + `spinnerVerbs`) satan,
> üretimde çalışan bir rakip. Kodu okunabilir durumda olduğu için ücretsiz bir
> referans implementasyonu sayılır.

**Gözlem kaynakları**

| Ne | Nerede |
|---|---|
| Statusline script'i (9.3 KB, yorumlu) | `~/.kickbacks/vibe-ads-statusline.mjs` |
| Servis edilen reklam cache'i | `~/.kickbacks/cli-ad.json` |
| Ezilen önceki statusLine yedeği | `~/.kickbacks/cli-prev-statusline.json` |
| Telemetri / rotasyon logu | `~/.kickbacks/debug.log` |

---

## 1. Kickbacks ne yapıyor — özet

```
[extension host / daemon]            her ~60 sn
   ├─ cli-ad.json'ı yeni yaratıcıyla yaz      → statusline bunu okur
   ├─ settings.json'da spinnerVerbs'ü güncelle
   └─ metric: impression_rendered / impression_viewable / view_tick (10 sn'de bir)

[vibe-ads-statusline.mjs]            CC her render'da çağırır
   ├─ cli-ad.json oku → 10 dk tazelik kontrolü
   ├─ terminali parmak izle → OSC 8 / plain / hybrid seç
   ├─ writeSync(1, ...) ile bas
   └─ önceki statusLine'ı spawn et, çıktısını ALTINA istifle
```

Logdan doğrulanan davranış:

```
cli.spinnerVerbs {"supported":true}          ← sürüm yoklaması yapıyor
portfolio.rotated {"adId":"..."}             ← ~60 sn'de bir
clitick.end {"visibleMs":60221}              ← görünürlük süresi ölçülüyor
metric.tier_stamped {"event":"view_tick"}    ← 10 sn'de bir
heartbeat.sent {"det":true}
```

`claude-cli.applyPatch` ve `csp.patch` satırları **CLI ile ilgili değil** — Cursor /
VS Code eklenti tarafındaki webview CSP'si için (base64 ikon gösterebilmek).
Terminal tarafında hiçbir host patch'i yok. Yani ADR-002'nin "resmî uzantı
noktaları yeterli" varsayımını bağımsız bir ekip de doğrulamış.

**Bizden farklı olan tasarım tercihleri:**

| Konu | Kickbacks | Dwell |
|---|---|---|
| Tazelik | Script `ts`'e bakıp 10 dk penceresi uygular | Daemon karar verir, shim aptal |
| Ağ | Script hiç ağa çıkmaz, JSON okur | Script hiç ağa çıkmaz, unix socket |
| Bütçe | Zincir için 3000 ms sert deadline | Toplam 50 ms bütçe |
| Boşta | Taze reklam yoksa hiçbir şey basmaz | Tur dışında hiçbir şey basmaz (ADR-023) |
| Disclosure | `ad· ` öneki | `✶` glifi (disclosure zorunlu) |

Bütçe farkı bilinçli korunmalı: 3 saniye bizim için kabul edilemez, günde 13.700
çağrı var (§12.2).

---

## 2. Bulgu — `spinnerVerbs` canlı okunuyor mu?

**Çelişki var ve çözülmesi gerekiyor.**

`packages/cli/src/daemon/spinner-sync.ts` başlığındaki ölçüm (2026-08-14) diyor ki:

> Claude Code `spinnerVerbs`'ü OTURUM BAŞINDA okuyup SABİTLİYOR. Dosyayı sonradan
> değiştirmek çalışan oturumu etkilemiyor. Kanıt: dosyada `["✶ Resend"]` yazarken
> ekranda `Percolating…` görüntülendi.

Ama kickbacks `settings.json`'daki `verbs` dizisini **60 saniyede bir yeniden
yazıyor** ve bunu boşuna yapmıyor olması beklenir.

### Ölçümü geçersiz kılan güçlü bir confound var

O ölçüm sırasında bu makinede **kickbacks de aynı alana yazıyordu.** Sıra şu
olmuş olabilir:

```
t+0s    Dwell yazar:      spinnerVerbs.verbs = ["✶ Resend"]
t+~60s  Kickbacks yazar:  spinnerVerbs.verbs = ["✶ Neon — serverless Postgres"]
        (Dwell'in yazdığını ezer)
ekran   ne "Resend" ne "Neon" → ölçüm "donmuş" diye yorumlanır
```

`Percolating…` görülmesi ayrıca ilginç: bu Claude Code'un **varsayılan**
kelimelerinden biri. `mode: "replace"` düzgün uygulansaydı varsayılanlar hiç
çıkmamalıydı. Yani o an muhtemelen `spinnerVerbs` alanı geçici olarak **yoktu
veya boştu** — ki bu da yazma yarışının imzası. Dosyanın 1.3 saniyede 10 kez
install/uninstall arasında gidip geldiği yedeklerde görülüyor (§7).

### Temiz yeniden test protokolü

Sonuç faturalamayı değil ama **spinner'ın değerini** belirliyor: canlı okunuyorsa
spinner de rotasyona girer ve envanter büyür; okunmuyorsa ADR-001 aynen kalır.

1. Kickbacks'i tamamen durdur (§7) — tek yazar kalsın.
2. Yeni bir CC oturumu aç, spinner'ı gözle: X markası çıkmalı.
3. Oturum **açıkken** `settings.json`'daki `verbs`'ü Y ile değiştir.
4. Modeli uzun bir işe sok (>60 sn) ve spinner'ı izle.
   - Y çıkıyorsa → **canlı okuma var**, ADR-001 revize edilir, spinner rotasyona alınır.
   - X'te kalıyorsa → mevcut karar doğrulanmış olur, `spinner-sync.ts` başlığına
     "kickbacks confound'u elenerek yeniden doğrulandı" notu düşülür.
5. Testi CC sürüm numarasıyla birlikte kaydet — belgelenmemiş bir alan, sürümle
   değişebilir (ADR-002 riski).

> **Not:** `spinner-sync.ts`'teki "liste asla boşaltılmaz" kuralı her iki sonuçta
> da doğru kalır, dokunma.

---

## 3. Bulgu — OSC 8 kararı yanlış katmanda

Kickbacks'in en öğretici parçası bu ve **bizde mimari bir boşluğa denk geliyor.**

Tıklanabilir link OSC 8 escape dizisiyle yapılır:

```
ESC ]8;; URL ESC \   METİN   ESC ]8;; ESC \
```

Ama **her terminal desteklemiyor.** Kickbacks bunu `process.env`'den parmak izleyip
üç şekilden birini seçerek çözüyor:

| Şekil | Ne basar | Ne zaman |
|---|---|---|
| `osc8` | Temiz hyperlink | iTerm2, Kitty, WezTerm, VS Code |
| `plain` | Metin + çıplak URL (terminal kendi algılar) | tmux, Alacritty, Konsole, Apple Terminal, Warp, JetBrains |
| `hybrid` | İkisi birden — hiçbir durumda daha kötü değil | SSH, ghostty, bilinmeyen |

Öncelik sırası önemli: **`TMUX` en başta** (dış terminal ne olursa olsun tmux OSC
8'i `allow-passthrough` olmadan yutar), sonra `SSH_*` (env uzakta, tıklayan
terminal yerelde — desteği bilmek imkânsız), sonra terminale özgü değişkenler,
en sonda sızıntıya açık `WT_SESSION`.

### Bizdeki boşluk

`packages/cli/src/shim/statusline.ts` daemon'a şunu gönderiyor:

```ts
sock.write(JSON.stringify({ t: 'tick', session, columns }) + '\n')
```

Satırı **daemon kuruyor.** Ama terminalin kimliği yalnızca **shim'in** env'inde var
— shim terminalin içinde çalışır, daemon çalışmaz. Daemon şu an OSC 8 basıp
basmayacağına karar veremez; bastığı anda tmux altındaki bir kullanıcı ekranda
çöp görür.

**Düzeltme: tick payload'ına terminal ipucu ekle.** Shim'de parmak izi ucuz (saf
env okuması, ölçülebilir maliyet yok), karar daemon'da kalır:

```ts
// shim/statusline.ts — env okuması, sıfır maliyet
type Shape = 'osc8' | 'plain' | 'hybrid'

function termShape(): Shape {
  const e = process.env
  if (e['TMUX']) return 'plain'                       // en başta: OSC 8'i yutar
  if (e['SSH_TTY'] || e['SSH_CONNECTION']) return 'hybrid'
  if (e['KITTY_WINDOW_ID']) return 'osc8'
  if (e['ALACRITTY_SOCKET'] || e['ALACRITTY_WINDOW_ID']) return 'plain'
  if (e['WEZTERM_PANE']) return 'osc8'
  if (e['GHOSTTY_RESOURCES_DIR']) return 'hybrid'
  if (e['ITERM_SESSION_ID']) return 'osc8'
  if (e['KONSOLE_VERSION']) return 'plain'
  const vte = parseInt(e['VTE_VERSION'] ?? '', 10)
  if (Number.isFinite(vte)) return vte >= 5000 ? 'osc8' : 'plain'
  if ((e['TERMINAL_EMULATOR'] ?? '').includes('JediTerm')) return 'plain'
  const tp = e['TERM_PROGRAM'] ?? ''
  if (tp === 'vscode' || tp === 'iTerm.app' || tp === 'WezTerm') return 'osc8'
  if (tp === 'Apple_Terminal' || tp === 'WarpTerminal') return 'plain'
  if (tp === 'ghostty') return 'hybrid'
  if (e['WT_SESSION']) return 'osc8'
  return process.platform === 'win32' ? 'plain' : 'hybrid'
}

sock.write(JSON.stringify({ t: 'tick', session, columns, shape: termShape() }) + '\n')
```

Daemon tarafında satır kurulumu:

```ts
const ESC = '\x1b'
const osc8 = (url: string, text: string) =>
  `${ESC}]8;;${url}${ESC}\\${text}${ESC}]8;;${ESC}\\`

// Üstünde dar terminalde sarar; Warp sarılmış URL'i algılamaz → çıplak URL'i bırak
const MAX_BARE_URL = 120

function compose(text: string, url: string, shape: Shape): string {
  if (!url) return text
  const bare = url.length <= MAX_BARE_URL ? `  ${url}` : ''
  if (shape === 'osc8') return osc8(url, text)
  if (shape === 'plain') return text + bare
  return osc8(url, text) + bare        // hybrid: ikisinden de kötü değil
}
```

> **Uyarı — aktif TTY sorgusu yasak.** Terminal yeteneğini `XTVERSION` / `DA` gibi
> escape sorgularıyla öğrenmek cazip ama **yapılamaz**: cevap TTY'nin input
> stream'ine düşer ve orayı Claude Code'un TUI'si okuyor. Kullanıcının
> terminaline çöp enjekte edersin. Yalnızca pasif env okuması.

> **Not — uzun URL.** Supplier tracker URL'leri 512–2048 karakter olabiliyor ve
> `MAX_BARE_URL`'i her zaman aşar. Kickbacks bunu kendi tarafında bir
> `/c/<token>` redirect kısaltıcısıyla çözmüş. Bizde de attribution linki
> kısaltılmış olmak zorunda (§15.3 tıklama ölçümü buna bağlı).

---

## 4. Referans iskelet — zincirleme (chain-capture)

PROJECT.md §615 `dwell init`'in sorumluluğu olarak "mevcut statusLine varsa ezme,
zincirleme seçeneği sun" diyor ama implementasyon henüz yok. Kickbacks'te
çalışan hali var; **doğru yaptığı ve kolayca yanlış yapılan** kısımlar şunlar.

Fikir basit: eski `statusLine` komutunu yedekle, kendi script'inden çağır,
çıktısını **kendi satırının altına** bas. Claude Code stdout'taki her satırı
render ettiği için kullanıcının HUD'u ezilmek yerine altta istiflenir.

```js
const prev = JSON.parse(readFileSync(PREV_PATH, 'utf8')).statusLine
const cmd = prev?.type === 'command' ? prev.command : ''

// Kendini çağırma guard'ı: elle düzenlenmiş/bayat bir yedek fork bombasına döner
if (cmd && !cmd.includes('dwell')) {
  // CC session JSON'unu statusLine'ın stdin'ine pipe'lar; zincirlenen komut
  // (claude-hud vb.) onu render için ister. stdin fd'sini DOĞRUDAN devret —
  // burada readFileSync(0) yaparsan, kapatılmayan bir pipe'ta sonsuza dek blokesin.
  const stdinMode = process.stdin.isTTY ? 'ignore' : 'inherit'
  const child = spawn(cmd, { shell: true, stdio: [stdinMode, outFd, 'ignore'] })

  child.on('exit', () => { childExited = true; stableSince = Date.now() })
  child.on('error', finish)
  setTimeout(() => { child.kill(); finish() }, CHAIN_TIMEOUT_MS)   // sert deadline
}
```

**Neden `spawnSync` değil:** `spawnSync`'in timeout'u yalnızca kabuğu öldürür,
sonra torun sürecin pipe'ını okumaya devam eder — sonsuza kadar. Async `spawn` +
`process.exit()` tek güvenli kombinasyon; `exit()` açık bir pipe tarafından
rehin alınamaz.

**Neden `close` olayına güvenilmez:** stdout pipe'ını miras alan bir torun süreç
`close`'un **hiç** tetiklenmemesine yol açar ve `kill` bunu çözmez. Bu yüzden
`exit` kısa bir drain süresi başlatır, sert deadline de hiç çıkmayan kabuğu
sınırlar.

**Çıktı dosyaya alınır, pipe'a değil** — `spawn`'a `outFd` verilip boyutu
poll'lanıyor (`MAX_CHAIN_STDOUT_BYTES = 64 KB`). Pipe okumak yukarıdaki torun
problemini geri getirir.

**Bizim bütçemize uyarlama:** 3000 ms bizde kabul edilemez. Zincir bütçesi
50 ms'lik toplam bütçenin içinde kalmalı ya da kurulumda açıkça opt-in olmalı
("HUD'unuz yavaşsa satır gecikir"). Karar verilmeli — açık madde.

---

## 5. `writeSync(1, ...)` — sessiz veri kaybı tuzağı

```js
writeSync(1, s)                              // DOĞRU
// process.stdout.write(s); process.exit(0)  // YANLIŞ — çıktı kaybolur
```

`process.stdout.write` pipe üzerinde **asenkron**. `process.exit()` bekleyen
chunk'ları düşürür. Statusline her zaman bir pipe'a yazar, yani bu her seferinde
değil, **yük altında rastgele** patlar — ayıklanması en zor hata sınıfı.

`shim/statusline.ts` şu an `process.stdout.write(res.line)` ardından
`process.exit(0)` çağırıyor. Satır kısa olduğu için pipe buffer'ına sığıyor ve
pratikte çalışıyor; ama uzun bir satırda (geniş terminal + uzun URL + zincir
çıktısı) kayıp riski var. `writeSync(1, ...)`'a çevirmek maliyetsiz sigorta.

---

## 6. Sanitizasyon — bizde daha iyi, dokunma

Kickbacks kontrol karakterlerini **siliyor** (C0 + DEL + C1 aralığı):

```js
const strip = (s) => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
```

Bizim kararımız (§310, `packages/protocol/test/sanitize.test.ts`, 20 vektör)
temizlemek değil **reddetmek** ve daha doğru: kontrol karakteri içeren bir
yaratıcı özensiz girdi değil, saldırı denemesidir. Ayrıca kickbacks'in regex'i
bidi override (trojan source), sıfır genişlikli gizleme ve BOM'u **kaçırıyor** —
bunlar C0/C1 aralığında değil, normal Unicode kod noktaları.

Tek alınacak detay: OSC 8 çerçevesini basan **tek yer** satır kurucusu olmalı ve
sanitizasyon ondan **önce** çalışmalı. Aksi halde reklamverenin metnindeki bir
`ESC ]8;;` kendi linkini enjekte eder.

---

## 7. Bu makinenin mevcut durumu — Dwell şu an kurulu DEĞİL

Yeniden test etmeden önce temizlenmesi gereken durum.

**`~/.claude/settings.json` şu an kickbacks'e ait:**

```json
"spinnerVerbs": { "mode": "replace", "verbs": ["✶ Neon — serverless Postgres"] },
"statusLine": { "type": "command",
                "command": "node \"/Users/yunusmalkoc/.kickbacks/vibe-ads-statusline.mjs\"" }
```

Hiçbirinde `__dwell` işareti yok ve Dwell hook'ları dosyada yok.

**Sonuç: `SpinnerSync` sessizce devre dışı.** Guard tam olarak bunu yapıyor:

```ts
if (settings.spinnerVerbs && settings.spinnerVerbs[MARKER] !== true) return
```

Alan var ama bizim değil → `return`. Bu **doğru davranış** (kullanıcının ayarını
ezmeme kuralı), ama "spinner çalışmıyor" diye debug edilirse yanlış yere bakılır.
`dwell status` bu durumu açıkça raporlamalı: _"spinnerVerbs başka bir araca ait
(kickbacks), senkron kapalı."_ — açık madde.

**Ayrıca: yedeklerde yazma yarışı izi var.**

`~/.claude/dwell-backups/` içinde 10 yedek, hepsi **1.3 saniye içinde**
(13:24:06.656Z → 13:24:07.947Z), iki boyut arasında 5 kez gidip gelmiş:

```
1374 bayt  ←→  2387 bayt        (5 tur)
```

Diff'e göre fark tam olarak Dwell'in kurulum bloğu: `UserPromptSubmit` /
`SessionStart` / `Stop` hook'ları + `statusLine`. Yani **install → uninstall →
install → uninstall** döngüsü. Muhtemel sebep: `packages/cli/test/e2e.test.ts`
gerçek `~/.claude/settings.json`'a karşı koşuyor.

> **Eğer öyleyse bu ciddi bir hata:** testler kullanıcının gerçek Claude Code
> ayarını değiştiriyor demektir. Test suite'i `DWELL_HOME` / `SETTINGS_PATH`
> enjeksiyonuyla geçici bir dizine izole edilmeli — `settings.ts` zaten
> `readSettings(path = SETTINGS_PATH)` şeklinde parametre alıyor, altyapı hazır.
> Doğrulanacak açık madde.

### Yeniden test öncesi temizlik

```bash
# 1. Mevcut hali sakla
cp ~/.claude/settings.json ~/.claude/settings.json.before-spinner-test

# 2. Kickbacks'in ezdiği eski statusLine (orbitads) burada — geri almak istersen
cat ~/.kickbacks/cli-prev-statusline.json
```

Kickbacks'i durdurmak `settings.json`'dan iki alanı silmekle bitmez: arka planda
60 saniyede bir geri yazan bir süreç var (`portfolio.rotated`). Önce onu
kapatmak lazım, yoksa test yine kirlenir — §2'deki confound'un tekrarı olur.

---

## Açık maddeler

| # | Madde | Nereye bağlı |
|---|---|---|
| 1 | `spinnerVerbs` canlı okuma testi, kickbacks confound'u elenerek | ADR-001'i teyit veya revize eder |
| 2 | `shape` alanının tick payload'ına eklenmesi | OSC 8 tıklama ölçümü (§15.3) |
| 3 | Attribution URL kısaltıcı (`MAX_BARE_URL` 120) | §15.3 |
| 4 | Zincirleme bütçesi: 50 ms içinde mi, opt-in mi | ADR-003 |
| 5 | `writeSync(1, ...)` geçişi | — |
| 6 | `dwell status` — "alan başka araca ait" raporu | — |
| 7 | e2e testlerinin gerçek `settings.json`'a yazıp yazmadığı | **önce bu** |
