# Dwell

> Terminal-native ad marketplace that turns AI coding wait states into revenue — paid out in USDC on Stellar.

While Claude Code is thinking, a single clearly-disclosed sponsored line appears. Verified impressions accrue to the developer's balance and settle automatically in USDC on Stellar. No bank account, no country restrictions, no minimum threshold.

**Status: pre-alpha.** The design is worked out in detail, the risky assumptions have been measured, and the client-side spine is being built. Nothing is deployed and no real money has moved outside of Stellar testnet.

---

## Why Stellar

Per-impression amounts are tiny — a fraction of a cent. On traditional rails the fixed cost of a payout (transfer fee, FX spread, compliance overhead) routinely exceeds the payout itself, which forces platforms into high thresholds, monthly batches, and a short list of supported countries. Developers in Turkey, Latin America, South Asia and Africa generate value they cannot collect.

Stellar's per-operation fee is around 0.00001 XLM, which makes a $1 payout threshold economically sane. That is the whole reason this product can exist for developers outside a handful of countries.

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
PROJECT.md              living design document — 23 ADRs, measurements, open questions
packages/protocol/      shared types, money, sanitizer, schemas   (82 tests)
packages/cli/           daemon, unix socket, shim, disk queue     (44 tests)
spikes/                 throwaway probes — deleted once folded into the doc
```

`PROJECT.md` is the source of truth. Every architectural decision records the alternatives it rejected and why, and §15 keeps an honest list of unsolved weaknesses.

## Development

```bash
pnpm install
pnpm test        # 126 tests
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
- [x] Daemon — turn state machine, unix socket, shim, disk queue
- [ ] Backend — ad serving, impression ingest, ledger
- [ ] Wallet linking — SEP-10 via Freighter / LOBSTR
- [ ] Payouts — Stellar testnet

Mainnet, click attribution, an advertiser dashboard, and adapters beyond Claude Code are explicitly out of scope for now.
