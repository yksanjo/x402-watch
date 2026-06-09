// x402-watch agent
// An autonomous buyer that pays for resources over x402. Before every payment
// it asks the monitor for clearance (cap + allowlist + kill-switch), and it
// reports each lifecycle phase so a human can watch — and stop — its spend.
//
// MODE=sim    (default) settlement is simulated with realistic devnet-style
//             signatures. Runs anywhere, no wallet or RPC needed. This is the
//             demo path.
// MODE=solana real x402 settlement on Solana devnet. Requires the optional
//             deps (npm i) plus a funded devnet wallet + RPC. See README.

const MONITOR = process.env.MONITOR_URL || "http://localhost:4040";
const MODE = process.env.X402_MODE || "sim";
const NETWORK = process.env.X402_NETWORK || "solana-devnet";
const INTERVAL = Number(process.env.AGENT_INTERVAL_MS || 1400);

// A basket of resources an agentic-finance bot might pay for, per call.
const BASKET = [
  { merchant: "feeds.pyth.network",   resource: "GET /price/SOL-USD",        priceUsd: 0.002 },
  { merchant: "rpc.helius.xyz",       resource: "POST /getProgramAccounts",  priceUsd: 0.004 },
  { merchant: "search.exa.ai",        resource: "GET /search?q=perps+funding", priceUsd: 0.01 },
  { merchant: "inference.together.ai",resource: "POST /v1/chat/completions", priceUsd: 0.03 },
  { merchant: "data.tensor.trade",    resource: "GET /collection/floor",     priceUsd: 0.008 },
  { merchant: "api.perps-signal.io",  resource: "GET /regime/latest",        priceUsd: 0.05 },
  // occasional outlier that should trip the per-call cap:
  { merchant: "premium.alpha-leak.xyz", resource: "GET /whale/positions",    priceUsd: 0.75 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const fakeSig = () => Array.from({ length: 88 }, () => b58[(Math.random() * b58.length) | 0]).join("");

async function report(phase, task, extra = {}) {
  const body = {
    phase,
    taskId: task.id,
    merchant: task.merchant,
    resource: task.resource,
    priceUsd: task.priceUsd,
    network: NETWORK,
    ...extra,
  };
  try {
    await fetch(`${MONITOR}/api/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    console.error("monitor unreachable — start it with `npm run monitor`");
  }
}

async function clear(task) {
  try {
    const r = await fetch(`${MONITOR}/api/clear`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ priceUsd: task.priceUsd, merchant: task.merchant }),
    });
    return await r.json();
  } catch {
    return { cleared: false, reason: "monitor_unreachable" };
  }
}

// --- real settlement (Solana devnet via x402) -----------------------------
// Wired against @x402/fetch + @x402/svm (v2.14.x). Because the x402 SDK surface
// moves quickly, confirm the signer/wrap calls against the installed package
// README before relying on this in production.
let wrapped = null;
async function getRealFetch() {
  if (wrapped) return wrapped;
  const { wrapFetchWithPayment } = await import("@x402/fetch");
  const { createSvmSigner } = await import("@x402/svm");
  const { Keypair } = await import("@solana/web3.js");
  const secret = JSON.parse(process.env.SOLANA_SECRET_KEY || "[]");
  if (!secret.length) throw new Error("set SOLANA_SECRET_KEY (devnet keypair JSON array)");
  const signer = createSvmSigner(Keypair.fromSecretKey(Uint8Array.from(secret)));
  wrapped = wrapFetchWithPayment(fetch, signer);
  return wrapped;
}

async function settleReal(task) {
  const f = await getRealFetch();
  const url = process.env.RESOURCE_URL || `http://localhost:4021${task.resource.split(" ")[1] || "/"}`;
  const t0 = Date.now();
  const res = await f(url, { method: task.resource.split(" ")[0] || "GET" });
  const payResp = res.headers.get("x-payment-response");
  let txSig = null;
  try { txSig = payResp ? JSON.parse(Buffer.from(payResp, "base64").toString()).transaction : null; } catch {}
  return { txSig, latencyMs: Date.now() - t0 };
}

async function settleSim() {
  await sleep(300 + Math.random() * 500); // ~Solana finality + facilitator
  return { txSig: fakeSig(), latencyMs: 380 + Math.floor(Math.random() * 520) };
}

async function runTask(task) {
  await report("challenge", task, { note: "402 payment required" });
  await sleep(120);

  const verdict = await clear(task);
  if (!verdict.cleared) {
    await report("blocked", task, { note: `clearance denied: ${verdict.reason}` });
    return verdict.reason;
  }

  await report("signed", task, { note: "payment authorized, signing" });
  try {
    const { txSig, latencyMs } = MODE === "solana" ? await settleReal(task) : await settleSim();
    await report("settled", task, { txSig, latencyMs, note: "200 OK, resource delivered" });
  } catch (err) {
    await report("error", task, { note: String(err.message || err).slice(0, 120) });
  }
  return "ok";
}

async function main() {
  console.log(`x402-watch agent · mode=${MODE} · network=${NETWORK} · monitor=${MONITOR}`);
  let i = 0;
  while (true) {
    // weight the basket so the outlier shows up occasionally
    const pick = Math.random() < 0.12
      ? BASKET[BASKET.length - 1]
      : BASKET[(Math.random() * (BASKET.length - 1)) | 0];
    const task = { id: `t${++i}`, ...pick };
    const r = await runTask(task);
    if (r === "halted") console.log("clearance denied (halted) — kill switch is engaged");
    await sleep(INTERVAL);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
