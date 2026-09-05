#![cfg(test)]
use super::*;
use soroban_sdk::{
    testutils::{Address as _},
    token::StellarAssetClient,
};

struct Setup {
    env: Env,
    token: TokenClient<'static>,
    sac_admin: StellarAssetClient<'static>,
    admin: Address,
    platform: Address,
    vault: DwellVaultClient<'static>,
}

/// Her testte taze bir kasa + taze bir test tokeni (gercek SAC davranisi,
/// `register_stellar_asset_contract_v2` ile — dis bir wasm dosyasi gerekmez).
/// Varsayilan pay ADR-011 ile ayni: %50 yayinci, %50 platform.
fn setup() -> Setup {
    setup_with_bps(5_000)
}

fn setup_with_bps(publisher_bps: u32) -> Setup {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let platform = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token = TokenClient::new(&env, &sac.address());
    let sac_admin = StellarAssetClient::new(&env, &sac.address());

    let contract_id = env.register(
        DwellVault,
        (admin.clone(), sac.address(), platform.clone(), publisher_bps),
    );
    let vault = DwellVaultClient::new(&env, &contract_id);

    Setup {
        env,
        token,
        sac_admin,
        admin,
        platform,
        vault,
    }
}

#[test]
fn deposit_yatan_parayi_kasaya_tasir_ve_bakiyeyi_arttirir() {
    let s = setup();
    let adv = Address::generate(&s.env);
    s.sac_admin.mint(&adv, &1_000);

    let new_bal = s.vault.deposit(&adv, &400);

    assert_eq!(new_bal, 400);
    assert_eq!(s.vault.balance(&adv), 400);
    assert_eq!(s.token.balance(&adv), 600);
    assert_eq!(s.token.balance(&s.vault.address), 400);
}

#[test]
fn release_admin_disinda_kimse_cagiramaz() {
    let s = setup();
    let adv = Address::generate(&s.env);
    let publisher = Address::generate(&s.env);
    s.sac_admin.mint(&adv, &1_000);
    s.vault.deposit(&adv, &500);

    // `mock_all_auths` her cagriyi otomatik yetkiliyor; burada GERCEK
    // yetki kontrolunu görmek icin auth listesini kontrol ediyoruz.
    s.vault.release(&adv, &publisher, &200);
    let auths = s.env.auths();
    assert!(auths.iter().any(|(addr, _)| *addr == s.admin));
}

#[test]
fn release_payi_boler_yayinciya_ve_platforma_ayni_anda_gonderir() {
    let s = setup();
    let adv = Address::generate(&s.env);
    let publisher = Address::generate(&s.env);
    s.sac_admin.mint(&adv, &1_000);
    s.vault.deposit(&adv, &500);

    // %50 bps: 200'un 100'u yayinciya, 100'u platforma — AYNI cagrida.
    let kalan = s.vault.release(&adv, &publisher, &200);

    assert_eq!(kalan, 300);
    assert_eq!(s.vault.balance(&adv), 300);
    assert_eq!(s.token.balance(&publisher), 100);
    assert_eq!(s.token.balance(&s.platform), 100);
    assert_eq!(s.token.balance(&s.vault.address), 300);
}

/// ADR-011: yuvarlama artigi platformda kalir. 201 * %50 = 100.5 -> integer
/// bolme 100'e duser, kalan 101 platforma gider (100 + 101 = 201, tam).
#[test]
fn release_yuvarlama_artigi_platformda_kalir() {
    let s = setup();
    let adv = Address::generate(&s.env);
    let publisher = Address::generate(&s.env);
    s.sac_admin.mint(&adv, &1_000);
    s.vault.deposit(&adv, &500);

    s.vault.release(&adv, &publisher, &201);

    assert_eq!(s.token.balance(&publisher), 100);
    assert_eq!(s.token.balance(&s.platform), 101);
}

#[test]
fn release_yuz_bps_yayinciya_hicbir_sey_platforma_gitmez() {
    let s = setup_with_bps(10_000);
    let adv = Address::generate(&s.env);
    let publisher = Address::generate(&s.env);
    s.sac_admin.mint(&adv, &1_000);
    s.vault.deposit(&adv, &500);

    s.vault.release(&adv, &publisher, &200);

    assert_eq!(s.token.balance(&publisher), 200);
    assert_eq!(s.token.balance(&s.platform), 0);
}

