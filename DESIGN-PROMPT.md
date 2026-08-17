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

Currently on Stellar **testnet**. Money moves — advertisers deposit, publishers
get paid on-chain — but it is test money. Say this plainly where relevant;
do not hide it and do not apologise for it.

## Audience

Two, and they want opposite things:

**Developers** who use Claude Code. Skeptical of anything that installs into
their machine, allergic to marketing language, will read the privacy section
before anything else. Write for someone who will `cat` a script before running it.

**Advertisers** — small dev-tool companies. They want to know what the
placement looks like, who sees it, and what it costs. They do not want a
funnel.

## Routes

Build exactly these. No others.

```
/                  landing (for developers)
/app               publisher dashboard        — wallet-gated
/advertisers       what the placement is + how to start
/advertisers/app   advertiser dashboard       — wallet-gated
/privacy           what we send and never send
```

## Identity — read this before designing any auth

There is **no email, no password, no signup form, anywhere**. Identity is a
Stellar wallet, verified by signature (SEP-10). The same person can be both a
publisher and an advertiser, but those are two separate logins with separate
tokens.

Login flow, both roles, three visible states — all three required:

1. `Requesting access…` — waiting for the Freighter extension popup
2. `Waiting for signature…` — the challenge is being signed
3. Error — show the server's message in full, with a **Try again** button

If the Freighter extension is not detected, replace the button with an inline
message and a link to `https://freighter.app`. Never show a dead disabled
button with no explanation.

---

## 1. Landing `/`

### Sections, in order

**a. Hero**
- Headline, one sentence, concrete. Not "monetize your workflow".
- The ad line itself, rendered as it appears in a terminal — monospace, the
  `✶` in the accent color, inside a realistic terminal frame with a prompt
  line above it. This is the single most important element on the page.
- Primary CTA: copy-to-clipboard field with `npx dwellsh init`. Clicking
  copies; the label becomes "Copied" for 2 seconds, then reverts.
- Secondary: "How it works" → scrolls to (c).

**b. The honest line**
One paragraph directly under the hero: it only appears while you are waiting,
it disappears when the answer arrives, it never interrupts, and nothing shows
when you are idle. This preempts the reader's first objection.

**c. How it works — three steps**
1. Install — one command, edits only your Claude Code settings
2. Wait — the line shows while the model is working
3. Get paid — USDC to your Stellar wallet; you connect it, we never see your keys

Do not use three identical rounded cards with circular icons. Use another
structure: a numbered horizontal sequence, a diagram, a timeline, a table.

**d. What we send**

| We send | We never send |
|---|---|
| impression id, campaign id, duration | your directory path |
| session id, client version | your file names |
| OS and architecture | your prompts, your code |

Link to `/privacy` below it.

**e. Proof, not projections**
State the status: testnet, payouts working on-chain. Link a real transaction:
`https://stellar.expert/explorer/testnet/tx/9cbb1a573c4a3eeacefde360280c93d08df1cc0b7522d82e3b411898aae6ad86`
Do not invent earnings figures. No "$X/month" projections. No stats bar with
made-up numbers.

**f. Uninstall**
Short. `dwell uninstall` removes only our own entries and never touches the
user's own settings. Developers decide to install based on how easy it is to leave.

**g. Advertiser strip** — one line + button → `/advertisers`.

**h. Footer** — GitHub, `/privacy`, "testnet". Nothing else. No newsletter,
no social icons unless real accounts exist.

### Do NOT include
A "Trusted by" logo wall, testimonials, pricing tiers, invented stats, a blog
teaser, a roadmap, or an FAQ accordion with filler questions. There are no
customers yet and pretending otherwise is the fastest way to lose this audience.

---

## 2. Publisher dashboard `/app`

### State A — not connected
One centered card. One sentence: connect the wallet where you want to be paid.
Button: **Connect Freighter**. Login flow as described above.

### State B — connected, no earnings yet
- Wallet address **in full** (never truncated — the user must be able to
  verify where their money goes)
- Calm empty state: "No impressions yet."
- The install command with a copy button
- One line: it can take a few minutes after your first session

