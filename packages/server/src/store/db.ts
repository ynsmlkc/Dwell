/**
 * Kalici depolama — SQLite.
 *
 * Neden SQLite, Postgres degil: veri hacmimiz kilobayt mertebesinde ve ayri
 * bir veritabani servisi baglanti dizesi, kimlik bilgisi ve bir ag atlamasi
 * daha demek. `node:sqlite` Node'un icinde geliyor, sifir bagimlilik.
 * Buyudugunde degisir; arayuzler zaten soyut.
 *
 * TASARIM: yaz-gec (write-through).
 *
 * Mevcut depolar `Map` tabanli ve siki test edilmis. Onlari SQL sorgulariyla
 * yeniden yazmak, calisan mantigi yeni bir hata sinifina acmak olurdu. Onun
 * yerine:
 *
 *   • okuma  → bellekten, hic degismedi
 *   • yazma  → hem bellege hem diske
 *   • acilis → disk bellege yuklenir
 *
 * Bedeli: tum veri bellege sigmak zorunda. Bu olcekte sorun degil ve
 * sigmadigi gun gercek sorgulara gecilir.
 *
 * PARA METIN OLARAK SAKLANIYOR. SQLite'in INTEGER'i 64 bit ama JS tarafinda
 * `number`'a dusme riski var ve 2^53 ustunde sessizce yuvarlanir. Stroop
 * degerleri ondalıksiz tam sayi metni olarak yaziliyor; okurken `BigInt`'e
 * cevriliyor. Bir kurusun bile yuvarlanmamasi gerekiyor.
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type Db = DatabaseSync

/** Bellekte calistir — testler ve diskin olmadigi durumlar icin. */
export const MEMORY = ':memory:'

export function openDb(path: string): Db {
  if (path !== MEMORY) mkdirSync(dirname(path), { recursive: true })

  const db = new DatabaseSync(path)

  // WAL: okuma ve yazma birbirini bloklamaz. Ayrica surec cokerse veritabani
  // bozulmaz — yarim kalan islem geri alinir.
  db.exec('PRAGMA journal_mode = WAL')
  // NORMAL: her yazmada diske fsync YOK, ama checkpoint'te var. FULL'e gore
  // cok daha hizli; kayip riski yalnizca isletim sistemi cokerse ve o durumda
  // son birkac islem gider. Bizim icin kabul edilebilir; para zaten zincirde.
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA foreign_keys = ON')

  migrate(db)
  return db
}

/**
 * Sema.
 *
 * `IF NOT EXISTS` ile idempotent: her acilista calisir, varsa dokunmaz.
 * Gercek bir migration sistemi degil ve simdilik gerekmiyor — sema
 * degistiginde buraya `ALTER TABLE` eklenir.
 */
