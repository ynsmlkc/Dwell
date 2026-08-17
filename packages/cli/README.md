# dwell

AI kodlama araçlarının bekleme anlarını kazanca çevirir.

Claude Code'a bir şey sorduğunda cevabı beklerken alt satırda sponsorlu bir
satır görünür. Gösterim sayılır, kazancın Stellar üzerinden USDC olarak
ödenir.

```
npx dwellsh init
```

Kurulduktan sonra komut `dwell`.

---

## Ne yapar

```
  ✶ Firecrawl — docs to LLM-ready markdown · firecrawl.dev
```

Bu satır Claude Code'un `statusLine` alanında görünür. Yalnızca **sen bir
şey beklerken** — cevap gelince kaybolur.

Reklam gösterilmesi için tek koşul var: bekliyor olman. Boşta duran bir
terminal reklam göstermez, dolayısıyla gösterim de saymaz.

## Kurulum

```bash
npx dwellsh init          # kur ve başlat
npx dwellsh init --spinner   # üstteki "Thinking…" kelimelerini de kullan
```

Sonra yeni bir Claude Code oturumu aç.

## Kazanç

```bash
dwell login      # cüzdanını bağla — kazanç buraya gider
dwell balance    # ne kazandın
```

`dwell login` tarayıcında kendi bilgisayarında bir sayfa açar; imzayı
Freighter'da atarsın. **Özel anahtarın hiçbir zaman bu araca girmez.**

Kimliğin cüzdan adresinin kendisidir. GitHub yok, e-posta yok, şifre yok.

## Komutlar

| Komut | Ne yapar |
|---|---|
| `dwell init` | kur ve başlat |
| `dwell login` | cüzdanını bağla |
| `dwell balance` | kazancını göster |
| `dwell whoami` | bağlı cüzdanı göster |
| `dwell status` | daemon durumu |
| `dwell doctor` | kurulumu teşhis et |
| `dwell pause` / `resume` | reklamı geçici durdur |
| `dwell logout` | cüzdan bağlantısını kaldır |
| `dwell uninstall` | kaldır |

## Kaldırmak

```bash
dwell uninstall
```

Yalnızca kendi izimizi sileriz. `settings.json`'da senin kendi ayarların
varsa onlara dokunmayız — yedekten geri yükleme yapmıyoruz, çünkü yedek
alındıktan sonra yaptığın değişiklikleri geri almak, senin işini silmek
olurdu.

## Ne alıyoruz

Açık olalım — bir araç makinene bir şey kuruyorsa neyi gördüğünü bilmen
gerekir.

**Gönderdiğimiz:** gösterim kimliği, kampanya kimliği, süre, oturum kimliği,
istemci sürümü, işletim sistemi ve mimari.

**Göndermediğimiz:** dizin yolun, dosya adların, prompt'ların, kodun. Proje
ayrımı için kullanılan değer makinende üretilen bir tuzla hash'lenir; ham
yol hiçbir zaman ağa çıkmaz.

## Bilmen gerekenler

Claude Code özel bir `statusLine` tanımlıyken alt satırdaki bazı klavye
ipuçlarını göstermiyor (`esc to interrupt` gibi). Bu bizim tercihimiz değil,
Claude Code'un davranışı — ama sonucunu sen yaşıyorsun, o yüzden yazıyoruz.

`--spinner` kullanırsan üstteki "Thinking…" kelimeleri de değişir. O alan
her seferinde tek bir kelime listesi kabul ediyor; başka bir araç da
yazıyorsa biriniz diğerini eziyor.

## Durum

Testnet. Gerçek para henüz akmıyor — ödeme mekanizması çalışıyor ve Stellar
testnet'inde doğrulandı, mainnet kapsam dışı.

Sunucuya bağlı değilken `dwell` örnek reklamlar gösterir ve **hiçbir kazanç
kaydedilmez**. `dwell init` bunu söyler.

## Lisans

MIT
