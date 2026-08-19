/* Dwell — tarayici tarafi ortak islevler.
 *
 * Cerceve yok, derleme adimi yok. Bes sayfalik bir site icin React
 * getirmek, indirilecek 40 KB'i 200 KB yapardi ve tek kazanci bizim
 * rahatimiz olurdu.
 *
 * Stellar SDK de YOK. Imzalanacak XDR'lari SUNUCU kuruyor, tarayici
 * yalnizca imzalatip geri gonderiyor. SDK'yi tarayiciya koymak ~1 MB
 * demekti ve tek ihtiyacimiz iki islem kurmak.
 */

/* ─────────────────────────── para ─────────────────────────── */

/**
 * Stroop metnini dolara cevirir. BigInt, float DEGIL.
 *
 * 1 USDC = 10.000.000 stroop. `parseFloat` ile bolmek 2^53 ustunde
 * sessizce yuvarlar ve kullanicinin bakiyesini degistirir.
 */
export function usd(stroops) {
  const v = BigInt(stroops);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const whole = a / 10000000n;
  const frac = (a % 10000000n).toString().padStart(7, '0').replace(/0+$/, '');
  return (neg ? '-' : '') + '$' + whole.toString() + (frac ? '.' + frac : '');
}

/** "40.25" → 402500000n. Float'a hic ugramaz. */
export function toStroops(text) {
  const m = /^(\d*)(?:\.(\d{0,7}))?$/.exec(String(text).trim());
  if (!m || (!m[1] && !m[2])) return null;
  return BigInt(m[1] || '0') * 10000000n + BigInt((m[2] || '').padEnd(7, '0'));
}

export const short = (a) => (a && a.length > 12 ? a.slice(0, 4) + '…' + a.slice(-4) : a || '');

/* ─────────────────────────── sunucu ─────────────────────────── */

const TOKEN_KEY = 'dwell.token';
const ROLE_KEY = 'dwell.role';
const ADDR_KEY = 'dwell.address';

