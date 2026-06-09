// x402-watch monitor
// A read-only control plane that observes an agent's x402 spend, enforces
// policy caps, and exposes a kill-switch. It never touches the payment path —
// the agent reports its lifecycle and asks the monitor for clearance.
//
// Design lineage: Conductor (read-only monitor for Claude Code sessions),
// pointed at money instead of code.

import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.MONITOR_PORT || 4040;

// ---------- in-memory session state (resets on restart) ----------
const state = {
  startedAt: Date.now(),
  halted: false,
  policy: {
    perCallCapUsd: Number(process.env.PER_CALL_CAP_USD ?? 0.5),
    dailyCapUsd: Number(process.env.DAILY_CAP_USD ?? 5),
    allowlist: (process.env.MERCHANT_ALLOWLIST ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean), // empty = allow all
  },
  events: [],
  spentUsd: 0,
  byMerchant: {}, // host -> { spentUsd, calls }
};

const sseClients = new Set();

function broadcast(payload) {
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) res.write(line);
}

function snapshot() {
  return {
    type: "snapshot",
    halted: state.halted,
    policy: state.policy,
    spentUsd: round(state.spentUsd),
    calls: state.events.filter((e) => e.phase === "settled").length,
    byMerchant: state.byMerchant,
    uptimeMs: Date.now() - state.startedAt,
    recent: state.events.slice(-60),
  };
}

const round = (n) => Math.round(n * 1e6) / 1e6;

// Decide whether a proposed payment is cleared. This is the trust layer.
function evaluate({ priceUsd, merchant }) {
  if (state.halted) return { cleared: false, reason: "halted" };
  const price = Number(priceUsd) || 0;
  if (state.policy.perCallCapUsd && price > state.policy.perCallCapUsd)
    return { cleared: false, reason: "per_call_cap" };
  if (
    state.policy.dailyCapUsd &&
    state.spentUsd + price > state.policy.dailyCapUsd
  )
    return { cleared: false, reason: "daily_cap" };
  if (
    state.policy.allowlist.length &&
    !state.policy.allowlist.includes(merchant)
  )
    return { cleared: false, reason: "not_allowlisted" };
  return { cleared: true, reason: "ok" };
}

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, "public")));

// Agents ask: am I allowed to make this payment right now?
app.post("/api/clear", (req, res) => {
  const verdict = evaluate(req.body || {});
  res.json(verdict);
});

// Agents report each lifecycle phase: challenge | signed | settled | blocked | error
app.post("/api/event", (req, res) => {
  const e = {
    ts: Date.now(),
    taskId: req.body.taskId ?? "-",
    merchant: req.body.merchant ?? "unknown",
    resource: req.body.resource ?? "",
    priceUsd: Number(req.body.priceUsd) || 0,
    network: req.body.network ?? "",
    phase: req.body.phase ?? "info",
    txSig: req.body.txSig ?? null,
    latencyMs: req.body.latencyMs ?? null,
    note: req.body.note ?? "",
    flagged: false,
  };

  if (e.phase === "settled") {
    state.spentUsd = round(state.spentUsd + e.priceUsd);
    const m = (state.byMerchant[e.merchant] ??= { spentUsd: 0, calls: 0 });
    m.spentUsd = round(m.spentUsd + e.priceUsd);
    m.calls += 1;
    // anomaly: settled above the running daily cap or above per-call cap
    if (
      (state.policy.perCallCapUsd && e.priceUsd > state.policy.perCallCapUsd) ||
      (state.policy.dailyCapUsd && state.spentUsd > state.policy.dailyCapUsd)
    )
      e.flagged = true;
  }
  if (e.phase === "blocked") e.flagged = true;

  state.events.push(e);
  if (state.events.length > 1000) state.events.shift();

  broadcast({ type: "event", event: e, spentUsd: round(state.spentUsd) });
  res.json({ ok: true });
});

// Kill-switch
app.post("/api/halt", (req, res) => {
  state.halted = Boolean(req.body?.halted ?? true);
  broadcast({ type: "halt", halted: state.halted });
  res.json({ halted: state.halted });
});

app.post("/api/policy", (req, res) => {
  const { perCallCapUsd, dailyCapUsd, allowlist } = req.body || {};
  if (perCallCapUsd != null) state.policy.perCallCapUsd = Number(perCallCapUsd);
  if (dailyCapUsd != null) state.policy.dailyCapUsd = Number(dailyCapUsd);
  if (Array.isArray(allowlist)) state.policy.allowlist = allowlist;
  broadcast({ type: "policy", policy: state.policy });
  res.json(state.policy);
});

app.post("/api/reset", (_req, res) => {
  state.events = [];
  state.spentUsd = 0;
  state.byMerchant = {};
  state.halted = false;
  state.startedAt = Date.now();
  broadcast(snapshot());
  res.json({ ok: true });
});

app.get("/api/snapshot", (_req, res) => res.json(snapshot()));

// Live feed
app.get("/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});

app.listen(PORT, () => {
  console.log(`x402-watch monitor on http://localhost:${PORT}`);
  console.log(
    `policy: per-call $${state.policy.perCallCapUsd}, daily $${state.policy.dailyCapUsd}, allowlist=${state.policy.allowlist.join(",") || "*"}`
  );
});
