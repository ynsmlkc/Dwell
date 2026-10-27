# Dwell

> Terminal-native ad marketplace that turns AI coding wait states into revenue — paid out in USDC on Stellar.

While Claude Code is thinking, a single clearly-disclosed sponsored line appears. Verified impressions accrue to the developer's balance, which they can withdraw in USDC on Stellar at any time, in any amount. No bank account, no country restrictions, no minimum threshold.

**Status: live on Stellar testnet.** The CLI is on npm ([`dwellsh`](https://www.npmjs.com/package/dwellsh)), the server runs at [dwellsh.dev](https://dwellsh.dev), wallet login (SEP-10 via Freighter) and the advertiser panel work, and real USDC payouts have settled on testnet. Mainnet is not live: no real money moves yet. Runs on macOS and Linux; Windows support is new in 0.1.16 and still being verified.

---

## Where it works

Ads are shown, and impressions counted, **only in Claude Code running in a terminal** — including the integrated terminal of VS Code, Cursor or JetBrains. Billing rests entirely on the `statusLine`, and Claude Code's documentation does not say that the VS Code / JetBrains extension panels or the desktop app render a custom `statusLine`, so Dwell shows nothing and counts nothing there. `dwell doctor` says this too.

On Windows, Claude Code runs the `statusLine` and hook commands through Git Bash, or through PowerShell when Git for Windows is not installed. Dwell writes commands that work in both (and in `cmd`): the program is never quoted, and paths use forward slashes. `dwell doctor` runs the installed commands in every available shell and shows which one Claude Code uses; `dwell doctor --fix` rewrites installs made by older versions.

## Why Stellar

Per-impression amounts are tiny — a fraction of a cent. On traditional rails the fixed cost of a payout (transfer fee, FX spread, compliance overhead) routinely exceeds the payout itself, which forces platforms into high thresholds, monthly batches, and a short list of supported countries. Developers in Turkey, Latin America, South Asia and Africa generate value they cannot collect.

Stellar's per-operation fee is around 0.00001 XLM, which makes even a few-cent payout economically sane — so there is no threshold at all: a developer withdraws whatever they have earned, whenever they want. That is the whole reason this product can exist for developers outside a handful of countries.

## What has been measured

Rather than assume, the two riskiest assumptions were probed first. Throwaway scripts live in [`spikes/`](spikes/).

**Ad surface** — Claude Code exposes official extension points (`statusLine`, `spinnerVerbs`). No patching of the host application, no output interception.

| Question | Result |
|---|---|
| Does the line refresh while the model is working? | Yes — 100% of qualifying windows, ~34 refreshes each |
| How much of the wait is actually long enough to sell? | 50% of turns exceed 10s; p50 37s, p90 322s |
| What does the client cost? | ~13,700 invocations/day/session; shim round-trip 22ms |

An early version of the measurement defined the wait window as tool execution time. That was wrong — tools finish in under a second and the inventory looked like zero. The wait a user actually experiences is the model thinking, which lives in the gaps *between* hooks. The correction is documented in ADR-001.

**Payment rail** — a testnet script pays multiple destinations in one transaction, including a deliberately broken one, to prove the failure modes:

- One destination without a trustline fails the entire transaction
- A failed transaction still enters the ledger, still charges a fee, and still has a hash — so `settled` must mean `successful === true`, not "it landed"
- Fees are per-operation, so batching saves nothing; it only concentrates risk

## Architecture

```
Claude Code
    │  hooks: UserPromptSubmit → Stop
    ▼
statusLine shim ──22ms──> dwelld ──> turn state machine
    │                        │            │
    └──── ✶ Sponsor … ───────┘       disk queue
                                          │
                                          ▼
                                   Dwell backend → Stellar
```

The daemon holds the ad in memory so the shim never touches the network. If the daemon is down, unreachable, or unsure, the shim prints **nothing** — never an error, never a stale line. Fail closed.

## Design principles

**Disclosure is not optional.** Every surface, including the spinner verb, starts with `✶`. An ad is never formatted to look like the tool's own output.

**Ad copy is hostile input.** A creative containing control characters is an attack attempt, not sloppy input — it is rejected, not sanitized and served. 20 attack vectors are covered by tests, from OSC 52 clipboard writes to bidi override.

**Only what is measured is billed.** The ad is shown only during an active turn plus a short grace period. Idle time is not shown and not counted, even though it could be.

**Money is integers.** Amounts are branded `bigint` stroops (1e-7). Floats are banned. The ledger is double-entry and every reversal is a negation of the original entries, never a recomputation.

## Repo layout

```
PROJECT.md              living design document — ADRs, measurements, open questions
packages/protocol/      shared types, money, sanitizer, schemas
packages/cli/           the `dwellsh` npm package: daemon, IPC (unix socket / Windows named pipe), shim, disk queue
packages/server/        ad serving, impression ingest and verification, ledger, wallet login, payouts, the site
packages/payments/      Stellar rail: SEP-10, payouts, trustlines
contracts/vault/        Soroban escrow for advertiser balances (not yet used by the server)
spikes/                 throwaway probes — deleted once folded into the doc
```

`PROJECT.md` is the source of truth. Every architectural decision records the alternatives it rejected and why, and §15 keeps an honest list of unsolved weaknesses.

## Development

```bash
pnpm install
pnpm test        # ~740 tests across the packages
pnpm typecheck
```

Requires Node 20+ and pnpm.

To run the Stellar payment spike against testnet:

```bash
cd spikes/stellar-payout && npm install && npm run spike
```

## Status

- [x] Assumptions measured — ad surface and payment rail both viable
- [x] `protocol` — money, sanitizer, schemas, injectable clock
- [x] Daemon — turn state machine, IPC, shim, disk queue (macOS, Linux; Windows in progress)
- [x] Backend — ad serving, impression ingest, ledger (live at dwellsh.dev)
- [x] Wallet linking — SEP-10 via Freighter
- [x] Payouts — on-demand USDC withdrawals on Stellar testnet
- [x] Advertiser panel — self-serve campaigns and budgets
- [ ] Mainnet

Click attribution and adapters beyond Claude Code are explicitly out of scope for now.