export const session = {
  get token() { return localStorage.getItem(TOKEN_KEY); },
  get role() { return localStorage.getItem(ROLE_KEY); },
  get address() { return localStorage.getItem(ADDR_KEY); },
  save(token, role, address) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(ROLE_KEY, role);
    localStorage.setItem(ADDR_KEY, address);
  },
  clear() { [TOKEN_KEY, ROLE_KEY, ADDR_KEY].forEach((k) => localStorage.removeItem(k)); },
};

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.hint || body?.message || `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

/**
 * Sunucu cagrisi.
 *
 * Site sunucuyla AYNI adreste duruyor, bu yuzden yol goreli ve CORS yok.
 * Ayri bir alan adina koysaydik her uc icin CORS basliklari gerekirdi ve
 * cerez/kimlik islerinin hepsi zorlasirdi.
 */
export async function api(path, { method = 'GET', body, auth = true } = {}) {
  const headers = { 'x-dwell-client-version': '0.1.1' };
  if (body) headers['content-type'] = 'application/json';
  if (auth && session.token) headers.authorization = `Bearer ${session.token}`;

  let res;
  try {
    res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch (e) {
    // Ag hatasi ile sunucu hatasini AYIRIYORUZ: kullaniciya "tekrar dene"
    // demekle "oturumun dustu" demek farkli seyler.
    throw new ApiError(0, { message: 'Cannot reach the server' });
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

/* ─────────────────────────── cuzdan ─────────────────────────── */

/**
 * Freighter ile konusma — `@stellar/freighter-api` v6'nin protokolu.
 *
 * Eklenti `window.freighterApi` diye bir nesne BIRAKMIYOR. O global yalnizca
 * resmi kutuphanenin UMD paketini <script> ile yuklersen olusuyor. Ilk
 * yazdigimda ona bakiyordum ve Freighter kurulu olan makinede bile
 * "bulunamadi" diyordu.
 *
 * Eklentinin gercekte biraktigi tek sey `window.freighter = true`. Geri
 * kalan her sey `postMessage` uzerinden.
 *
 * 10 KB'lik resmi paketi gomebilirdik; protokol degisirse ikisi de ayni
 * sekilde kirilacagi icin kazanci yok. Kodun kendisi burada duruyor ve ne
 * yaptigi okunabiliyor.
 *
 * NOT: Ayni mantik CLI'nin `login-page.ts` dosyasinda da var — o sayfa
 * kullanicinin kendi makinesinde, bu sunucudan bagimsiz calisiyor. Biri
 * degisirse digeri de degismeli.
 */

const FREIGHTER_REQ = 'FREIGHTER_EXTERNAL_MSG_REQUEST';
const FREIGHTER_RES = 'FREIGHTER_EXTERNAL_MSG_RESPONSE';

function freighterSend(payload, timeoutMs = 0) {
  const messageId = Date.now() + Math.random();
  window.postMessage({ source: FREIGHTER_REQ, messageId, ...payload }, window.location.origin);

  return new Promise((resolve) => {
    let timer = 0;
    const onMsg = (e) => {
      // DIKKAT: cevapta alan adi `messagedId` — Freighter'in kendi yazim
      // hatasi. `messageId` diye bakarsak hicbir cevap eslesmez ve her
      // istek sessizce zaman asimina ugrar.
      if (e.source !== window) return;
      const d = e.data;
      if (!d || d.source !== FREIGHTER_RES || d.messagedId !== messageId) return;
      window.removeEventListener('message', onMsg);
      clearTimeout(timer);
      resolve(d);
    };
    window.addEventListener('message', onMsg, false);

    // Yalnizca "orada misin" turu sorularda zaman asimi: imza beklerken
    // kullanici Freighter penceresinde dusunuyor olabilir, onu kesmeyiz.
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        window.removeEventListener('message', onMsg);
        resolve(null);
      }, timeoutMs);
    }
  });
}

/** Eklenti var mi? Once hizli global, sonra el sikisma. */
export async function freighterReady() {
  if (window.freighter === true) return true;
  const r = await freighterSend({ type: 'REQUEST_CONNECTION_STATUS' }, 2000);
  return !!(r && r.isConnected);
}

export async function walletAddress() {
  const r = await freighterSend({ type: 'REQUEST_ACCESS' });
  if (r?.apiError) throw new Error(r.apiError.message || 'Freighter refused access');
  if (!r?.publicKey) throw new Error('Freighter returned no address');
  return r.publicKey;
}

async function signXdr(xdr, networkPassphrase, address) {
  const r = await freighterSend({
    type: 'SUBMIT_TRANSACTION',
    transactionXdr: xdr,
    networkPassphrase,
    accountToSign: address,
  });
  if (r?.apiError) throw new Error(r.apiError.message || 'Freighter refused to sign');
  if (!r?.signedTransaction) throw new Error('Freighter returned no signature');
  return r.signedTransaction;
}

/* ─────────────────────────── giris (SEP-10) ─────────────────────────── */

/**
 * Cuzdanla giris. Sifre yok, hesap yok — adres kimligin kendisi.
 *
 * Uc adim: sunucudan bir challenge iste, Freighter'a imzalat, imzayi geri
 * gonder. Sunucu imzayi dogrularsa token verir.
 *
 * Imzalanan sey `sequence = 0` olan bir transaction: aga gonderilmesi
 * PROTOKOL GEREGI imkansiz. Yani bu imza hicbir zaman para hareket
 * ettiremez, yalnizca "bu adres benim"i kanitlar.
 *
 * `onStep` her adimda dugmenin yazisini degistiriyor. Freighter penceresi
 * acilmadan once kullanicinin ne bekledigini bilmesi gerekiyor — yoksa
 * donen bir dugmeye bakip sayfanin dondugunu saniyor.
 */
export async function login(role, onStep = () => {}) {
  onStep('Waiting for Freighter…');
  const address = await walletAddress();

  onStep('Preparing…');
  const challenge = await api('/v1/auth/challenge', {
    method: 'POST', auth: false, body: { address },
  });

  onStep('Sign in Freighter…');
  const signed = await signXdr(challenge.transaction, challenge.network_passphrase, address);

  onStep('Verifying…');
  // Rolu SUNUCU dogruluyor; buradaki deger yalnizca hangi yetkilerin
  // istendigini soyluyor, kendi kendine yetki vermiyor.
  const { token } = await api('/v1/auth/verify', {
    method: 'POST', auth: false, body: { address, transaction: signed, role },
  });

  session.save(token, role, address);
  return { address, role };
}

/* ─────────────────── trustline (yalnizca yayinci) ─────────────────── */

const HORIZON = 'https://horizon-testnet.stellar.org';
const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

/** Cuzdan USDC kabul edebiliyor mu, ve XLM'i yetiyor mu? */
export async function walletState(address) {
  const res = await fetch(`${HORIZON}/accounts/${address}`);
  if (!res.ok) return { exists: false, usdc: false, xlm: '0' };
  const acc = await res.json();
  const usdcLine = acc.balances.find(
    (b) => b.asset_code === 'USDC' && b.asset_issuer === USDC_ISSUER,
  );
  const native = acc.balances.find((b) => b.asset_type === 'native');
  return { exists: true, usdc: !!usdcLine, xlm: native ? native.balance : '0' };
}

/**
 * USDC kabulunu acar.
 *
 * XDR'i sunucu kuruyor — tarayiciya Stellar SDK koymamak icin. Imzayi
 * Freighter atiyor, sonucu dogrudan Horizon'a gonderiyoruz: sunucudan
 * gecirmeye gerek yok, islem zaten kullanicinin kendi hesabinda.
 */
export async function enableUsdc(address) {
  const { xdr, network_passphrase } = await api('/v1/wallet/trustline-xdr', {
    method: 'POST', auth: false, body: { address },
  });
  const signed = await signXdr(xdr, network_passphrase, address);

  const res = await fetch(`${HORIZON}/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ tx: signed }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => null);
    const codes = e?.extras?.result_codes;
    throw new Error(codes ? JSON.stringify(codes) : `Horizon ${res.status}`);
  }
}

/* ─────────────────────────── kucuk yardimcilar ─────────────────────────── */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function show(el, on) { el?.classList.toggle('hidden', !on); }

/**
 * Onay isareti — yazi tipi glifi degil, cizilmis SVG.
 *
 * `✓` karakteri her isletim sisteminde farkli boyutta ve kalinlikta
 * geliyor; macOS'ta ince, Windows'ta kalin, Linux'ta bazen hic yok.
 * Cizersek her yerde ayni.
 */
const TICK = `<svg class="tick" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 8.5l3.6 3.6L13.5 4.7"/></svg>`;

export function copyButton(btn, text) {
  btn.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(text()); } catch { /* izin yok */ }
    const tag = btn.querySelector('.tag') || btn;
    if (tag.dataset.busy) return;              // ust uste tiklamada etiketi kaybetme
    tag.dataset.busy = '1';
    tag.dataset.before = tag.textContent;

    tag.innerHTML = TICK;
    tag.classList.add('done');
    setTimeout(() => {
      tag.textContent = tag.dataset.before;
      tag.classList.remove('done');
      delete tag.dataset.busy;
    }, 1600);
  });
}

/** stellar.expert baglantilari — testnet. */
export const explorer = {
  tx: (h) => `https://stellar.expert/explorer/testnet/tx/${h}`,
  account: (a) => `https://stellar.expert/explorer/testnet/account/${a}`,
};
