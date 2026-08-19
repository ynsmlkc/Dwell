/**
 * `dwell login` sirasinda tarayicida acilan sayfa.
 *
 * Neden tarayici? Cunku ozel anahtari GORMEK ISTEMIYORUZ (ADR-014). Freighter
 * bir tarayici eklentisi; imzayi o atar, biz yalnizca imzalanmis XDR'i
 * aliriz. Terminalden "secret key'ini yapistir" demek en kolay yol olurdu ve
 * en kotu karar olurdu.
 *
 * Sayfa 127.0.0.1'de, tek kullanimlik bir portta servis edilir. Disaridan
 * erisilemez; challenge/verify/trustline cagrilarini yerel surec disariya
 * proxy'ler — boylece CSP `connect-src 'self'` kalabiliyor ve sayfa baska
 * hicbir yere baglanamiyor.
 */

export interface LoginPageOpts {
  readonly nonce: string
  readonly port: number
}

export function loginPage(opts: LoginPageOpts): string {
  return `<!doctype html>
<html lang="tr"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dwell — cüzdanı bağla</title>
<style>
  *, *::before, *::after { box-sizing: border-box }
  :root {
    --bg:#0c0b0a; --deep:#080706; --ink:#ece7e1; --soft:#d6d0c8;
    --muted:#9d968d; --faint:#6f6a63; --line:rgba(236,231,225,0.09);
    --line2:rgba(236,231,225,0.14); --accent:#f97335; --err:#b8574a; --ok:#8fae7f;
    --serif:'Iowan Old Style','Palatino Linotype',Palatino,Georgia,serif;
    --mono:ui-monospace,'SF Mono',SFMono-Regular,Menlo,Consolas,monospace;
  }
  body {
    margin:0; min-height:100vh; display:grid; grid-template-rows:auto 1fr auto;
    font-family:var(--serif); background:var(--bg); color:var(--ink);
    -webkit-font-smoothing:antialiased; font-variant-numeric:tabular-nums;
    background-image:
      linear-gradient(rgba(236,231,225,0.032) 1px, transparent 1px),
      linear-gradient(90deg, rgba(236,231,225,0.032) 1px, transparent 1px);
    background-size:64px 64px;
  }
  a { color:var(--ink); text-decoration:none }
  a:hover { color:var(--accent) }
  :focus-visible { outline:2px solid var(--accent); outline-offset:3px }
  ::selection { background:rgba(249,115,53,0.3) }

  header, footer {
    display:flex; align-items:center; justify-content:space-between;
    gap:10px 24px; flex-wrap:wrap; padding:14px clamp(16px,4vw,40px);
    font-family:var(--mono); font-size:12.5px; color:var(--faint);
  }
  header { border-bottom:1px solid var(--line) }
  footer { border-top:1px solid var(--line) }
  .brand { display:flex; align-items:baseline; gap:9px; font-size:14px; color:var(--ink) }
  .brand i { color:var(--accent); font-size:15px; font-style:normal }
  .chip {
    display:inline-flex; align-items:center; gap:8px; padding:5px 11px;
    border:1px solid rgba(236,231,225,0.16); border-radius:3px;
    font-size:12px; color:var(--muted); white-space:nowrap;
  }
  .chip i { width:5px; height:5px; border-radius:50%; background:var(--accent); display:block }

  main { display:grid; place-items:center; padding:clamp(28px,6vw,72px) clamp(16px,4vw,40px) }
  .card { width:100%; max-width:620px; display:grid; gap:22px }

  .eyebrow { margin:0; font-family:var(--mono); font-size:12px; letter-spacing:.14em; text-transform:uppercase; color:var(--accent) }
  h1 { margin:0; font-weight:400; font-size:clamp(30px,4.4vw,44px); line-height:1.08; letter-spacing:-.02em; text-wrap:pretty }
  .lede { margin:0; max-width:52ch; font-family:var(--mono); font-size:14px; line-height:1.7; color:var(--muted); text-wrap:pretty }
  .lede b { color:var(--soft); font-weight:400 }

  .term { border:1px solid var(--line2); border-radius:6px; background:var(--deep); overflow:hidden }
  .term-bar {
    display:flex; align-items:center; justify-content:space-between; gap:12px;
    padding:10px 14px; border-bottom:1px solid rgba(236,231,225,0.1);
    font-family:var(--mono); font-size:12px; color:var(--faint);
  }
  .log { padding:18px 16px; font-family:var(--mono); font-size:13.5px; line-height:1.9; display:grid; gap:2px }
  .log div { white-space:pre-wrap; word-break:break-all }
  @keyframes blink { 0%,49%{opacity:1} 50%,100%{opacity:.15} }
  .caret { animation:blink 1.1s steps(1) infinite }

  .addr {
    border-top:1px solid rgba(236,231,225,0.1); background:rgba(249,115,53,0.05);
    padding:16px; display:grid; gap:10px; font-family:var(--mono); font-size:13px;
  }
  .addr .k { color:var(--faint); font-size:12px; letter-spacing:.1em; text-transform:uppercase }
  .addr .v { color:var(--ink); word-break:break-all; line-height:1.6 }
  .facts { display:flex; flex-wrap:wrap; gap:8px 22px; color:var(--faint) }
  .facts span { white-space:nowrap }
  .facts em { font-style:normal; color:var(--ink) }

  button {
    font-family:var(--mono); cursor:pointer;
    border:1px solid rgba(236,231,225,0.2); border-radius:4px;
    background:transparent; color:var(--ink);
  }
  button:disabled { cursor:default }
  .primary {
    width:100%; display:flex; align-items:center; justify-content:center; gap:12px;
    padding:15px 20px; font-size:14.5px; background:var(--accent);
    border-color:var(--accent); color:var(--bg);
  }
  .primary:hover:not(:disabled) { filter:brightness(1.08) }
  .primary:disabled { cursor:progress }
  .primary.quiet { background:transparent; border-color:rgba(236,231,225,0.2); color:var(--ink) }
  .linkish {
    padding:0; border:0; background:none; color:var(--muted);
    font-size:13px; border-bottom:1px solid rgba(236,231,225,0.2);
  }
  .linkish:hover { color:var(--ink) }

  .manual { border:1px solid var(--line2); border-radius:6px; padding:16px; display:grid; gap:12px; background:rgba(236,231,225,0.02) }
  .manual p { margin:0; font-family:var(--mono); font-size:13px; line-height:1.7; color:var(--muted) }
  .manual code { font-family:var(--mono); font-size:12px; color:var(--faint); word-break:break-all; line-height:1.6 }
  .manual input, .manual textarea {
    width:100%; padding:11px 12px; border:1px solid rgba(236,231,225,0.18); border-radius:4px;
    background:var(--deep); color:var(--ink); font-family:var(--mono); font-size:13px; line-height:1.6; resize:vertical;
  }

  ul.notes { margin:0; padding:14px 0 0; border-top:1px solid var(--line); list-style:none; display:grid; gap:9px; font-family:var(--mono); font-size:12.5px; color:var(--faint) }
  ul.notes li { display:grid; grid-template-columns:14px 1fr; gap:10px }
  ul.notes li i { color:var(--accent); font-style:normal }
  ul.notes li span { line-height:1.6; text-wrap:pretty }

  .hide { display:none !important }
  @media (prefers-reduced-motion: reduce) { .caret { animation:none } }
</style></head>
<body>

<header>
  <span class="brand"><i>✶</i>dwell</span>
  <span class="chip"><i></i>127.0.0.1:${opts.port} — yerel</span>
</header>

<main>
  <div class="card">
    <div style="display:grid; gap:14px">
      <p class="eyebrow">Adım 2 / 3 — kimlik</p>
      <h1>Cüzdanını bağla</h1>
      <p class="lede">Kazancın bu adrese gider. İmza yalnızca kimlik kanıtıdır — <b>ağa hiçbir işlem gönderilmez</b>, sıra numarası 0'dır. Özel anahtarın tarayıcıdan çıkmaz.</p>
    </div>

    <div class="term">
      <div class="term-bar"><span>dwell login</span><span id="status">hazır</span></div>
      <div class="log" id="log"></div>

      <div class="addr hide" id="addrbox">
        <span class="k">Bağlı adres</span>
        <span class="v" id="addr"></span>
        <div class="facts">
          <span>ağ <em>testnet</em></span>
          <span>varlık <em>USDC</em></span>
          <span>trustline <em id="trust">—</em></span>
        </div>
      </div>
    </div>

    <div class="manual hide" id="manualbox">
      <p>Freighter yoksa: adresini gir, çıkan XDR'ı cüzdanında ya da Stellar Laboratory'de imzala, sonucu buraya yapıştır.</p>
      <input id="m-addr" placeholder="G… ile başlayan adresin" autocomplete="off" spellcheck="false">
      <button id="m-get" class="linkish" style="justify-self:start; border-bottom-color:rgba(236,231,225,0.35)">XDR oluştur</button>
      <code id="m-xdr" class="hide"></code>
      <textarea id="m-signed" rows="3" placeholder="imzalanmış XDR" class="hide" spellcheck="false"></textarea>
      <button id="m-send" class="hide" style="justify-self:start; padding:11px 18px; font-size:13.5px">İmzayı doğrula</button>
    </div>

    <div style="display:grid; gap:10px">
      <button id="primary" class="primary">Freighter ile bağlan</button>
      <div style="display:flex; flex-wrap:wrap; gap:10px 18px; align-items:center; justify-content:space-between">
        <button id="toggle-manual" class="linkish">Freighter yok mu? XDR'ı elle imzala</button>
      </div>
    </div>

    <ul class="notes">
      <li><i>·</i><span>Bu sayfa yalnızca kendi bilgisayarında çalışır; adres CLI'a lokalden geçer.</span></li>
      <li><i>·</i><span>İmzalanan işlem ağa gönderilemez — sıra numarası 0'dır, yalnızca kimlik kanıtıdır.</span></li>
      <li><i>·</i><span>Özel anahtar hiçbir zaman bu sayfaya veya CLI'a girmez.</span></li>
    </ul>
  </div>
</main>

<footer>
  <span>✶ dwell — testnet</span>
  <span>kapatmak için terminalde Ctrl-C</span>
</footer>

<script>
const NONCE = ${JSON.stringify(opts.nonce)}
const $ = (id) => document.getElementById(id)
const DIM = 'var(--faint)', SOFT = 'var(--muted)', INK = 'var(--ink)'
const OK = 'var(--ok)', ACC = 'var(--accent)', ERR = 'var(--err)'

/* ─────────────────────────── gunluk ─────────────────────────── */

const lines = []
const esc = (s) => String(s).replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]))

function log(text, color) {
  lines.push({ text, color: color || SOFT })
  $('log').innerHTML = lines
    .map((l) => '<div style="color:' + l.color + '">' + esc(l.text) + '</div>')
    .join('') + '<div style="color:' + DIM + '">❯ <span class="caret">▌</span></div>'
}
function status(text, color) {
  $('status').textContent = text
  $('status').style.color = color || DIM
}

log('❯ dwell login', DIM)
log('  cüzdan bağlı değil', DIM)

/* ─────────────────────────── sunucu ─────────────────────────── */

async function post(path, body) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dwell-nonce': NONCE },
    body: JSON.stringify(body),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.hint || j.message || ('HTTP ' + r.status))
  return j
}

/* ─────────────────────────── Freighter ─────────────────────────── */

/**
 * Protokol — @stellar/freighter-api v6 ile ayni.
 *
 * Eklenti window.freighterApi BIRAKMIYOR; o global yalnizca resmi
 * kutuphanenin UMD paketi script etiketiyle yuklendiginde olusuyor. Ilk
 * yazdigimda ona bakiyordum ve Freighter kurulu makinede bile
 * "bulunamadi" diyordu. Eklentinin biraktigi tek sey window.freighter.
 *
 * Ayni mantik sitenin app.js dosyasinda da var; biri degisirse digeri de.
 *
 * DIKKAT: bu blok bir sablon dizesinin ICINDE — backtick kullanma.
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

/* ─────────────────────────── akis ─────────────────────────── */

let busy = false
let done = false

function setPrimary(label, o) {
  const b = $('primary')
  b.textContent = label
  b.disabled = !!(o && (o.busy || o.frozen))
  b.classList.toggle('quiet', !!(o && o.quiet))
}

async function connect() {
  if (busy || done) return
  busy = true
  setPrimary('challenge oluşturuluyor…', { busy: true })
  status('challenge', INK)

  try {
    if (!(await freighterReady())) {
      throw new Error('Freighter bulunamadı — kur ve sayfayı yenile, ya da aşağıdan elle imzala')
    }

    const acc = await fSend({ type: 'REQUEST_ACCESS' })
    if (acc && acc.apiError) throw new Error(acc.apiError.message || 'erişim reddedildi')
    const address = acc && acc.publicKey
    if (!address) throw new Error('Freighter adres vermedi')

    const ch = await post('/challenge', { address })
    log('→ challenge oluşturuldu (seq 0, ağa gönderilmeyecek)', SOFT)

    status('imza bekleniyor', INK)
    setPrimary('Freighter\\u2019da onayla…', { busy: true })
    log('⋯ Freighter penceresinde imza bekleniyor', INK)

    const signed = await fSend({
      type: 'SUBMIT_TRANSACTION',
      transactionXdr: ch.transaction,
      networkPassphrase: ch.network_passphrase,
      accountToSign: address,
    })
    if (signed && signed.apiError) throw new Error(signed.apiError.message || 'imza reddedildi')
    if (!signed || !signed.signedTransaction) throw new Error('imza alınamadı')

    await finish(address, signed.signedTransaction)
  } catch (e) {
    fail(e)
  } finally {
    busy = false
  }
}

async function finish(address, signedXdr) {
  log('✓ imza alındı', ACC)
  status('doğrulanıyor', INK)
  setPrimary('doğrulanıyor…', { busy: true })
  log('⋯ imza doğrulanıyor', INK)

  const res = await post('/verify', { address, transaction: signedXdr })

  done = true
  log('✓ doğrulandı — kazanç bu adrese gidecek', ACC)
  log('✓ oturum kaydedildi ~/.dwell/credentials.json', DIM)
  status('bağlı', ACC)

  $('addr').textContent = res.publisherId
  $('addrbox').classList.remove('hide')
  $('manualbox').classList.add('hide')
  $('toggle-manual').classList.add('hide')
  setPrimary('Bağlandı — terminale dönebilirsin', { quiet: true, frozen: true })

  // Trustline'i GERCEKTEN sor. Odemeyi engelleyen sey bu ve kullanicinin
  // baska turlu ogrenmesinin yolu yok — tasarimda sabit "var" yaziyordu,
  // dogru olmadigi durumda en pahali yalan o olurdu.
  checkTrust(res.publisherId)
}

async function checkTrust(address) {
  try {
    const r = await post('/trustline', { address })
    if (r.usdc) {
      $('trust').textContent = 'var'
      $('trust').style.color = OK
    } else {
      $('trust').textContent = 'YOK'
      $('trust').style.color = ACC
      log('⚠ cüzdanın USDC kabul etmiyor — bu haliyle ödeme yapılamaz', ACC)
      log('  kazanmaya devam edersin, para hesabında bekler', DIM)
    }
  } catch {
    $('trust').textContent = 'bakılamadı'
  }
}

function fail(e) {
  const msg = (e && e.message) ? e.message : String(e)
  log('✗ ' + msg, ERR)
  status('hata', ERR)
  setPrimary('Tekrar dene', {})
}

$('primary').onclick = connect

/* ─────────────────────────── elle imza ─────────────────────────── */

$('toggle-manual').onclick = () => {
  const gizli = $('manualbox').classList.toggle('hide')
  $('toggle-manual').textContent = gizli
    ? 'Freighter yok mu? XDR\\u2019ı elle imzala'
    : 'XDR\\u2019ı elle imzalamayı kapat'
}

$('m-get').onclick = async () => {
  const address = $('m-addr').value.trim()
  if (!address) return
  try {
    const ch = await post('/challenge', { address })
    $('m-xdr').textContent = ch.transaction
    $('m-xdr').classList.remove('hide')
    $('m-signed').classList.remove('hide')
    $('m-send').classList.remove('hide')
    log('→ challenge oluşturuldu (elle imza)', SOFT)
  } catch (e) { fail(e) }
}

$('m-send').onclick = async () => {
  const address = $('m-addr').value.trim()
  const xdr = $('m-signed').value.trim()
  if (!address || !xdr) return
  try { await finish(address, xdr) } catch (e) { fail(e) }
}

// Eklenti icerik betigi sayfadan SONRA yuklenebiliyor; bir kez daha bak.
freighterReady().then((ok) => {
  if (ok) return
  setTimeout(() => freighterReady().then((ok2) => {
    if (!ok2) log('  Freighter görünmüyor — kuruluysa sayfayı yenile', DIM)
  }), 900)
})
</script>
</body>
</html>`
}
