// x402-watch · devnet proof
// Runs the three decisive moments END-TO-END on real Solana devnet:
//   1. an under-cap payment that settles REAL USDC through the guard
//   2. an over-cap payment the guard blocks BEFORE the signer is touched
//   3. the kill-switch denying everything
// and writes share/PROOF.md with the explorer links.
//
// Needs: .devnet/wallet.json funded with devnet SOL (fees) + devnet USDC
// (the payment asset, mint 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU).
// Run:  node scripts/devnet-proof.mjs
//
// It self-hosts everything: spawns the monitor (port 14710) and the bundled
// x402-gated merchant (14711), so the only external dependency is the
// facilitator + devnet itself.

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { watch, PaymentBlockedError } from "../src/watch.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const MON_PORT = 14710;
const MERCH_PORT = 14711;
const MONITOR = `http://localhost:${MON_PORT}`;
const FACILITATOR = process.env.FACILITATOR_URL || "https://facilitator.payai.network";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const explorer = (sig) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

const secret = JSON.parse(readFileSync(join(ROOT, ".devnet", "wallet.json"), "utf8"));
const merchantSecret = JSON.parse(readFileSync(join(ROOT, ".devnet", "merchant.json"), "utf8"));

// ---- preflight: balances ---------------------------------------------------
const web3 = await import("@solana/web3.js");
const conn = new web3.Connection("https://api.devnet.solana.com", "confirmed");
const payer = web3.Keypair.fromSecretKey(Uint8Array.from(secret));
const merchant = web3.Keypair.fromSecretKey(Uint8Array.from(merchantSecret));
const USDC = new web3.PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

const sol = (await conn.getBalance(payer.publicKey)) / 1e9;
let usdc = 0;
try {
  const accts = await conn.getParsedTokenAccountsByOwner(payer.publicKey, { mint: USDC });
  usdc = accts.value.reduce((a, x) => a + (x.account.data.parsed.info.tokenAmount.uiAmount || 0), 0);
} catch {}
console.log(`agent wallet ${payer.publicKey.toBase58()}: ${sol} SOL, ${usdc} USDC (devnet)`);
if (sol === 0) console.log("note: 0 SOL is probably fine — the PayAI facilitator is the feePayer on devnet");
if (usdc < 0.2) {
  console.error(`
INSUFFICIENT FUNDS — the proof needs ~0.2 devnet USDC (the facilitator pays Solana fees).
  USDC: https://faucet.circle.com  (Solana Devnet) -> ${payer.publicKey.toBase58()}
  (optional SOL: https://faucet.solana.com)
Then re-run: node scripts/devnet-proof.mjs`);
  process.exit(2);
}

// ---- spawn monitor + merchant ----------------------------------------------
const dataDir = mkdtempSync(join(tmpdir(), "x402-proof-"));
const monitor = spawn(process.execPath, [join(ROOT, "src", "monitor.js")], {
  env: { ...process.env, MONITOR_PORT: String(MON_PORT), DATA_DIR: dataDir,
         PER_CALL_CAP_USD: "0.1", DAILY_CAP_USD: "0.5", MERCHANT_ALLOWLIST: "" },
  stdio: "inherit",
});
const merchantProc = spawn(process.execPath, [join(ROOT, "src", "resource-server.js")], {
  env: { ...process.env, MERCHANT_PORT: String(MERCH_PORT),
         PAY_TO: merchant.publicKey.toBase58(), FACILITATOR_URL: FACILITATOR,
         X402_NETWORK: "solana-devnet" },
  stdio: "inherit",
});
process.on("exit", () => { monitor.kill(); merchantProc.kill(); });

for (let i = 0; i < 50; i++) { try { if ((await fetch(`${MONITOR}/api/snapshot`)).ok) break; } catch {} await sleep(150); }
for (let i = 0; i < 50; i++) { try { await fetch(`http://localhost:${MERCH_PORT}/regime/latest`); break; } catch {} await sleep(150); }
console.log("monitor + merchant up");

