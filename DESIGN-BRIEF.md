# Site — tasarım brief'i

> 2026-08-17. Tasarım araçlarına (v0, Lovable, Bolt, Figma Make) verilecek
> prompt aşağıda, `PROMPT` başlığı altında. Öncesindeki kısım senin için:
> neyin gerçek olduğu, neyin olmadığı.

## Üç alan

| Alan | Arka uç | Şimdi |
|---|---|---|
| Landing `/` | gerekmiyor | **yap** |
| Yayıncı paneli `/app` | hazır | **yap** |
| Reklamveren `/advertisers` | **yok** | sadece teklif sayfası + form |

## Gerçekten var olan uçlar

```
GET  /health
GET  /v1/config
POST /v1/auth/challenge     { address }        → { transaction, network_passphrase }
POST /v1/auth/verify        { address, transaction } → { token, publisherId }
POST /v1/ads/next           (yalnızca CLI kullanır)
POST /v1/impressions        (yalnızca CLI kullanır)
GET  /v1/me/balance         → aşağıdaki JSON
```

`/v1/me/balance` — panelin tek veri kaynağı:

```json
{
  "pendingStroops": "0",
  "payableStroops": "575000",
  "inFlightStroops": "0",
  "lifetimeStroops": "575000",
  "payoutThresholdStroops": "10000000",
  "recentPayouts": [],
  "blockedReason": "esik 10000000 stroop, bakiye 575000"
}
```

Stroop = USDC'nin 10 milyonda biri. `575000` stroop = **$0,0575**.

## Var OLMAYAN şeyler — bunları tasarlatma

Tasarım araçları bunları kendiliğinden ekler. Eklerse çalışmayan buton olur:

- Cüzdan değiştirme ucu yok (panelde gösterilir ama düzenlenemez)
- Cihaz/oturum iptal ucu yok
- Kampanya oluşturma, para yatırma, reklamveren istatistiği — hiçbiri yok
- E-posta/şifre girişi yok ve olmayacak: **kimlik cüzdandır**
- Bildirim ayarları, profil, avatar, takım yönetimi — hiçbiri yok

## Dil kararı

Prompt İngilizce yazıldı (tasarım araçları İngilizce'de belirgin şekilde
daha iyi). Site metni Türkçe olacaksa prompt'un sonundaki satırı değiştir.

Not: CLI çıktısı şu an Türkçe, reklam metinleri İngilizce. İkisinin bir
gün tutarlı olması lazım — ama o ayrı bir karar, siteyi bloklamasın.

---

# PROMPT

Aşağıdakini olduğu gibi kopyala.

---

## Product

**Dwell** — a terminal-native ad marketplace. Developers install a small CLI;
while they wait for their AI coding assistant to respond, one sponsored line
of text appears in the status line at the bottom of their terminal. When the
answer arrives, the line disappears. Developers get paid in USDC on Stellar.

The entire product is **one line of monospace text**. That is the hero, the
proof, and the thing to design around. Here is a real one:

```
✶ Firecrawl — docs to LLM-ready markdown · firecrawl.dev
```

Currently on Stellar **testnet**. Real money does not move yet. Do not hide
this; say it plainly where relevant.

## Audience

Developers who use Claude Code and similar tools. They are skeptical of
anything that installs into their machine, allergic to marketing language,
and will read the privacy section before the pricing section. Write for
someone who will `cat` the install script before running it.

## Routes

Build exactly these. No others.

```
/               landing
/app            publisher dashboard (wallet-gated)
/advertisers    advertiser offer + contact form
/privacy        what we send and what we never send
```

---

## 1. Landing `/`

### Sections, in order

**a. Hero**
- Headline, one sentence, concrete. Not "monetize your workflow".
- The ad line itself, rendered as it appears in a terminal — monospace,
  the `✶` in the accent color. This is the single most important element
  on the page. Consider showing it inside a realistic terminal frame with
  a prompt line above it.
- Primary CTA: install command in a copy-to-clipboard field:
  `npx dwell-cli init`
  Clicking copies; the button label changes to "Copied" for 2 seconds,
  then reverts.
- Secondary link: "How it works" → scrolls to section (c).

