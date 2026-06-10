# x402-watch · June 11 — 3-minute run-of-show

**One line to memorize:** *"The rail is solved. The oversight isn't. I built the oversight."*

## Before you go on (2 min, do this at home / on venue WiFi)

- [ ] Open **https://x402.musicailab.com** in a tab — confirm the green `live` dot and rows flowing.
- [ ] Open the **GitHub repo** in a second tab: github.com/yksanjo/x402-watch
- [ ] **Backup A (venue WiFi dies):** on your laptop run `cd ~/x402-watch && npm run monitor` then `npm run agent` in a second terminal → same dashboard at `localhost:4040`.
- [ ] **Backup B (everything dies):** `share/dashboard-live.png` + `share/dashboard-halted.png` are full-res screenshots. The story works on stills.

## The 3 minutes

**0:00 — the setup (no slides, just talk)**
> "x402 lets an AI agent pay per call — for data, inference, RPC. The rail works; Coinbase and the Solana facilitators solved that. Here's the problem nobody solves: you gave the agent a funded wallet. Who's watching it spend?"

**0:30 — open the live URL**
Point at the tape flowing: *"This is an autonomous agent buying from six merchants right now. Every payment: challenge, cleared, signed, settled. Running spend against a daily cap. Per-merchant breakdown."*

Wait for a `premium.alpha-leak.xyz` row — it shows up every ~15s:
> "Watch this one — $0.75 against a 50-cent per-call cap. **BLOCKED.** It never reached the signer. The agent couldn't spend that money even if it wanted to."

**1:30 — the live move (the part they remember)**
In the **Policy** panel, change daily cap from `5` to `1`, hit *apply policy*:
> "Policy is live — I just cut its daily budget and the monitor enforces it before any signature."

Then hit the **kill switch**:
> "And this is the button every agent deployment is missing. HALTED. All clearance denied. The human's hand stays on the off switch."

(Re-arm it after the beat. If the demo just auto-reset and spend looks low — fine, say "it resets every 10 minutes so the demo never freezes; that's a demo loop, the controls are real.")

**2:15 — the credibility beat**
> "This isn't a mock of the controls — the enforcement wrapper is open-source, it's 3 lines to adopt with the real x402 SDK, fail-closed if the monitor dies, and there are nine no-mock tests proving a denied payment can never reach the signer. Never holds keys. Out of the payment path — if my layer goes down, your payments don't."

**2:40 — the ask**
> "I want two things: your feedback on the spend-control model, and to make this the reference oversight integration for x402 on Solana. The repo's public, the demo's live — x402.musicailab.com."

## Likely questions → answers

- **"Is the settlement real?"** → "On the public demo it's simulated so it runs 24/7 with no wallet. The trust layer — clearance, caps, kill-switch — is fully real and tested. The repo wires real devnet USDC settlement through the PayAI facilitator." *(If the devnet proof ran: "and here's a real explorer transaction that settled through the guard, next to a blocked one that produced no transaction at all" → share/PROOF.md)*
- **"What if the agent just bypasses the monitor?"** → "Same answer as any client-side control: you adopt the wrapper, the signer lives behind it. For hostile agents the next layer is holding clearance at the signer or facilitator — that's exactly the conversation I want to have with you."
- **"Isn't this just a wallet limit?"** → "Limits are static and live with the key. This is live policy — caps, allowlist, kill-switch — plus a full audit tape, adjustable mid-flight without touching the wallet."
- **"Who pays for this?"** → "Open question, honestly. Hosted oversight, enterprise control plane, or it stays open ecosystem infrastructure. Part of why I'm talking to you."
- **"Why you?"** → "Fifteen years doing complex multi-party deals — Soundraw, Atlantic, WMG — and I ship. This went from zero to live-deployed, tested, and public in days."

## Assets
| Thing | Where |
|---|---|
| Live demo | https://x402.musicailab.com |
| Repo | https://github.com/yksanjo/x402-watch |
| One-pager (hand them this) | `share/PITCH.pdf` |
| Meme / social | `share/launch-meme.png` + `share/LAUNCH.md` |
| Devnet proof (if run) | `share/PROOF.md` |