#[test]
#[should_panic]
fn gecersiz_bps_ile_deploy_reddedilir() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let platform = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(token_admin);

    // %100'u (10000 bps) asan bir pay anlamsiz — constructor reddetmeli.
    env.register(DwellVault, (admin, sac.address(), platform, 10_001u32));
}

#[test]
fn release_bakiyenin_ustunde_istenirse_basarisiz_olur() {
    let s = setup();
    let adv = Address::generate(&s.env);
    let publisher = Address::generate(&s.env);
    s.sac_admin.mint(&adv, &1_000);
    s.vault.deposit(&adv, &100);

    let sonuc = s.vault.try_release(&adv, &publisher, &500);
    assert!(sonuc.is_err());
    // Basarisiz cagri hicbir seyi hareket ettirmemis olmali.
    assert_eq!(s.vault.balance(&adv), 100);
    assert_eq!(s.token.balance(&publisher), 0);
}

#[test]
fn cifte_release_ayni_parayi_iki_kez_odemez() {
    let s = setup();
    let adv = Address::generate(&s.env);
    let publisher = Address::generate(&s.env);
    s.sac_admin.mint(&adv, &1_000);
    s.vault.deposit(&adv, &500);

    s.vault.release(&adv, &publisher, &500);
    // Bakiye sifir — ayni tutari ikinci kez cekmeye calismak basarisiz olmali.
    let ikinci = s.vault.try_release(&adv, &publisher, &500);
    assert!(ikinci.is_err());
    assert_eq!(s.token.balance(&publisher), 250);   // %50 bps: 500'un yarisi
}

#[test]
fn withdraw_reklamveren_harcanmamis_bakiyesini_geri_alir() {
    let s = setup();
    let adv = Address::generate(&s.env);
    s.sac_admin.mint(&adv, &1_000);
    s.vault.deposit(&adv, &400);

    let kalan = s.vault.withdraw(&adv, &400);

    assert_eq!(kalan, 0);
    assert_eq!(s.vault.balance(&adv), 0);
    assert_eq!(s.token.balance(&adv), 1_000);
    assert_eq!(s.token.balance(&s.vault.address), 0);
}

#[test]
fn withdraw_reklamverenin_kendi_imzasi_gerekir() {
    let s = setup();
    let adv = Address::generate(&s.env);
    s.sac_admin.mint(&adv, &1_000);
    s.vault.deposit(&adv, &400);

    s.vault.withdraw(&adv, &400);
    let auths = s.env.auths();
    assert!(auths.iter().any(|(addr, _)| *addr == adv));
}

#[test]
fn sifir_veya_negatif_tutar_reddedilir() {
    let s = setup();
    let adv = Address::generate(&s.env);
    s.sac_admin.mint(&adv, &1_000);

    assert!(s.vault.try_deposit(&adv, &0).is_err());
    assert!(s.vault.try_deposit(&adv, &-10).is_err());
}

/// ADR-005'teki ledger invariant felsefesinin zincir karsiligi: kasanin
/// GERCEK token bakiyesi, tum reklamverenlerin toplam hakkindan asla
/// kucuk olamaz. Bircok deposit/release/withdraw sonrasi da dogru kalmali.
#[test]
fn solvency_invariant_karisik_islemler_sonrasi_da_saglam() {
    let s = setup();
    let alice = Address::generate(&s.env);
    let bob = Address::generate(&s.env);
    let publisher = Address::generate(&s.env);
    s.sac_admin.mint(&alice, &1_000);
    s.sac_admin.mint(&bob, &1_000);

    s.vault.deposit(&alice, &600);
    s.vault.deposit(&bob, &300);
    s.vault.release(&alice, &publisher, &150);
    s.vault.withdraw(&bob, &100);
    s.vault.deposit(&alice, &50);
    s.vault.release(&bob, &publisher, &50);

    let toplam_hak = s.vault.balance(&alice) + s.vault.balance(&bob);
    let kasa_bakiyesi = s.token.balance(&s.vault.address);
    assert_eq!(kasa_bakiyesi, toplam_hak, "kasa bakiyesi tum haklarin toplamina esit olmali");
}
