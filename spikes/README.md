# Kıvılcımlar — atılacak kod

Bu klasördeki hiçbir şey ürüne girmeyecek. Amaç tek: **omurgayı yazmadan önce iki bilinmeyeni kapatmak** (bkz. `PROJECT.md` §12.1).

Sonuçlar `PROJECT.md`'ye tablo olarak işlendikten sonra bu klasör silinir. Tek istisna: Kıvılcım 1'in ürettiği `hooks.jsonl`, anonimleştirilip test fixture'ı olarak saklanacak (§12.1 bitti kriteri) — yoksa her testte gerçek bir Claude Code oturumu açmak gerekir.

---

## Kıvılcım 2 — Stellar batch ödeme ✅ tamamlandı

```bash
cd stellar-payout && npm install && npm run spike
```

Testnet'te 4 hesap açar, 3'üne trustline verir, birine kasten vermez, sonra tek transaction'da hepsine ödeme dener.

**Ölçülen sonuç (2026-08-12, testnet):**

| İddia | Sonuç |
|---|---|
| §8 tuzak #1 — tek kötü hedef tüm batch'i öldürür | ✅ `tx_failed`, 3 masum publisher ödeme alamadı |
| `op_index` zorunlu | ✅ Suçlu ancak `operations[3] = op_no_trust`'tan bulundu |
| §8 tuzak #7 — patlayan tx de ledger'a girer | ✅ Ledger 4107913, 400 stroop ücret tahsil edildi, `successful: false` |
| ADR-006 — ücret operasyon başına, batch kazandırmaz | ✅ 4 op = 400 stroop, 3 op = 300 stroop |
| §8 tuzak #9 — hash submit öncesi bilinir | ✅ `tx.hash()` yerel hesaplanıyor; Horizon'un hata cevabına güvenmek yanlış |
| `stroopsToAmount` float'a düşmeden çalışıyor | ✅ `1500000n → "0.15"` |

`run.mjs` içindeki `stroopsToAmount` fonksiyonu **ürüne aynen taşınacak** — bu klasördeki tek kalıcı çıktı.

---

## Kıvılcım 1 — statusLine ölçümü ⏳ senin çalıştırman gerekiyor

```bash
cd statusline-probe
node install.mjs              # statusLine + hook'lar
node install.mjs --spinner    # üstüne spinnerVerbs + tips
```

Sonra **yeni bir Claude Code oturumunda** 20-30 dakika normal çalış. Uzun süren işler yaptır (büyük grep, test koşumu, çok dosyalı değişiklik) — ölçülmek istenen o bekleme pencereleri.

```bash
node analyze.mjs              # rapor
node uninstall.mjs            # geri al
```

**Güvenlik:** `install.mjs` önce zaman damgalı yedek alır, mevcut hook'ları korur (dizilere ekler), mevcut `statusLine`/`spinnerVerbs` varsa dokunmaz ve uyarır. `uninstall.mjs` yedekten birebir geri döner.

**Rapor şunları çıkarır:**

1. statusLine çağrı sıklığı ve aralık dağılımı
2. Hook envanteri — hangileri ateşleniyor, payload'da hangi alanlar var
3. Bekleme süresi histogramı → **≥10sn oranı = envanterin gerçek boyutu**
4. **statusLine beklerken yenileniyor mu** ← açık soru #1'in kesin cevabı
5. **$/geliştirici/ay projeksiyonu** ← §12.1 bitti kriteri

**Gözle bakılacaklar** (rapor bunları göremez, not al):

- Alt satırda reklam göründü mü, beklerken duruyor mu yoksa donuyor mu?
- `--spinner` ile: spinner `✶ Firecrawl…` diyor mu? Alttaki "Tip:" satırı değişti mi?
- **`settings.json` canlı okunuyor mu?** Probe çalışırken `spinnerVerbs.verbs`'ü elle değiştir — oturumu yeniden başlatmadan değişti mi? Bu, spinner katmanının rotasyona uygun olup olmadığını belirleyen tek soru.
- Footer'daki `esc to interrupt` kayboldu mu? (ekran görüntüsü al — `dwell uninstall`'ın testi buna dayanacak)
- Hook shim'i tool call'ları yavaşlattı mı? **Yavaşlattıysa bu kırmızı çizgi.**
