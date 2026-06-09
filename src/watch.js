// x402-watch · watch() — the enforcement wrapper.
//
// This is the piece that makes oversight REAL instead of advisory. The demo
// agent voluntarily asks the monitor for clearance; a real (or buggy, or
// hijacked) agent simply wouldn't. watch() closes that hole: you hand it your
// plain fetch and your paying fetch (e.g. from @x402/fetch), and it returns a
// fetch where payment physically cannot happen without clearance —
// the paying fetch is never invoked for a denied or unknown payment.
//
//   import { watch } from "./src/watch.js";
//   const paidFetch = wrapFetchWithPayment(fetch, signer);   // @x402/fetch
//   const guarded   = watch({ payingFetch: paidFetch });
//   const res = await guarded("https://api.example.com/data");
//
// Flow per request:
//   1. probe with PLAIN fetch (never pays)
//   2. not 402 → return as-is (free resource)
//   3. 402 → parse the x402 payment requirements (price, payTo, network)
//   4. ask the monitor: POST /api/clear { priceUsd, merchant }
//      denied (or monitor unreachable, unless failOpen) → PaymentBlockedError,
//      the paying fetch is NEVER called
//   5. cleared → re-issue via the paying fetch, report settled + txSig
//
// Fail-closed by default: if the monitor is unreachable, payments are DENIED.
// That is the correct default for a control layer. Set failOpen: true to get
// observability-only semantics (payments proceed unwatched when monitor is down).

export class PaymentBlockedError extends Error {
  constructor(reason, details = {}) {
    super(`x402-watch blocked payment: ${reason}`);
    this.name = "PaymentBlockedError";
    this.reason = reason;
    this.details = details;
  }
}

// Parse an x402 402 response into { priceUsd, payTo, network, raw }.
// Tolerant across SDK versions: tries the v2 JSON body `accepts` array
// (maxAmountRequired in atomic units of the asset) and falls back to a
// human `price` field like "$0.05". Returns null if unparseable.
export function parse402(body) {
  try {
    const accepts = body?.accepts?.[0] ?? body?.paymentRequirements?.[0];
    if (!accepts) return null;
    let priceUsd = null;
    if (accepts.maxAmountRequired != null) {
      const decimals = Number(accepts.extra?.decimals ?? 6); // USDC default
      priceUsd = Number(accepts.maxAmountRequired) / 10 ** decimals;
    } else if (typeof accepts.price === "string") {
      priceUsd = Number(accepts.price.replace(/[^0-9.]/g, ""));
    } else if (typeof accepts.price === "number") {
      priceUsd = accepts.price;
    }
    if (priceUsd == null || Number.isNaN(priceUsd)) return null;
    return {
      priceUsd,
      payTo: accepts.payTo ?? null,
      network: accepts.network ?? "",
      raw: accepts,
    };
  } catch {
    return null;
  }
}

export function watch({
  payingFetch,
  plainFetch = globalThis.fetch,
  monitor = process.env.MONITOR_URL || "http://localhost:4040",
  failOpen = false,
  network = process.env.X402_NETWORK || "solana",
  timeoutMs = 3000,
} = {}) {
  if (typeof payingFetch !== "function")
    throw new Error("watch() needs payingFetch (e.g. wrapFetchWithPayment(fetch, signer))");

  let taskSeq = 0;

  async function post(path, body) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await plainFetch(`${monitor}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      return await r.json();
    } finally {
      clearTimeout(t);
    }
  }

  function report(phase, task, extra = {}) {
    // fire-and-forget: reporting must never block or fail the agent
    post("/api/event", {
      phase,
      taskId: task.id,
      merchant: task.merchant,
      resource: task.resource,
      priceUsd: task.priceUsd,
      network: task.network || network,
      ...extra,
    }).catch(() => {});
  }

  return async function guardedFetch(url, init = {}) {
    // 1. probe without any payment capability
    const probe = await plainFetch(url, init);
    if (probe.status !== 402) return probe;

    // 2. parse what the merchant wants
    let body = null;
    try { body = await probe.clone().json(); } catch {}
    const want = parse402(body);
    const u = new URL(typeof url === "string" ? url : url.url);
    const task = {
      id: `w${++taskSeq}`,
      merchant: u.host,
      resource: `${(init.method || "GET").toUpperCase()} ${u.pathname}`,
      priceUsd: want?.priceUsd,
      network: want?.network || network,
    };

    if (!want) {
      // can't price it → never pay blind
      report("blocked", task, { note: "unparseable 402 payment requirements" });
      throw new PaymentBlockedError("unparseable_402", { url: u.href });
    }

    report("challenge", task, { note: "402 payment required" });

    // 3. clearance — the gate the paying fetch sits behind
    let verdict;
    try {
      verdict = await post("/api/clear", { priceUsd: task.priceUsd, merchant: task.merchant });
    } catch {
      if (failOpen) {
        report("signed", task, { note: "monitor unreachable — failOpen, paying unwatched" });
        return payingFetch(url, init);
      }
      throw new PaymentBlockedError("monitor_unreachable", { url: u.href, failOpen });
    }
    if (!verdict.cleared) {
      report("blocked", task, { note: `clearance denied: ${verdict.reason}` });
      throw new PaymentBlockedError(verdict.reason, { url: u.href, priceUsd: task.priceUsd });
    }

    // 4. cleared → actually pay
    report("signed", task, { note: "cleared, signing payment" });
    const t0 = Date.now();
    try {
      const res = await payingFetch(url, init);
      let txSig = null;
      try {
        const payResp = res.headers.get("x-payment-response");
        if (payResp) txSig = JSON.parse(Buffer.from(payResp, "base64").toString()).transaction ?? null;
      } catch {}
      report("settled", task, { txSig, latencyMs: Date.now() - t0, note: `${res.status} resource delivered` });
      return res;
    } catch (err) {
      report("error", task, { note: String(err?.message || err).slice(0, 120) });
      throw err;
    }
  };
}
