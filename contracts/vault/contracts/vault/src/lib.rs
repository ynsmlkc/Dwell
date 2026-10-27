#![no_std]

//! Dwell reklamveren emanet kasasi — PROJECT.md ADR-021/ADR-006 revizyonu,
//! PROBLEMS.md #15.4/#15.10.
//!
//! Reklamverenin USDC'si tek bir opak sicak cuzdanda toplanmak yerine bu
//! kontratta, reklamveren bazinda ayristirilmis olarak duruyor. Herkes
//! `balance(advertiser)` ile zincirde dogrulayabilir; kontratin kendi token
//! bakiyesi her zaman butun `Balance` kayitlarinin toplamina esit ya da
//! buyuk olmak ZORUNDA — bu, ayni dosyadaki unit testte bir invariant
//! olarak korunuyor (ADR-005'teki ledger invariant felsefesinin zincir
//! karsiligi).
//!
//! `release` disinda hicbir yol parayi disari cikaramaz disinda: reklamveren
//! `withdraw` ile harcanmamis bakiyesini PLATFORMDAN IZIN ISTEMEDEN, sunucu
//! kapali olsa bile geri alabilir — bugunku hot-wallet akisinda bu mumkun
//! degil (bkz. `/v1/advertiser/withdraw`, sunucunun onayina bagli).
//!
//! `release` payi kendi icinde boler — yayinciya `publisher_bps`, kalani
//! (yuvarlama artigi dahil) `platform` adresine, AYNI transaction'da, iki
//! ayri transfer olarak. Bu, ADR-011'deki off-chain `splitRevenue`'nun
//! zincir karsiligi: eskiden platformun payi hot wallet'ta gorunmez sekilde
//! birikip hicbir zaman cekilmiyordu (kod tabaninda `PLATFORM_REVENUE`
//! hesabini okuyan/cekens tek bir satir bile yoktu). Simdi platform payi
//! HER release'de ANINDA platformun kendi cuzdanina dusuyor — ayri bir
//! "biriken payi cek" akisina gerek kalmiyor.
//!
//! `publisher_bps` deploy aninda sabitleniyor, sonradan DEGISTIRILEMEZ —
//! ayni ADR-011'in "reklamveren payi pazarlik edemez" kuralinin sebebiyle:
//! calisan bir `release` cagrisi icinde bps'i disaridan parametre olarak
//! kabul etseydik, ele gecirilmis bir admin anahtari yayinci payini
//! sifira cekip butun parayi platforma yonlendirebilirdi.
//!
//! Neyin DEGISMEDIGI: `release`'i cagiran `admin` hala sunucuda duran
//! SICAK bir anahtar. Bu kontrat imza-custody riskini sifirlamiyor —
//! hesap sorulabilirligi (kimin ne kadar hakki oldugu zincirde dogrulanabilir)
//! kazandiriyor, "admin anahtari calinamaz" garantisi vermiyor.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype,
    token::TokenClient, Address, Env,
};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Token,
    /// Platformun payinin gittigi adres — ADR-011.
    Platform,
    /// Yayinci payi, baz puan (5000 = %50). Deploy aninda sabitlenir.
    PublisherBps,
    /// Reklamverenin kasadaki harcanmamis bakiyesi.
    Balance(Address),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    NotInitialized = 1,
    AmountNotPositive = 2,
    InsufficientBalance = 3,
    InvalidBps = 4,
}

#[contractevent]
pub struct Deposited {
    #[topic]
    pub advertiser: Address,
    pub amount: i128,
}

#[contractevent]
pub struct Released {
    #[topic]
    pub advertiser: Address,
    #[topic]
    pub publisher: Address,
    /// Reklamverenin bakiyesinden dusen TOPLAM tutar.
    pub amount: i128,
    /// Bunun ne kadari yayinciya gitti — kalani (yuvarlama artigi dahil)
    /// platforma gitti (`amount - publisher_amount`).
    pub publisher_amount: i128,
}

