# x402-watch — one-pager

**The oversight layer for autonomous agents paying over x402. See every payment. Bound it. Stop it. Without ever holding a key.**

Live demo: **x402.musicailab.com** · Code (MIT): **github.com/yksanjo/x402-watch** · zero-dep Node

---

## The gap: the rail is solved, the oversight isn't

x402 lets an agent settle value on its own — pay per call for data, inference, RPC, signals. Coinbase, the x402 Foundation, and the Solana facilitators have made the rail work. The piece still missing is the thing a human keeps **next to** the agent: a live view of what it's spending, a policy it can't exceed, and a switch that stops it.

Across the agentic-commerce stack, **identity, trust, and spend-control** is where the runaway-spend and fraud risk concentrates — and it's the gap between an x402 **demo** and an x402 **deployment**.

## What it does

- **See it** — a live tape of every `402 → clear → sign → settle`, with running spend, per-merchant breakdown, latency, and the settlement signature linked to the explorer.
- **Bound it** — per-call and daily USD caps plus a merchant allowlist, evaluated and enforced *before* the agent signs.
- **Stop it** — one kill-switch that denies all clearance instantly.

## How it fits — out of the payment path

```
agent (x402 client)                    monitor (x402-watch)
1. GET resource ───────────▶ 402
2. clear this pay? ────────────────────▶ caps · allowlist · halt
                          ◀──────────── { cleared: true | false }
3. if cleared → sign + settle (Solana, USDC)
4. report each phase ──────────────────▶ live tape + spend + flags
   over-cap / halted → BLOCKED before any signature
```

The monitor is **read-only** and never holds keys or signs. If it's down, payments still settle — you just lose oversight. Adding x402-watch **never makes the rail less reliable**. That's the honest failure mode for an observability layer.

## Why it matters for x402

Spend-control is the adoption unlock. An agent with a funded wallet and an x402 client can spend with no human in the loop — that's the point, and the exposure. x402-watch makes that **supervisable without slowing the agent**, so teams can let agents transact at higher value and volume. Safety isn't a tax on the rail; it's what takes x402 from demo to production.

## Built on Solana

Real mode settles **USDC on Solana** through a facilitator via `@x402/fetch`, `@x402/svm`, `@x402/express` (v2.14.x) — sub-cent fees, ~400ms finality. The demo runs simulated settlement so it's always live; the trust layer (clearance, caps, flags, halt) is fully real.

## The ask — to the x402 team

- Feedback on the spend-control model and the SDK surface we wired against.
- Make x402-watch a **reference oversight integration** for x402 on Solana.
- Ecosystem listing so agent builders find the off-switch.
- A reference-integration grant or design partnership.

---

*Built by Yoshi Kondo — Head of Global BD, Soundraw · 15+ yrs complex multi-party deals · Solana payments. A BD leader who ships. · yksanjo@gmail.com*

*read-only · never signs · lineage: Conductor*