function migrate(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ledger_entries (
      id               TEXT PRIMARY KEY,
      account_id       TEXT NOT NULL,
      amount           TEXT NOT NULL,
      asset            TEXT NOT NULL,
      type             TEXT NOT NULL,
      ref_type         TEXT NOT NULL,
      ref_id           TEXT NOT NULL,
      -- Cifte kayit burada korunuyor: ayni idempotency anahtari iki kez
      -- yazilamaz. Bellek katmani da kontrol ediyor ama son soz burada,
      -- cunku surec yeniden baslasa bile bu kisit duruyor.
      idempotency_key  TEXT NOT NULL UNIQUE,
      created_at       INTEGER NOT NULL,
      campaign_id      TEXT,
      publisher_id     TEXT,
      rate_stroops     TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_entries_ref     ON ledger_entries (ref_type, ref_id);
    CREATE INDEX IF NOT EXISTS ix_entries_account ON ledger_entries (account_id, asset);

    CREATE TABLE IF NOT EXISTS tokens (
      id             TEXT PRIMARY KEY,
      publisher_id   TEXT NOT NULL,
      token_hash     TEXT NOT NULL UNIQUE,
      scopes         TEXT NOT NULL,
      client_version TEXT,
      revoked_at     INTEGER,
      last_seen_at   INTEGER
    );
    CREATE INDEX IF NOT EXISTS ix_tokens_publisher ON tokens (publisher_id);

    CREATE TABLE IF NOT EXISTS wallets (
      publisher_id     TEXT PRIMARY KEY,
      address          TEXT NOT NULL,
      network          TEXT NOT NULL,
      verified_at      INTEGER NOT NULL,
      hold_until       INTEGER,
      previous_address TEXT
    );

    CREATE TABLE IF NOT EXISTS payout_items (
      batch_id            TEXT NOT NULL,
      publisher_id        TEXT NOT NULL,
      destination_address TEXT NOT NULL,
      amount              TEXT NOT NULL,
      op_index            INTEGER NOT NULL,
      tx_hash             TEXT NOT NULL,
      envelope_xdr        TEXT NOT NULL,
      source_seq          TEXT NOT NULL,
      max_time            INTEGER NOT NULL,
      state               TEXT NOT NULL,
      submitted_at        INTEGER NOT NULL,
      settled_at          INTEGER,
      failure_reason      TEXT,
      PRIMARY KEY (batch_id, publisher_id)
    );
    CREATE INDEX IF NOT EXISTS ix_payouts_publisher ON payout_items (publisher_id);
    CREATE INDEX IF NOT EXISTS ix_payouts_state     ON payout_items (state);

    CREATE TABLE IF NOT EXISTS impressions (
      publisher_id   TEXT NOT NULL,
      id             TEXT NOT NULL,
      campaign_id    TEXT NOT NULL,
      advertiser_id  TEXT NOT NULL,
      session_id     TEXT NOT NULL,
      nonce          TEXT NOT NULL,
      duration_ms    INTEGER NOT NULL,
      rate_stroops   TEXT NOT NULL,
      rev_share_bps  INTEGER NOT NULL,
      client_ts      INTEGER NOT NULL,
      server_ts      INTEGER NOT NULL,
      project_key    TEXT NOT NULL,
      client_version TEXT NOT NULL,
      ip_hash        TEXT,
      state          TEXT NOT NULL,
      reject_reason  TEXT,
      -- Tekillik BURADA kuruluyor: gosterim kimligi ISTEMCIDEN geliyor, yani
      -- dusman girdisi. Iki publisher ayni ULID'i uretebilir ve bu bir hata
      -- degil; ayni publisher ayni ULID'i iki kez gonderirse hatadir.
      PRIMARY KEY (publisher_id, id)
    );
    CREATE INDEX IF NOT EXISTS ix_impressions_state ON impressions (state);

    CREATE TABLE IF NOT EXISTS campaigns (
      id             TEXT PRIMARY KEY,
      advertiser_id  TEXT NOT NULL,
      bid_cpm        TEXT NOT NULL,
      rev_share_bps  INTEGER NOT NULL,
      brand          TEXT NOT NULL,
      text           TEXT NOT NULL,
      cta            TEXT NOT NULL,
      status         TEXT NOT NULL,
      frequency_cap  INTEGER NOT NULL,
      created_at     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_campaigns_advertiser ON campaigns (advertiser_id);
    CREATE INDEX IF NOT EXISTS ix_campaigns_status     ON campaigns (status);

    -- Kucuk anahtar/deger. Su an yalnizca zincir tarama cursor'u.
    CREATE TABLE IF NOT EXISTS kv (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Sunulan reklamlar. Bir gosterim ancak burada karsiligi olan bir nonce
    -- ile kabul edilir.
    --
    -- Kalici olmasi sart: sunucu yeniden baslarsa, o sirada ekranda duran
    -- reklamlarin gosterimleri "bilinmeyen nonce" diye reddedilirdi.
    -- Istemci reddedileni kuyrugundan siliyor, yani o kazanc SESSIZCE
    -- kaybolurdu.
    CREATE TABLE IF NOT EXISTS deliveries (
      nonce         TEXT PRIMARY KEY,
      publisher_id  TEXT NOT NULL,
      campaign_id   TEXT NOT NULL,
      advertiser_id TEXT NOT NULL,
      rate          TEXT NOT NULL,
      rev_share_bps INTEGER NOT NULL,
      expires_at    INTEGER NOT NULL,
      consumed      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_deliveries_expires ON deliveries (expires_at);
  `)
}

/* ─────────────────────────── yardimcilar ─────────────────────────── */

/** SQLite `NULL` → `null`, sayi → `number`. Tip daraltmayi tek yerde tut. */
export const numOrNull = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v)

export const strOrNull = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v)

/** `boolean` SQLite'ta yok; 0/1 olarak saklanir. */
export const toInt = (b: boolean): number => (b ? 1 : 0)
export const toBool = (v: unknown): boolean => Number(v) === 1

/**
 * Suresi dolmus kayitlari siler.
 *
 * Yalnizca gercekten olu olanlar: suresi gecmis reklam sunumlari ve karara
 * baglanmis eski gosterimler. Defter ASLA temizlenmez — o kalici kayit.
 */
export function vacuumExpired(db: Db, now: number, keepImpressionsMs: number): number {
  const d = db.prepare('DELETE FROM deliveries WHERE expires_at < ?').run(now - 3600_000)
  const i = db.prepare(
    "DELETE FROM impressions WHERE state != 'pending' AND server_ts < ?",
  ).run(now - keepImpressionsMs)
  return Number(d.changes) + Number(i.changes)
}