**b. The honest line**
One short paragraph, immediately below the hero, stating: it only appears
while you are waiting, it disappears when the answer arrives, it never
interrupts, and it is off when you are idle. This preempts the reader's
first objection.

**c. How it works — three steps**
1. Install — one command, edits only your Claude Code settings
2. Wait — the line shows while the model is working
3. Get paid — USDC to your Stellar wallet, you connect it, we never see
   your keys

Do not use three identical rounded cards with circular icons. Find another
structure — a numbered horizontal sequence, a diagram, a timeline, a table.

**d. What we send**
A two-column comparison, plainly worded:

| We send | We never send |
|---|---|
| impression id, campaign id, duration | your directory path |
| session id, client version | your file names |
| OS and architecture | your prompts, your code |

Below it: a link to `/privacy`.

**e. Earnings, honestly**
State the current status: testnet, payouts proven on-chain but not enabled
for real users yet. Include a link to a real transaction:
`https://stellar.expert/explorer/testnet/tx/f2bf54a8d14e0f27eb9977bfd762b8614fb5ceacb0226b1417af7e70b7b645ef`
Do not invent earnings figures. Do not show "$X/month" projections.

**f. Uninstall**
Short section. `dwell uninstall` removes only our own entries and never
touches the user's own settings. Developers decide to install based on how
easy it is to leave.

**g. Advertiser strip**
One line + button → `/advertisers`.

**h. Footer**
GitHub link, `/privacy`, status: "testnet". Nothing else. No newsletter,
no social icons unless real accounts exist.

### Explicitly do NOT include on the landing page
- A "Trusted by" logo wall (there are no customers yet)
- Testimonials (there are none)
- Pricing tiers (there is no pricing)
- A stats bar with invented numbers ("10,000 developers")
- A blog teaser, a roadmap section, an FAQ accordion with filler questions

---

## 2. Publisher dashboard `/app`

Wallet-gated. There is no email, no password, no signup. Identity **is** the
Stellar wallet address.

### State A — not connected
- One card, centered, minimal.
- Explain in one sentence: connect the wallet where you want to be paid.
- Button: **Connect Freighter**
- Secondary, smaller: "Don't have Freighter?" → `https://freighter.app`
- If the Freighter browser extension is not detected, the button is replaced
  by an inline message with the install link. Do not show a disabled button
  with no explanation.

Connect flow (three visible states, all needed):
1. `Requesting access…` — waiting for the extension popup
2. `Waiting for signature…` — the challenge is being signed
3. Error state — the message from the server, rendered in full, with a
   **Try again** button

### State B — connected, no earnings yet
The wallet is connected but the CLI is not installed or hasn't reported yet.
- Show the wallet address in full (not truncated — the user must be able to
  verify where their money goes)
- Big, calm empty state: "No impressions yet."
- The install command with a copy button, same component as the landing hero
- One line: it can take a few minutes after your first session

### State C — connected, with data
The main screen. Four numbers, **not** four identical stat cards — give the
payable amount visual primacy, the others are context.

| Field | Source | Meaning to show |
|---|---|---|
| Payable | `payableStroops` | verified, yours |
| Pending | `pendingStroops` | counted, not verified yet, **may not survive** |
| In flight | `inFlightStroops` | sent to the chain, awaiting confirmation — **hide this row entirely when zero** |
| Lifetime | `lifetimeStroops` | total ever earned, secondary |

Below the numbers:

- **Progress to payout.** A bar from 0 to `payoutThresholdStroops`, with the
  remaining amount in words: "$0.94 to go". When the threshold is reached,
  the bar is replaced by: "Threshold reached — included in the next payout
  round."
- **`blockedReason`**, when present and when it is *not* just the threshold.
  Render it as an informational row, not an error. It explains why a payout
  hasn't happened (e.g. a 72-hour hold after changing wallets).
- **Wallet** — full address, a copy button, and a link to
  `https://stellar.expert/explorer/testnet/account/<address>`.
  Note in small text: to change your payout wallet, run `dwell login --force`.
  There is no wallet-change button — do not add one.
- **Recent payouts** — a table from `recentPayouts`. Columns: date, amount,
  status, transaction. The transaction is a link to
  `https://stellar.expert/explorer/testnet/tx/<txHash>`.
  When the array is empty, show a one-line empty state, not a skeleton.

