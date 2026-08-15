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

$('freighter').onclick = async () => {
  try {
    // Freighter kendini \`window.freighterApi\` olarak enjekte eder. Eklenti
    // kurulu degilse bu nesne hic olusmaz — kullaniciya net soylenmeli.
    const api = window.freighterApi
    if (!api) {
      say('Freighter bulunamadı. <a href="https://freighter.app" target="_blank" rel="noopener">freighter.app</a>' +
          "'ten kur, sayfayı yenile — ya da alttaki elle imzalamayı kullan.", 'err')
      return
    }
    say('Freighter’ın onayını bekliyorum…')

    // Yeni surumlerde \`requestAccess\`, eskilerde \`getPublicKey\`.
    let address
    if (api.requestAccess) {
      const r = await api.requestAccess()
      address = typeof r === 'string' ? r : r.address
      if (r && r.error) throw new Error(r.error)
    } else {
      address = await api.getPublicKey()
    }
    if (!address) throw new Error('Freighter adres vermedi')

    const ch = await post('/challenge', { address })
    say('İmzalaman için Freighter açıldı…')

    const signed = await api.signTransaction(ch.transaction, {
      networkPassphrase: ch.network_passphrase,
      address,
    })
    // Surume gore string veya { signedTxXdr } doner.
    const xdr = typeof signed === 'string' ? signed : (signed.signedTxXdr || signed.signedXDR)
    if (signed && signed.error) throw new Error(signed.error)
    if (!xdr) throw new Error('İmza alınamadı')

    const res = await post('/verify', { address, transaction: xdr })
    done(res.publisherId)
  } catch (e) {
    say('✗ ' + (e && e.message ? e.message : String(e)), 'err')
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