### State C — connected, with data

Four numbers, **not** four identical stat cards. Give payable visual primacy.

| Field | Source | What it means |
|---|---|---|
| Payable | `payableStroops` | verified, yours |
| Pending | `pendingStroops` | counted, not verified yet — **may not survive** |
| In flight | `inFlightStroops` | sent to the chain, awaiting confirmation — **hide the row entirely when zero** |
| Lifetime | `lifetimeStroops` | total ever earned, secondary |

Below:

- **Progress to payout.** Bar from 0 to `payoutThresholdStroops`, with the
  remainder in words: "$0.94 to go". At threshold, replace with "Threshold
  reached — included in the next payout round."
- **`blockedReason`** when present and not merely the threshold. An
  informational row, not an error — it explains why a payout hasn't happened.
- **Wallet** — full address, copy button, link to
  `https://stellar.expert/explorer/testnet/account/<address>`. Small text: to
  change your payout wallet, run `dwell login --force`. **No wallet-change
  button** — do not add one.
- **Recent payouts** — table from `recentPayouts`: date, amount, status,
  transaction linking to `https://stellar.expert/explorer/testnet/tx/<txHash>`.
  Empty array → one-line empty state, not a skeleton.

### State D — USDC trustline missing ⚠ REQUIRED

A Stellar wallet must explicitly opt in to each asset it can receive. Without
a USDC trustline, **the payout silently does not happen** — the money waits in
the ledger and the user has no way to know why. This happened in a real test.

Read the connected wallet's balances from Horizon
(`https://horizon-testnet.stellar.org/accounts/<address>`) and check for a
balance entry with `asset_code: "USDC"` and
`asset_issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"`.

If absent, show a prominent banner above everything else:

- Plain explanation: your wallet cannot receive USDC yet, so payouts will not
  go out. Do not use the word "trustline" alone without explaining it.
- Button: **Enable USDC** → build a `changeTrust` operation and have Freighter
  sign and submit it.
- Note the cost: 0.5 XLM stays locked in your wallet while it is enabled, and
  is returned if you remove it.
- If the wallet has less than ~1 XLM, say that instead and explain they need
  a little XLM first.
- After success, re-check and dismiss the banner.

This banner outranks the balance numbers. Earning money you cannot receive is
worse than not earning.

### Every state must be designed
Loading · network error (with **Retry**) · 401 session expired (reconnect) ·
zero balance · below vs. at threshold · `blockedReason` present vs. absent ·
in-flight zero (hidden) vs. non-zero · trustline missing vs. present.

### Amount formatting
The API returns stroops as decimal strings. 1 USDC = 10,000,000 stroops.
`575000` → `$0.0575`. Never round to `$0.06`. Parse with **BigInt**, never
`parseFloat` — these are money values. Show raw stroops on hover for the curious.

---

## 3. Advertisers `/advertisers`

A page, not a funnel. Sections:

- What the placement is, with the same real ad line as the landing hero
- Who sees it: developers, at the moment they are idle and waiting for a model
- Format constraints, plainly: one line, plain text, max 80 characters
  including the brand and domain. No images, no animation, no tracking pixels.
- What counts: only impressions displayed longer than 10 seconds
- What it costs: you set a CPM, minimum $0.10 per 1000 impressions. Publishers
  receive 50%. No pricing table — the number is yours to choose.
- CTA: **Connect wallet to start** → `/advertisers/app`

No contact form. Self-serve works; a form would be a downgrade.

---

## 4. Advertiser dashboard `/advertisers/app`

Wallet-gated, `role: "advertiser"` on login.

### State A — not connected
Same login card as the publisher side, different copy: connect the wallet you
will fund campaigns from. **The wallet matters** — see deposits below.

### State B — connected, zero balance
The deposit instructions are the entire screen. Nothing else competes.