### States that must all be designed
Design tools skip these. Every one is required:

- Loading (first fetch)
- Network error — the API is unreachable. Message plus **Retry**.
- 401 — the session expired. Message: reconnect your wallet, with the
  connect button.
- Zero balance, zero payouts (State B)
- Threshold not reached vs. reached
- `blockedReason` present vs. absent
- In-flight amount zero (row hidden) vs. non-zero

### Amount formatting
The API returns stroops as decimal strings. 1 USDC = 10,000,000 stroops.
Display as USD with enough decimals to be honest: `575000` → `$0.0575`.
Never round to `$0.06`. Never display raw stroops to the user, but show them
on hover or in a tooltip for the curious.

Parse with BigInt, never `parseFloat` — these are money values.

---

## 3. Advertisers `/advertisers`

There is no advertiser backend yet. **Do not design a dashboard, a campaign
builder, a budget slider, or an analytics chart.** A page that promises a
self-serve panel that doesn't exist is worse than no page.

What this page is:
- What the placement is, with the same real ad line as the landing hero
- Who sees it: developers, at the moment they are idle and waiting
- The format constraints, stated plainly: one line, plain text, no images,
  no animation, no tracking pixels, max ~80 characters
- What we measure: display duration, and only impressions longer than 10
  seconds count
- A short form: name, email, company, website, what you'd advertise, budget
  range. On submit: a confirmation state that says a human will reply.
- No pricing table. Pricing is a conversation right now.

---

## 4. Privacy `/privacy`

Plain prose, no legal boilerplate generator output. Cover:
- The exact list of fields sent (same as the landing table, expanded)
- That the project identifier is a hash generated with a salt that never
  leaves the machine — raw paths never reach the network
- That IP addresses are hashed, never stored raw
- That the wallet private key never enters the CLI or the site
- How to remove everything: `dwell uninstall`

---

## Design direction

The product is a single line of text that appears in the dark, does its job,
and disappears. Restraint is the brand. Anything loud contradicts the thing
being sold.

**Typography.** Monospace should carry more of the page than usual — this is
a CLI product and the ad unit itself is monospace. Use it for data, labels,
commands, addresses, and amounts. Pair it with one well-set text face for
prose and headlines. Do not use Inter or Space Grotesk; they are the current
default and read as generic.

**Color.** Dwell's accent is an orange used for the `✶` glyph. Build the
palette around it. Neutrals should be biased slightly toward that hue rather
than pure grey. Support light and dark; the viewer's system preference wins
by default.

**Numbers.** Use tabular figures wherever amounts align in columns.

### Do not produce any of these
These are the current generic-AI-design defaults. If the output contains one,
it is wrong:

- Purple-to-blue gradient hero on white
- Dark hero with a single acid-green or vermilion accent
- Warm cream background (#F4F1EA) with a serif display face and terracotta accent
- Floating dashboard screenshots tilted at an angle, with drop shadows
- Three feature cards with circular pastel icons
- Emoji as section markers
- Everything centered
- Bento grids
- A large blurred gradient blob behind the hero
- Glassmorphism, `backdrop-filter` cards
- Fake logo walls, fake avatars, fake testimonial photos
- Animated counters counting up on scroll

### Take one real risk
Pick one place — most likely the hero — and do something specific to this
product that another site could not reuse. The obvious candidate: show the
ad line behaving exactly as it does in reality, appearing while "waiting"
and vanishing when the "answer" arrives. Make the visitor understand the
product by watching it, before they read a word about it.

## Technical requirements

- Responsive from 360px up. Tables and code blocks scroll inside their own
  container; the page body never scrolls sideways.
- Keyboard accessible: visible focus states on every interactive element.
- Respect `prefers-reduced-motion` — the hero animation must have a static
  fallback.
- Every button and link must have a real destination or a defined action.
  If a feature does not exist, do not add a button for it.
- Copy-to-clipboard fields must show a confirmation state.
- No external font CDNs; self-host or use system stacks.

## Deliverable

React + Tailwind, or plain HTML/CSS. Every route, every state listed above.
Use realistic content throughout — the actual ad lines (Firecrawl, Resend,
Neon), the actual command `npx dwell-cli init`, the actual transaction hash.
No lorem ipsum, no placeholder names.

All copy in English.
