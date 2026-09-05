# Dwell Vault

Reklamveren emanet kasası — Soroban kontratı. `PROJECT.md` ADR-006/ADR-021
revizyonu, `PROBLEMS.md` §15.4/§15.10'a cevap.

## Neden

Bugün reklamverenin USDC'si tek bir opak sıcak cüzdanda (`DWELL_HOT_SECRET`)
toplanıyor; "kimin ne kadar hakkı var" bilgisi yalnızca Dwell'in kendi
veritabanında yazılı, zincirde doğrulanamıyor. Bu kontrat reklamveren
bazında bir bakiye tutuyor — herkes `balance(advertiser)` ile zincirde
sorgulayabiliyor, Dwell'in veritabanına güvenmeden.

## Fonksiyonlar

| Fonksiyon | Kim çağırır | Ne yapar |
|---|---|---|
| `deposit(advertiser, amount)` | reklamveren | kendi USDC'sini kasaya yatırır |
| `release(advertiser, publisher, amount)` | yalnızca admin | `amount`'u **kendi içinde böler**: `publisher_bps` payı yayıncıya, kalanı (yuvarlama artığı dahil) platforma — aynı çağrıda, iki ayrı transfer |
| `withdraw(advertiser, amount)` | reklamveren | harcanmamış bakiyesini **platformdan izin istemeden** geri alır |
| `balance(advertiser)` | herkes | zincirde doğrulanabilir bakiye |

**Constructor:** `(admin, token, platform, publisher_bps)` — `publisher_bps` deploy
anında sabitlenir, sonradan **değiştirilemez** (ADR-011: "reklamveren payı
pazarlık edemez" kuralının aynısı, burada bir admin çağrısıyla bile bozulamaz
hale getirildi).

**Platform payı artık otomatik ödeniyor — ayrı bir "çek" akışına gerek yok.**
Eski hot-wallet sisteminde platformun %50 payı `PLATFORM_REVENUE` diye bir
ledger hesabında birikiyordu ve onu **çekecek hiçbir kod yoktu** (denetimde
bulundu — bkz. proje geçmişi). Vault'ta bu payı her `release` çağrısında
anında platformun kendi cüzdanına düşüyor; biriken bir bakiye, dolayısıyla
çekilecek bir şey yok.

**Neyin değişmediği:** `release`'i çağıran `admin` hâlâ sunucuda duran
sıcak bir anahtar — bu kontrat imza-custody riskini sıfırlamıyor, hesap
sorulabilirliği kazandırıyor.

## Geliştirme

```bash
# Homebrew rustc PATH'te rustup'ın onune geciyorsa wasm32v1-none bulunamaz —
# bu yuzden ~/.cargo/bin PATH'te ONCE olmali (bkz. asagidaki not).
export PATH="$HOME/.cargo/bin:$PATH"

cd contracts/vault/contracts/vault
cargo test              # 12 unit test — split, yuvarlama, solvency invariant dahil
stellar contract build  # -> target/wasm32v1-none/release/dwell_vault.wasm
```

**PATH notu:** Bu makinede Homebrew'un kendi `rustc`'si (`/opt/homebrew/bin`)
PATH'te rustup'tan (`~/.cargo/bin`) önce geliyor ve `wasm32v1-none` hedefini
tanımıyor — `stellar contract build` bu yüzden `can't find crate for core`
hatası verir. Kalıcı çözüm: shell profilinde (`.zshrc`) `~/.cargo/bin`'i
PATH'e Homebrew'dan önce ekle.

## Testnet deploy + canlı kanıt

`node demo.mjs` — tek kullanımlık test hesapları üretir (proje faucet
anahtarına dokunmaz), kendi test asset'ini basar (`VAULTT`, Circle'ın
testnet USDC'si otomatik alınamadığı için — `NEXT.md` §3'teki aynı
gerekçe), SAC sarmalayıcısını deploy eder, kontratı `platform` + `%50`
`publisher_bps` ile deploy eder, gerçek bir `deposit → release` akışı
çalıştırır ve payın otomatik bölündüğünü zincirden doğrular.

Son gerçek testnet kanıtı — otomatik %50/%50 bölünmeyle (2026-09-05):

- Kontrat: `CBCB4BKEVIK6VY3I3JRJHBHXIXJE4WJHPAQAM7M6KPP33BCH6IPEQ4HI`
- Deposit tx: `88dc8e3f309a988ed4d9029133b417a56076d64da2666cf8d2c2c39422c73d74`
- Release tx: `36672f9db021d64939518d2fe372a654b72cdf6590f3b1de72e02b9393103beb`
- Sonuç: 15 VAULTT release edildi → yayıncı 7.5, platform 7.5 aldı (`%50`/`%50`, tek çağrıda)

Testnet çeyreklik olarak resetleniyor (bkz. stellar-dev:smart-contracts
skill) — bu adresler o zaman geçersiz olur, `demo.mjs` yeniden çalıştırılır.

## Henüz yapılmayan

TS tarafı entegrasyonu (`packages/payments`'a `VaultRail`, `main.ts`'e
config flag'li kablolama) ayrı bir iş — bu kontrat şu an mevcut hot-wallet
akışının yanında, bağımsız duruyor.
