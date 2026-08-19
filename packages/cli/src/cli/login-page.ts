/**
 * `dwell login` sirasinda tarayicida acilan sayfa.
 *
 * Neden tarayici? Cunku ozel anahtari GORMEK ISTEMIYORUZ (ADR-014). Freighter
 * ve LOBSTR birer tarayici eklentisi; imzayi onlar atar, biz yalnizca
 * imzalanmis XDR'i aliriz. Terminalden "secret key'ini yapistir" demek en
 * kolay yol olurdu ve en kotu karar olurdu.
 *
 * Sayfa 127.0.0.1'de, tek kullanimlik bir portta servis edilir. Disaridan
 * erisilemez; challenge/verify cagrilarini yerel surec Dwell sunucusuna
 * proxy'ler — boylece Dwell sunucusunda CORS acmaya gerek kalmaz.
 */

export function loginPage(opts: { readonly nonce: string }): string {
  return `<!doctype html>
<html lang="tr"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dwell — cüzdanı bağla</title>
<style>
  :root { color-scheme: light dark;
    --bg:#fff; --fg:#111; --muted:#666; --line:#e5e5e5; --accent:#ff6b35; --ok:#16a34a; --err:#dc2626; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0f0f0f; --fg:#f0f0f0; --muted:#999; --line:#262626; }
  }
  * { box-sizing: border-box }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--fg);
    font:15px/1.6 ui-sans-serif,-apple-system,system-ui,sans-serif; padding:24px }
  .card { width:100%; max-width:440px }
  h1 { font-size:20px; margin:0 0 4px; letter-spacing:-.01em }
  h1 .d { color:var(--accent) }
  p.sub { color:var(--muted); margin:0 0 28px; font-size:14px }
  button { width:100%; padding:13px 16px; border-radius:10px; border:1px solid var(--line);
    background:transparent; color:var(--fg); font:inherit; font-weight:500; cursor:pointer; text-align:left;
    display:flex; align-items:center; gap:10px; margin-bottom:10px }
  button:hover:not(:disabled) { border-color:var(--accent) }
  button:disabled { opacity:.45; cursor:default }
  .primary { background:var(--accent); border-color:var(--accent); color:#fff; justify-content:center }
  .status { margin-top:20px; padding:13px 16px; border-radius:10px; border:1px solid var(--line);
    font-size:14px; display:none }
  .status.on { display:block }
  .status.ok { border-color:var(--ok); color:var(--ok) }
  .status.err { border-color:var(--err); color:var(--err) }
  code { font:13px ui-monospace,SFMono-Regular,Menlo,monospace; word-break:break-all; color:var(--muted) }
  .note { margin-top:24px; padding-top:16px; border-top:1px solid var(--line); color:var(--muted); font-size:13px }
</style></head>
<body><div class="card">
  <h1><span class="d">◆</span> Cüzdanını bağla</h1>
  <p class="sub">Dwell kazancını bu adrese gönderecek. Özel anahtarın tarayıcından çıkmaz.</p>

  <button id="freighter" class="primary">Freighter ile bağlan</button>
  <button id="manual">XDR'ı elle imzala</button>

  <div id="status" class="status"></div>

  <div class="note">
    Bu sayfa yalnızca senin bilgisayarında çalışıyor (127.0.0.1).
    İmzalanan işlem <strong>ağa gönderilemez</strong> — sıra numarası 0'dır, yalnızca kimlik kanıtıdır.
  </div>
</div>

<script>
const NONCE = ${JSON.stringify(opts.nonce)}
const $ = (id) => document.getElementById(id)
const say = (msg, kind) => {
  const el = $('status')
  el.className = 'status on' + (kind ? ' ' + kind : '')
  el.innerHTML = msg
}

async function post(path, body) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dwell-nonce': NONCE },
    body: JSON.stringify(body),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.message || j.hint || ('HTTP ' + r.status))
  return j
}

function done(publisherId) {
  say('✓ Bağlandı — <code>' + publisherId + '</code><br>Terminale dönebilirsin.', 'ok')
  $('freighter').disabled = true
  $('manual').disabled = true
}

/**
 * Freighter protokolu — @stellar/freighter-api v6 ile ayni.
 *
 * Eklenti window.freighterApi BIRAKMIYOR; o global yalnizca resmi
 * kutuphanenin UMD paketi script etiketiyle yuklendiginde olusuyor. Ilk
 * yazdigimda ona bakiyordum ve Freighter kurulu makinede bile
 * "bulunamadi" diyordu. Eklentinin biraktigi tek sey window.freighter.
 *
 * Ayni mantik sitenin app.js dosyasinda da var; biri degisirse digeri de.
 *
 * DIKKAT: bu blok bir sablon dizesinin ICINDE — backtick kullanma, diziyi
 * kapatir ve TypeScript anlasilmaz hatalar verir.
 */
const REQ = 'FREIGHTER_EXTERNAL_MSG_REQUEST'
const RES = 'FREIGHTER_EXTERNAL_MSG_RESPONSE'

function fSend(payload, timeoutMs) {
  const messageId = Date.now() + Math.random()
  window.postMessage({ source: REQ, messageId, ...payload }, window.location.origin)
  return new Promise((resolve) => {
    let timer = 0
    const onMsg = (e) => {
      // Cevapta alan adi "messagedId" — Freighter'in kendi yazim hatasi.
      // "messageId" diye bakarsak hicbir cevap eslesmez ve her istek
      // sessizce zaman asimina ugrar.
      if (e.source !== window) return
      const d = e.data
      if (!d || d.source !== RES || d.messagedId !== messageId) return
      window.removeEventListener('message', onMsg)
      clearTimeout(timer)
      resolve(d)
    }
    window.addEventListener('message', onMsg, false)
    // Imza beklerken zaman asimi YOK: kullanici Freighter penceresinde
    // dusunuyor olabilir.
    if (timeoutMs) timer = setTimeout(() => {
      window.removeEventListener('message', onMsg); resolve(null)
    }, timeoutMs)
  })
}

async function freighterReady() {
  if (window.freighter === true) return true
  const r = await fSend({ type: 'REQUEST_CONNECTION_STATUS' }, 2000)
  return !!(r && r.isConnected)
}

// Eklenti icerik betigi sayfadan SONRA yuklenebiliyor; bir kez daha bak.
freighterReady().then((ok) => {
  if (!ok) setTimeout(() => freighterReady().then(showIfMissing), 800)
  else showIfMissing(true)
})
function showIfMissing(ok) {
  if (ok) return
  say('Freighter bulunamadi. <a href="https://freighter.app" target="_blank" rel="noopener">freighter.app</a>'
    + "'ten kur, sayfayi yenile — ya da alttaki elle imzalamayi kullan.", 'err')
}

$('freighter').onclick = async () => {
  try {
    if (!(await freighterReady())) {
      say('Freighter bulunamadi. <a href="https://freighter.app" target="_blank" rel="noopener">freighter.app</a>'
        + "'ten kur ve sayfayi yenile.", 'err')
      return
    }
    say('Freighter\u2019in onayini bekliyorum\u2026')

    const acc = await fSend({ type: 'REQUEST_ACCESS' })
    if (acc?.apiError) throw new Error(acc.apiError.message || 'erisim reddedildi')
    const address = acc?.publicKey
    if (!address) throw new Error('Freighter adres vermedi')

    const ch = await post('/challenge', { address })
    say('Imzalaman icin Freighter acildi\u2026')

    const signed = await fSend({
      type: 'SUBMIT_TRANSACTION',
      transactionXdr: ch.transaction,
      networkPassphrase: ch.network_passphrase,
      accountToSign: address,
    })
    if (signed?.apiError) throw new Error(signed.apiError.message || 'imza reddedildi')
    if (!signed?.signedTransaction) throw new Error('Imza alinamadi')

    const res = await post('/verify', { address, transaction: signed.signedTransaction })
    done(res.publisherId)
  } catch (e) {
    say('\u2717 ' + (e && e.message ? e.message : String(e)), 'err')
  }
}

$('manual').onclick = async () => {
  const address = prompt('Stellar adresin (G… ile başlar):')
  if (!address) return
  try {
    const ch = await post('/challenge', { address: address.trim() })
    say('Aşağıdaki XDR’ı cüzdanında imzala, sonucu yapıştır:<br><br><code>' + ch.transaction + '</code>')
    const xdr = prompt('İmzalanmış XDR:')
    if (!xdr) return
    const res = await post('/verify', { address: address.trim(), transaction: xdr.trim() })
    done(res.publisherId)
  } catch (e) {
    say('✗ ' + (e && e.message ? e.message : String(e)), 'err')
  }
}
</script>
</body></html>`
}
