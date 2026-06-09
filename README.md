# x402-watch

**A read-only spend monitor and kill-switch for autonomous agents paying over [x402](https://x402.org).**

> **Live demo:** [x402.musicailab.com](https://x402.musicailab.com) — watch an autonomous agent buy data/inference/RPC across merchants, spend climb against a cap, an over-cap purchase get auto-blocked, and the kill-switch halt clearance mid-stream. Settlement is simulated so it runs 24/7 anywhere; the trust layer (clearance, caps, flags, halt) is fully real.

When an agent can settle value on its own — paying per call for data, inference, RPC, or signals over x402 — the missing piece isn't the rail. Coinbase, the x402 Foundation, and the Solana facilitators have the rail. The missing piece is the thing a human keeps *next to* the agent: a live view of what it's spending, a policy it can't exceed, and a switch that stops it. x402-watch is that layer.

It never holds keys and never signs. It sits beside the agent, observes every payment's lifecycle, clears or denies each one against a spend policy, and gives a person a single button to halt all settlement. Read-only by design — the same discipline as [Conductor](https://github.com/yksanjo/conductor), pointed at money instead of code.

---

## Why this layer

Across the agentic-commerce stack, the payment rail is being commoditized fast, but agent **identity, trust, and spend control** is the layer drawing the most scrutiny and the most funding — it's where the fraud and runaway-spend risk concentrates. An agent with a funded wallet and an x402 client can spend without a human in the loop. That's the point, and that's the exposure. x402-watch closes the loop without slowing the agent down:

- **See it** — a live tape of every `402 → clear → sign → settle`, with running spend, per-merchant breakdown, latency, and the settlement signature linked to the explorer.
- **Bound it** — per-call and daily USD caps plus a merchant allowlist, enforced *before* the agent signs.
- **Stop it** — one kill-switch that denies all clearance instantly.

## Architecture

```
   agent (x402 client)                 monitor (this repo)
   ─────────────────────               ───────────────────
   1. GET resource  ───────▶ 402       
   2. ask: clear this pay? ───────────▶ POST /api/clear   ── caps + allowlist + halt
                          ◀───────────  { cleared: true|false, reason }
   3. sign + settle (Solana)           
   4. report each phase   ───────────▶ POST /api/event    ── live tape + spend + flags
                                        ▲
                                  human watches the dashboard, flips the kill-switch
```

The monitor is out of the payment path entirely — it observes and clears, it never signs.

## Use it with your real agent (3 lines)

The piece that makes oversight *enforced* rather than advisory is `watch()` — a wrapper for your paying fetch where **a denied payment can never reach the signer**:

```js
import { watch, PaymentBlockedError } from "x402-watch";
import { wrapFetchWithPayment } from "@x402/fetch";

const paidFetch = wrapFetchWithPayment(fetch, signer); // your existing setup
const guarded   = watch({ payingFetch: paidFetch });   // + supervision
// use `guarded` wherever you used `paidFetch` — that's it
```

`watch()` probes each request with a plain (non-paying) fetch first. On a `402` it parses the payment requirements, asks the monitor for clearance against your caps/allowlist/kill-switch, and only then invokes the paying fetch. Denials throw `PaymentBlockedError` — the signer is never called. See `examples/guarded-agent.js`.

**Fail-closed by default**: if the monitor is unreachable, payments are denied. That's the correct default for a control layer. Pass `failOpen: true` for observability-only semantics (payments proceed unwatched when the monitor is down).

These guarantees are proven by no-mock tests (`npm test`): a real monitor process and a real x402-style merchant over real HTTP — blocked payments never pay, controls survive a monitor restart, unparseable 402s are never paid blind.

## Durable controls & alerts

- The kill-switch and policy persist to `data/state.json`, and every event appends to `data/events.jsonl`. A restart can't silently re-arm a halted fleet or forget today's spend.
- The daily cap is a real **UTC-day window** — counters roll over at midnight UTC.
- Set `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` to get pinged on every blocked payment, flagged settlement, and halt toggle.

## Quickstart (demo, no wallet needed)

```bash
npm install
npm run monitor          # http://localhost:4040
npm run agent            # in a second terminal — autonomous buyer, sim settlement
```

Open the dashboard. You'll watch an agent buy data/inference/RPC across several merchants, see spend climb against the daily cap, and watch the over-cap purchase get auto-blocked and flagged. Hit **kill switch** and clearance stops mid-stream.

Settlement here is simulated (realistic devnet-style signatures) so it runs anywhere. The trust layer — clearance, caps, flags, halt — is fully real.

## Real settlement on Solana devnet

x402 is live on Solana with sub-cent fees and ~400ms finality, settling USDC through a facilitator. To flip from sim to real:

```bash
# 1. fund a devnet wallet with devnet SOL + USDC
# 2. fill in .env (copy from .env.example): SOLANA_SECRET_KEY, PAY_TO
npm run merchant         # optional bundled x402-gated resource
X402_MODE=solana npm run agent
```

Real mode uses `@x402/fetch`, `@x402/svm`, and `@x402/express` (v2.14.x). The SDK surface moves quickly — confirm the signer/scheme calls against the installed package READMEs before going to mainnet.

## Configuration

All via `.env` (see `.env.example`): caps, allowlist, interval, network, facilitator, keys.

## What this is not

Not a wallet, not a facilitator, not a payment rail. It's the oversight layer that makes letting an agent spend money something a human can actually supervise.

---

Built for the open agentic web. Read-only observer · lineage: Conductor.