From `deposit` in the response:
- The address, in full, with a copy button, and a QR code
- The asset: USDC, with the issuer address shown in small monospace (an
  advertiser who knows Stellar will check it; one who doesn't will ignore it)
- **The critical warning, and it must be impossible to miss:** payments are
  matched by *sender address*. Only USDC sent **from their own connected
  wallet** is credited. Money sent from an exchange arrives but cannot be
  matched to them.
- After sending: credited within about 20 seconds. A "checking…" indicator
  that polls `/v1/advertiser/me` and updates when the balance changes.

### State C — connected, funded

**Balance block**
- `balanceStroops` — the headline number
- `spendableStroops` — shown **only when it differs** from the balance. When
  it does, explain the difference in one line: the rest is reserved for ads
  already delivered but not yet reported.
- An **Add funds** action that reopens the deposit instructions.

**Campaign list**
Each campaign shows:
- `preview` — rendered exactly as it appears in a terminal, monospace, `✶` in
  the accent color. This is the point of the product; make it the visual anchor
  of the row.
- status: `paused` / `active` / `exhausted`
- CPM, formatted as USD (`bidCpmStroops` → `$40.00 CPM`), with cost per
  impression underneath (`$0.04`)
- Toggle: **Activate** / **Pause** → `POST /v1/advertiser/campaigns/:id/status`
  - 402 response → inline message: no budget, add funds. Do not use a modal.
- No delete, no edit — the API does not support them. Do not add the buttons.

**New campaign form**

Fields: `brand`, `text`, `cta`, `bidCpmStroops`.

This form is where the design earns its keep. It must contain a **live preview**
that renders exactly what a developer will see:

```
✶ {brand} — {text} · {cta}
```

with a live character count against the 80-character limit, counting the whole
line, not the individual field. Turn red past the limit before submitting.

Client-side validation mirroring the server:
- Total line ≤ 80 characters
- `cta` must be a bare domain — reject `https://`, paths, query strings.
  Explain why: the developer must land where the line says they will.
- CPM at least $0.10 per 1000. Take the CPM in dollars and convert to stroops
  (`$40` → `"400000000"`); do not make the user think in stroops.
- Show the publisher's 50% share as a note, not an input. It is fixed.

On the server's 400, the response includes a `field` — highlight that input
and show the `hint` beneath it.

After creating: the campaign appears **paused**. Say why in one line — you
review it, then start it. A typo shown to thousands of people cannot be undone
and has already been paid for.

### Every state must be designed
Loading · network error · 401 · zero balance (deposit screen) · funded with no
campaigns · campaigns paused · campaigns active · activation refused for lack
of budget · form validation errors per field · line-too-long while typing.

---

---

## 6. The ad preview — one component, three places

This is the most important component on the site. Build it once and reuse it.

Dwell sells a single line of text in a terminal. Describing it never works;
**showing it** does. Every place the product is explained, this component
appears — rendering the ad exactly as a developer sees it, not as a styled
marketing mock-up.

### What it renders

A faithful terminal fragment: dark ground, monospace, real spacing, real
colors.

```
✶ Firecrawl — docs to LLM-ready markdown · firecrawl.dev        Edit · 2.8s
└┬┘ └───┬──┘   └──────────┬───────────┘   └─────┬─────┘        └────┬────┘
 │      │                 │                     │                   │
 │      │                 │                     │      what the assistant
 │      │                 │                     │      is doing right now
 │      │                 │                     └─ domain, dimmed
 │      │                 └─ the message
 │      └─ brand, bold
 └─ accent glyph
```

The right-hand side matters as much as the ad. The status line is the
developer's own; we are a guest on it. Showing the assistant's current
activity next to the ad is what makes the line feel earned rather than
imposed — the developer gets something too. Render it as real context
(`Edit · 2.8s`, `Search · 12.4s`, `Thinking · 41.0s`), dimmed, right-aligned.

### Props

```
brand   string   "Firecrawl"
text    string   "docs to LLM-ready markdown"
cta     string   "firecrawl.dev"
status  string   optional, e.g. "Edit · 2.8s" — the assistant's activity
state   "waiting" | "idle"
```

In `idle`, the ad is **gone** and only the assistant status remains. That
contrast is the product's whole argument; the component must be able to show
both.

### Where it appears

1. **Landing hero** — animated. The line appears when "waiting" begins,
   rotates every few seconds, disappears when the "answer" arrives. This is
   the one real risk the design takes; let the visitor understand the product
   by watching it before reading a word. Static fallback under
   `prefers-reduced-motion`.

2. **Advertiser campaign form** — live, updating on every keystroke, with the
   80-character counter measuring the whole composed line. The advertiser is
   writing a line of text that will sit in thousands of terminals; they should
   see it as it will be, at the moment they write it.

3. **Advertiser campaign list** — one per row, using the `preview` string the
   API already returns. The preview is the row's visual anchor, not a
   secondary detail.

### Downloadable image

On the advertiser side, the preview has a **Download image** action that
exports the rendered line as a PNG (roughly 1200×300, 2× for retina). Render
it client-side to a canvas — no server round-trip, no external service.

Advertisers ask "what does it look like?" before they ask anything else, and
they will paste the answer into Slack for someone who is not on the call. Give
them a file that answers it. Same rule as everywhere else: the image shows the
real line, never a dressed-up version.

### Do not
- Do not add a logo slot. The line is plain text in a terminal; there is no
  image channel and inventing one in the mock-up would be a lie about the
  product.
- Do not add rounded corners, gradients, or a drop shadow *to the line itself*.
  Frame the terminal however you like; the line inside it must be exactly what
  gets printed.
- Do not render it in a proportional typeface anywhere, at any size.

---

## 7. Privacy `/privacy`

Plain prose, not legal-boilerplate output:
- The exact list of fields sent
- The project identifier is hashed with a salt that never leaves the machine —
  raw paths never reach the network
- IP addresses are hashed, never stored raw
- The wallet private key never enters the CLI or the site
- Removal: `dwell uninstall`

---

## Design direction

The product is a single line of text that appears in the dark, does its job,
and disappears. Restraint is the brand. Anything loud contradicts the thing
being sold.

**Typography.** Monospace should carry more of the page than usual — this is a
CLI product and the ad unit itself is monospace. Use it for data, labels,
commands, addresses, amounts, and every ad preview. Pair it with one well-set
text face for prose and headlines. Do not use Inter or Space Grotesk; they are
the current default and read as generic.

**Color.** Dwell's accent is the orange of the `✶` glyph. Build the palette
around it; bias the neutrals slightly toward that hue rather than pure grey.
Support light and dark, system preference by default.

**Numbers.** Tabular figures wherever amounts align in columns.

### Do not produce any of these
- Purple-to-blue gradient hero on white
- Dark hero with a single acid-green or vermilion accent
- Warm cream (#F4F1EA) + serif display + terracotta accent
- Floating dashboard screenshots tilted at an angle with drop shadows
- Three feature cards with circular pastel icons
- Emoji as section markers
- Everything centered
- Bento grids
- A large blurred gradient blob behind the hero
- Glassmorphism / `backdrop-filter` cards
- Fake logo walls, fake avatars, fake testimonial photos
- Animated counters counting up on scroll

### Take one real risk
Pick one place — most likely the hero — and do something specific to this
product that no other site could reuse. The obvious candidate: show the ad line
behaving exactly as it does in reality, appearing while "waiting" and vanishing
when the "answer" arrives. Let the visitor understand the product by watching
it, before reading a word.

## Technical requirements

- Responsive from 360px. Tables and code blocks scroll inside their own
  container; the page body never scrolls sideways.
- Visible focus states on every interactive element.
- Respect `prefers-reduced-motion` — the hero animation needs a static fallback.
- Every button and link has a real destination or a defined action. If a
  feature does not exist, there is no button for it.
- Copy-to-clipboard fields show a confirmation state.
- No external font CDNs.
- All money math with BigInt.

## Deliverable

React + Tailwind, or plain HTML/CSS. Every route, every state listed above.
Realistic content throughout — the actual ad lines (Firecrawl, Resend, Neon),
the actual command `npx dwellsh init`, the actual API shapes, the actual
transaction hash. No lorem ipsum, no placeholder names.

All copy in English.
