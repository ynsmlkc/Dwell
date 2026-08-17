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

/** Freighter eklentisi kendini `window.freighterApi` olarak enjekte eder. */
export const freighter = () => window.freighterApi || null;

export async function walletAddress() {
  const api_ = freighter();
  if (!api_) throw new Error('Freighter not found');
  if (api_.requestAccess) {
    const r = await api_.requestAccess();
    if (r && r.error) throw new Error(r.error);
    return typeof r === 'string' ? r : r.address;
  }
  return api_.getPublicKey();
}

async function signXdr(xdr, networkPassphrase, address) {
  const api_ = freighter();
  const signed = await api_.signTransaction(xdr, { networkPassphrase, address });
  if (signed && signed.error) throw new Error(signed.error);
  const out = typeof signed === 'string' ? signed : signed.signedTxXdr || signed.signedXDR;
  if (!out) throw new Error('Freighter returned no signature');
  return out;
}

/**
 * SEP-10 girisi.
 *
 * Sunucu bir "meydan okuma" uretir, kullanici cuzdaniyla imzalar, sunucu
 * dogrular. Imzalanan islem aga GONDERILEMEZ — sira numarasi sifirdir,
 * yalnizca kimlik kanitidir. Bunu kullaniciya soylemek onemli: cuzdani
 * "islem imzala" dedigi anda insanlar hakli olarak duruyor.
 */
export async function login(role, onStep) {
  onStep?.('Requesting access…');
  const address = await walletAddress();

  onStep?.('Waiting for signature…');
  const ch = await api('/v1/auth/challenge', { method: 'POST', auth: false, body: { address } });
  const signedXdr = await signXdr(ch.transaction, ch.network_passphrase, address);

  const out = await api('/v1/auth/verify', {
    method: 'POST', auth: false,
    body: { address, transaction: signedXdr, role },
  });
  session.save(out.token, out.role || role, out.publisherId);
  return out;
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

export function copyButton(btn, text) {
  btn.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(text()); } catch { /* izin yok */ }
    const tag = btn.querySelector('.tag') || btn;
    const before = tag.textContent;
    tag.textContent = 'copied';
    setTimeout(() => { tag.textContent = before; }, 2000);
  });
}

/** stellar.expert baglantilari — testnet. */
export const explorer = {
  tx: (h) => `https://stellar.expert/explorer/testnet/tx/${h}`,
  account: (a) => `https://stellar.expert/explorer/testnet/account/${a}`,
};