// ---- the guarded client (verified v2.14 recipe) ------------------------------
const { wrapFetchWithPayment, x402Client } = await import("@x402/fetch");
const { registerExactSvmScheme } = await import("@x402/svm/exact/client");
const { createKeyPairSignerFromBytes } = await import("@solana/kit");
const signer = await createKeyPairSignerFromBytes(Uint8Array.from(secret));
const client = new x402Client();
registerExactSvmScheme(client, { signer });
let signerTouches = 0;
const paidFetch = (url, init) => { signerTouches++; return wrapFetchWithPayment(fetch, client)(url, init); };
const guarded = watch({ payingFetch: paidFetch, monitor: MONITOR });

const results = {};
const url = `http://localhost:${MERCH_PORT}/regime/latest`; // $0.05, under the $0.10 cap

// ---- 1. under-cap: settles REAL USDC ----------------------------------------
console.log("\n[1/3] under-cap purchase ($0.05, cap $0.10) — should settle on devnet…");
const t0 = Date.now();
const res = await guarded(url);
const body = await res.json();
const payResp = res.headers.get("x-payment-response");
const txSig = payResp ? JSON.parse(Buffer.from(payResp, "base64").toString()).transaction : null;
results.settled = { status: res.status, txSig, latencyMs: Date.now() - t0, body };
console.log(`    settled in ${results.settled.latencyMs}ms -> ${txSig ? explorer(txSig) : "(no sig in response)"}`);

// ---- 2. over-cap: blocked before the signer ----------------------------------
console.log("[2/3] over-cap attempt — guard must block BEFORE the signer…");
await fetch(`${MONITOR}/api/policy`, { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ perCallCapUsd: 0.01 }) }); // drop cap under the $0.05 price
const touchesBefore = signerTouches;
try {
  await guarded(url);
  results.capBlock = { blocked: false };
} catch (e) {
  results.capBlock = { blocked: e instanceof PaymentBlockedError, reason: e.reason,
                       signerTouched: signerTouches !== touchesBefore };
}
console.log(`    blocked=${results.capBlock.blocked} reason=${results.capBlock.reason} signerTouched=${results.capBlock.signerTouched}`);

// ---- 3. kill-switch ----------------------------------------------------------
console.log("[3/3] kill-switch — everything denied…");
await fetch(`${MONITOR}/api/policy`, { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ perCallCapUsd: 0.1 }) }); // restore cap so only halt blocks
await fetch(`${MONITOR}/api/halt`, { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ halted: true }) });
try {
  await guarded(url);
  results.halt = { blocked: false };
} catch (e) {
  results.halt = { blocked: e instanceof PaymentBlockedError, reason: e.reason };
}
console.log(`    blocked=${results.halt.blocked} reason=${results.halt.reason}`);

// ---- write the proof ----------------------------------------------------------
const ok = results.settled.txSig && results.capBlock.blocked && !results.capBlock.signerTouched && results.halt.blocked;
const proof = `# Devnet proof — real x402 settlement through the guard

Run: ${new Date().toISOString()} · facilitator: ${FACILITATOR} · network: solana-devnet
Agent wallet: \`${payer.publicKey.toBase58()}\` · merchant payTo: \`${merchant.publicKey.toBase58()}\`

| # | moment | result |
|---|--------|--------|
| 1 | under-cap $0.05 purchase | **settled real USDC in ${results.settled.latencyMs}ms** — [${results.settled.txSig?.slice(0, 8)}…${results.settled.txSig?.slice(-8)}](${explorer(results.settled.txSig)}) |
| 2 | over-cap attempt | **blocked (\`${results.capBlock.reason}\`), signer never invoked: ${!results.capBlock.signerTouched}** |
| 3 | kill-switch engaged | **blocked (\`${results.halt.reason}\`)** |

The settled transaction is a real on-chain transfer you can open on Solana Explorer.
The blocked attempts produced **no transaction at all** — the wrapper never let them
reach the signer. That asymmetry is the product.

Verdict: ${ok ? "✅ ALL THREE MOMENTS PROVEN ON DEVNET" : "⚠ INCOMPLETE — see results above"}
`;
writeFileSync(join(ROOT, "share", "PROOF.md"), proof);
console.log(`\n${ok ? "✅ PROOF COMPLETE" : "⚠ incomplete"} -> share/PROOF.md`);
process.exit(ok ? 0 : 1);