/// Admin anahtari degisti — zincirde herkes gorebilsin.
#[contractevent]
pub struct AdminChanged {
    #[topic]
    pub old_admin: Address,
    #[topic]
    pub new_admin: Address,
}

#[contractevent]
pub struct Withdrawn {
    #[topic]
    pub advertiser: Address,
    pub amount: i128,
}

const DAY_IN_LEDGERS: u32 = 17280;
const BUMP_THRESHOLD: u32 = 30 * DAY_IN_LEDGERS;
const BUMP_TO: u32 = 120 * DAY_IN_LEDGERS;

#[contract]
pub struct DwellVault;

#[contractimpl]
impl DwellVault {
    /// Bir kez, deploy aninda. `admin` yalnizca `release` cagirabilir —
    /// reklamverenin kendi parasini `withdraw` ile cekmesini ENGELLEYEMEZ.
    /// `publisher_bps` 0..=10000 olmak zorunda ve sonradan DEGISTIRILEMEZ.
    pub fn __constructor(
        env: Env,
        admin: Address,
        token: Address,
        platform: Address,
        publisher_bps: u32,
    ) -> Result<(), Error> {
        if publisher_bps > 10_000 {
            return Err(Error::InvalidBps);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Token, &token);
        env.storage().instance().set(&DataKey::Platform, &platform);
        env.storage()
            .instance()
            .set(&DataKey::PublisherBps, &publisher_bps);
        env.storage().instance().extend_ttl(BUMP_THRESHOLD, BUMP_TO);
        Ok(())
    }

    /// Reklamveren kendi USDC'sini kasaya yatirir. Kendi imzasi sart —
    /// admin ya da baska biri baskasi adina yatiramaz.
    pub fn deposit(env: Env, advertiser: Address, amount: i128) -> Result<i128, Error> {
        if amount <= 0 {
            return Err(Error::AmountNotPositive);
        }
        advertiser.require_auth();

        Self::bump_instance(&env);

        let token = Self::token(&env)?;
        let vault = env.current_contract_address();
        TokenClient::new(&env, &token).transfer(&advertiser, &vault, &amount);

        let new_bal = Self::credit(&env, &advertiser, amount);
        Deposited { advertiser, amount }.publish(&env);
        Ok(new_bal)
    }

    /// Yalnizca admin — dogrulanmis gosterim batch'i sonrasi, kasadan
    /// yayinciya VE platforma AYNI ANDA oder. Reklamverenin bakiyesinden
    /// `amount`'un TAMAMI duser; `publisher_bps` payi yayinciya, kalani
    /// (yuvarlama artigi dahil, ADR-011) platforma gider.
    pub fn release(
        env: Env,
        advertiser: Address,
        publisher: Address,
        amount: i128,
    ) -> Result<i128, Error> {
        if amount <= 0 {
            return Err(Error::AmountNotPositive);
        }
        Self::admin(&env)?.require_auth();
        Self::bump_instance(&env);

        let bal = Self::balance(env.clone(), advertiser.clone());
        if bal < amount {
            return Err(Error::InsufficientBalance);
        }

        let bps: u32 = env
            .storage()
            .instance()
            .get(&DataKey::PublisherBps)
            .ok_or(Error::NotInitialized)?;
        let platform: Address = env
            .storage()
            .instance()
            .get(&DataKey::Platform)
            .ok_or(Error::NotInitialized)?;

        // ADR-011 ile BIREBIR ayni formul: publisher = amount * bps / 10000
        // (asagi yuvarlanir), platform = amount - publisher (artik platformda).
        let publisher_amount = (amount * (bps as i128)) / 10_000;
        let platform_amount = amount - publisher_amount;

        let token = Self::token(&env)?;
        let vault = env.current_contract_address();
        let client = TokenClient::new(&env, &token);
        if publisher_amount > 0 {
            client.transfer(&vault, &publisher, &publisher_amount);
        }
        if platform_amount > 0 {
            client.transfer(&vault, &platform, &platform_amount);
        }

        let new_bal = Self::debit(&env, &advertiser, amount);
        Released {
            advertiser,
            publisher,
            amount,
            publisher_amount,
        }
        .publish(&env);
        Ok(new_bal)
    }

