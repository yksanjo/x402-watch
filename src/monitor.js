// x402-watch monitor
// A read-only control plane that observes an agent's x402 spend, enforces
// policy caps, and exposes a kill-switch. It never touches the payment path —
// the agent reports its lifecycle and asks the monitor for clearance.
// Controls (halt + policy) and the event tape persist to data/ so a restart
// can't re-arm a halted fleet or forget today's spend.
//
// Design lineage: Conductor (read-only monitor for Claude Code sessions),
// pointed at money instead of code.

import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, existsSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.MONITOR_PORT || 4040;
const DATA_DIR = process.env.DATA_DIR || join(__dirname, "..", "data");
const EVENTS_FILE = join(DATA_DIR, "events.jsonl");
const STATE_FILE = join(DATA_DIR, "state.json");
const utcDay = (ts = Date.now()) => new Date(ts).toISOString().slice(0, 10);

const state = {
  startedAt: Date.now(),
  halted: false,
  day: utcDay(), // current UTC day — the window the daily cap applies to
  policy: {
    perCallCapUsd: Number(process.env.PER_CALL_CAP_USD ?? 0.5),
    dailyCapUsd: Number(process.env.DAILY_CAP_USD ?? 5),
    allowlist: (process.env.MERCHANT_ALLOWLIST ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean), // empty = allow all
  },
  events: [],
  spentUsd: 0, // spend within the current UTC day
  byMerchant: {}, // host -> { spentUsd, calls } within the current UTC day
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

// ---------- durable state ----------
// halted flag + policy persist to state.json; every event appends to
// events.jsonl. On boot, restore the controls and replay today's events so
// the daily spend window survives a crash or redeploy — a kill-switch that
// forgets it was flipped on restart is not a kill-switch.
mkdirSync(DATA_DIR, { recursive: true });
function persistControl() {
  try {
    writeFileSync(STATE_FILE, JSON.stringify({ halted: state.halted, policy: state.policy }));
  } catch (e) {
    console.error("state persist failed:", e.message);
  }
}
try {
  if (existsSync(STATE_FILE)) {
    const saved = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    if (typeof saved.halted === "boolean") state.halted = saved.halted;
    if (saved.policy) state.policy = { ...state.policy, ...saved.policy };
  }
  if (existsSync(EVENTS_FILE)) {
    const lines = readFileSync(EVENTS_FILE, "utf8").split("\n").filter(Boolean);
    for (const line of lines.slice(-5000)) {
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (utcDay(e.ts) !== state.day) continue; // only today counts toward the cap
      state.events.push(e);
      if (e.phase === "settled") {
        state.spentUsd = round(state.spentUsd + (e.priceUsd || 0));
        const m = (state.byMerchant[e.merchant] ??= { spentUsd: 0, calls: 0 });
        m.spentUsd = round(m.spentUsd + (e.priceUsd || 0));
        m.calls += 1;
      }
    }
    if (state.events.length > 1000) state.events = state.events.slice(-1000);
    if (state.events.length)
      console.log(`restored ${state.events.length} events from today, $${state.spentUsd} already spent`);
  }
} catch (e) {
  console.error("state restore failed (starting fresh):", e.message);
}

// A daily cap means a daily WINDOW: at UTC midnight the counters roll over.
function rollDayIfNeeded() {
  const today = utcDay();
  if (today === state.day) return;
  state.day = today;
  state.spentUsd = 0;
  state.byMerchant = {};
  console.log(`UTC day rolled over -> ${today}, daily spend window reset`);
  broadcast(snapshot());
}

// ---------- optional alerts (Telegram) ----------
// Set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID to get pinged on blocked payments,
// flagged settlements, and halt toggles. Fire-and-forget, never blocks the API.
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;
function alert(text) {
  if (!TG_TOKEN || !TG_CHAT) return;
  fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TG_CHAT, text: `🪤 x402-watch: ${text}` }),
  }).catch(() => {});
}

// Decide whether a proposed payment is cleared. This is the trust layer.
function evaluate({ priceUsd, merchant }) {
  rollDayIfNeeded();
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

  rollDayIfNeeded();
  if (e.phase === "settled") {
    state.spentUsd = round(state.spentUsd + e.priceUsd);
    const m = (state.byMerchant[e.merchant] ??= { spentUsd: 0, calls: 0 });
    m.spentUsd = round(m.spentUsd + e.priceUsd);
    m.calls += 1;
    // anomaly: settled above the running daily cap or above per-call cap
    if (
      (state.policy.perCallCapUsd && e.priceUsd > state.policy.perCallCapUsd) ||
      (state.policy.dailyCapUsd && state.spentUsd > state.policy.dailyCapUsd)
    ) {
      e.flagged = true;
      alert(`FLAGGED settlement: $${e.priceUsd} to ${e.merchant} (day total $${round(state.spentUsd)})`);
    }
  }
  if (e.phase === "blocked") {
    e.flagged = true;
    alert(`BLOCKED: $${e.priceUsd} to ${e.merchant} — ${e.note || "policy"}`);
  }

  state.events.push(e);
  if (state.events.length > 1000) state.events.shift();
  try { appendFileSync(EVENTS_FILE, JSON.stringify(e) + "\n"); } catch {}

  broadcast({ type: "event", event: e, spentUsd: round(state.spentUsd) });
  res.json({ ok: true });
});

// Kill-switch — persisted, so a restart can't silently re-arm a halted fleet
app.post("/api/halt", (req, res) => {
  state.halted = Boolean(req.body?.halted ?? true);
  persistControl();
  alert(state.halted ? "KILL SWITCH ENGAGED — all clearance denied" : "re-armed, clearance resumed");
  broadcast({ type: "halt", halted: state.halted });
  res.json({ halted: state.halted });
});

app.post("/api/policy", (req, res) => {
  const { perCallCapUsd, dailyCapUsd, allowlist } = req.body || {};
  if (perCallCapUsd != null) state.policy.perCallCapUsd = Number(perCallCapUsd);
  if (dailyCapUsd != null) state.policy.dailyCapUsd = Number(dailyCapUsd);
  if (Array.isArray(allowlist)) state.policy.allowlist = allowlist;
  persistControl();
  broadcast({ type: "policy", policy: state.policy });
  res.json(state.policy);
});

app.post("/api/reset", (_req, res) => {
  state.events = [];
  state.spentUsd = 0;
  state.byMerchant = {};
  state.halted = false;
  state.startedAt = Date.now();
  try { writeFileSync(EVENTS_FILE, ""); } catch {}
  persistControl();
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