    /// Reklamveren harcanmamis bakiyesini geri ceker — platformun onayina
    /// gerek YOK. Sunucu kapali olsa bile bu cagri calisir.
    pub fn withdraw(env: Env, advertiser: Address, amount: i128) -> Result<i128, Error> {
        if amount <= 0 {
            return Err(Error::AmountNotPositive);
        }
        advertiser.require_auth();
        Self::bump_instance(&env);

        let bal = Self::balance(env.clone(), advertiser.clone());
        if bal < amount {
            return Err(Error::InsufficientBalance);
        }

        let token = Self::token(&env)?;
        let vault = env.current_contract_address();
        TokenClient::new(&env, &token).transfer(&vault, &advertiser, &amount);

        let new_bal = Self::debit(&env, &advertiser, amount);
        Withdrawn { advertiser, amount }.publish(&env);
        Ok(new_bal)
    }

    /// Admin anahtarini degistirir. Sunucudaki sicak anahtar calinir ya da
    /// rutin olarak dondurulmek istenirse, onceden bu fonksiyon yoktu ve
    /// anahtar SONSUZA kadar gecerliydi.
    ///
    /// Iki imza: mevcut admin (yetki) VE yeni admin (anahtarin gercekten
    /// kullanilabilir oldugunun kaniti — yanlis yazilmis bir adres kasayi
    /// admin'siz birakmasin). `publisher_bps` ve `platform` DEGISMEZ; bu
    /// fonksiyon yalnizca kimin `release` cagirabilecegini degistirir.
    pub fn set_admin(env: Env, new_admin: Address) -> Result<(), Error> {
        let old_admin = Self::admin(&env)?;
        old_admin.require_auth();
        new_admin.require_auth();

        env.storage().instance().set(&DataKey::Admin, &new_admin);
        Self::bump_instance(&env);
        AdminChanged { old_admin, new_admin }.publish(&env);
        Ok(())
    }

    /// Mevcut admin — herkes dogrulayabilsin.
    pub fn get_admin(env: Env) -> Result<Address, Error> {
        Self::admin(&env)
    }

    /// Herkes sorgulayabilir — Dwell'in veritabanina guvenmeden.
    pub fn balance(env: Env, advertiser: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Balance(advertiser))
            .unwrap_or(0)
    }

    /* ── ic isler ── */

    fn admin(env: &Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)
    }

    /// Instance kaydi (admin, token, platform, bps) yalnizca kurulumda
    /// uzatiliyordu; ~120 gun sonra arsivlenip kontrati kullanilamaz
    /// birakirdi. Her yazan cagri uzatir.
    fn bump_instance(env: &Env) {
        env.storage().instance().extend_ttl(BUMP_THRESHOLD, BUMP_TO);
    }

    fn token(env: &Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Token)
            .ok_or(Error::NotInitialized)
    }

    fn credit(env: &Env, advertiser: &Address, amount: i128) -> i128 {
        let key = DataKey::Balance(advertiser.clone());
        let bal: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        let new_bal = bal + amount;
        env.storage().persistent().set(&key, &new_bal);
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
        new_bal
    }

    fn debit(env: &Env, advertiser: &Address, amount: i128) -> i128 {
        let key = DataKey::Balance(advertiser.clone());
        let bal: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        let new_bal = bal - amount;
        env.storage().persistent().set(&key, &new_bal);
        // `credit` gibi: harcama da bakiye kaydini canli tutar. Uzatilmasaydi
        // yalnizca harcanan (yeni yatirma yapilmayan) bir bakiye arsive
        // duserdi.
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
        new_bal
    }
}

mod test;
