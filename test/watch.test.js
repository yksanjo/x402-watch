// x402-watch · no-mock tests
// Spins up the REAL monitor (child process, temp data dir) and a REAL x402-style
// merchant over real HTTP, then proves the watch() wrapper's guarantees:
// payment cannot happen without clearance, fail-closed by default, caps and
// kill-switch enforced, controls survive a monitor restart.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { watch, parse402, PaymentBlockedError } from "../src/watch.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MONITOR_PORT = 14600 + (process.pid % 100);
const MERCHANT_PORT = MONITOR_PORT + 1;
const MONITOR = `http://localhost:${MONITOR_PORT}`;
const DATA_DIR = mkdtempSync(join(tmpdir(), "x402-watch-test-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let monitorProc = null;
let merchantServer = null;
let payCalls = 0; // how many times the paying fetch actually paid

function startMonitor(extraEnv = {}) {
  const proc = spawn(process.execPath, [join(__dirname, "..", "src", "monitor.js")], {
    env: {
      ...process.env,
      MONITOR_PORT: String(MONITOR_PORT),
      DATA_DIR,
      PER_CALL_CAP_USD: "0.5",
      DAILY_CAP_USD: "1",
      MERCHANT_ALLOWLIST: "",
      ...extraEnv,
    },
    stdio: "ignore",
  });
  return proc;
}

async function waitUp(url, tries = 50) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error(`server at ${url} never came up`);
}

async function snapshot() {
  return (await fetch(`${MONITOR}/api/snapshot`)).json();
}

// A real x402-style merchant: 402 with payment requirements until an
// X-PAYMENT header arrives, then 200 + x-payment-response (like a facilitator
// settlement receipt). priceUsd comes from the path so tests control it.
function startMerchant() {
  const app = express();
  app.get("/buy/:cents", (req, res) => {
    const usd = Number(req.params.cents) / 100;
    if (!req.headers["x-payment"]) {
      return res.status(402).json({
        accepts: [{
          scheme: "exact",
          maxAmountRequired: String(Math.round(usd * 1e6)), // USDC atomic units
          extra: { decimals: 6 },
          payTo: "TESTPAYTO11111111111111111111111111111111",
          network: "solana-devnet",
        }],
      });
    }
    payCalls++;
    res.setHeader(
      "x-payment-response",
      Buffer.from(JSON.stringify({ transaction: "TESTSIG" + "1".repeat(80) })).toString("base64")
    );
    res.json({ data: "the goods", usd });
  });
  return new Promise((resolve) => {
    const s = app.listen(MERCHANT_PORT, () => resolve(s));
  });
}

// The "paying fetch": a real fetch that attaches a payment header, the way
// wrapFetchWithPayment would after signing. If watch() never calls this,
// no payment can possibly have happened.
const payingFetch = (url, init = {}) =>
  fetch(url, { ...init, headers: { ...(init.headers || {}), "X-PAYMENT": "signed-stub" } });

const buyUrl = (cents) => `http://localhost:${MERCHANT_PORT}/buy/${cents}`;

before(async () => {
  monitorProc = startMonitor();
  merchantServer = await startMerchant();
  await waitUp(`${MONITOR}/api/snapshot`);
});

after(() => {
  monitorProc?.kill();
  merchantServer?.close();
});

test("parse402 reads v2 accepts (atomic units) and price-string fallback", () => {
  assert.equal(
    parse402({ accepts: [{ maxAmountRequired: "50000", extra: { decimals: 6 } }] }).priceUsd,
    0.05
  );
  assert.equal(parse402({ accepts: [{ price: "$0.25" }] }).priceUsd, 0.25);
  assert.equal(parse402({ nope: true }), null);
});

test("free resources pass straight through — paying fetch never touched", async () => {
  const guarded = watch({ payingFetch, monitor: MONITOR });
  const app = express();
  app.get("/free", (_q, r) => r.json({ free: true }));
  const free = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
  const port = free.address().port;
  const before = payCalls;
  const r = await guarded(`http://localhost:${port}/free`);
  assert.equal(r.status, 200);
  assert.equal(payCalls, before);
  free.close();
});

test("cleared payment goes through and lands on the monitor tape", async () => {
  const guarded = watch({ payingFetch, monitor: MONITOR });
  const before = payCalls;
  const r = await guarded(buyUrl(5)); // $0.05, under both caps
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).data, "the goods");
  assert.equal(payCalls, before + 1);
  await sleep(300); // reports are fire-and-forget
  const s = await snapshot();
  assert.equal(s.spentUsd >= 0.05, true);
  const settled = s.recent.filter((e) => e.phase === "settled");
  assert.equal(settled.length >= 1, true);
  assert.match(settled.at(-1).txSig, /^TESTSIG/);
});

test("over per-call cap: blocked BEFORE any payment", async () => {
  const guarded = watch({ payingFetch, monitor: MONITOR });
  const before = payCalls;
  await assert.rejects(() => guarded(buyUrl(75)), (err) => {
    assert.ok(err instanceof PaymentBlockedError);
    assert.equal(err.reason, "per_call_cap");
    return true;
  });
  assert.equal(payCalls, before, "paying fetch must never run for a denied payment");
  await sleep(300);
  const s = await snapshot();
  assert.equal(s.recent.some((e) => e.phase === "blocked" && e.flagged), true);
});

test("daily cap: spending past the window gets denied", async () => {
  const guarded = watch({ payingFetch, monitor: MONITOR });
  // daily cap $1; burn it down with $0.30 calls
  let blocked = null;
  for (let i = 0; i < 6; i++) {
    try { await guarded(buyUrl(30)); } catch (e) { blocked = e; break; }
  }
  assert.ok(blocked instanceof PaymentBlockedError);
  assert.equal(blocked.reason, "daily_cap");
});

test("kill-switch denies everything; paying fetch never runs", async () => {
  await fetch(`${MONITOR}/api/halt`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ halted: true }),
  });
  const guarded = watch({ payingFetch, monitor: MONITOR });
  const before = payCalls;
  await assert.rejects(() => guarded(buyUrl(1)), (err) => err.reason === "halted");
  assert.equal(payCalls, before);
});

test("controls survive a monitor restart (halted stays halted)", async () => {
  monitorProc.kill();
  await sleep(300);
  monitorProc = startMonitor();
  await waitUp(`${MONITOR}/api/snapshot`);
  const s = await snapshot();
  assert.equal(s.halted, true, "halt flag must survive restart");
  assert.equal(s.spentUsd > 0, true, "today's spend must survive restart");
  // re-arm for remaining tests
  await fetch(`${MONITOR}/api/halt`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ halted: false }),
  });
});

test("monitor unreachable: fail-CLOSED by default, fail-open only if asked", async () => {
  const dead = "http://localhost:1"; // nothing listens here
  const guardedClosed = watch({ payingFetch, monitor: dead, timeoutMs: 500 });
  const before = payCalls;
  await assert.rejects(() => guardedClosed(buyUrl(1)), (err) => err.reason === "monitor_unreachable");
  assert.equal(payCalls, before, "fail-closed: no monitor, no spend");

  const guardedOpen = watch({ payingFetch, monitor: dead, failOpen: true, timeoutMs: 500 });
  const r = await guardedOpen(buyUrl(1));
  assert.equal(r.status, 200);
  assert.equal(payCalls, before + 1, "failOpen lets payment through unwatched");
});

test("unparseable 402 is never paid blind", async () => {
  const app = express();
  app.get("/weird", (_q, r) => r.status(402).json({ mystery: true }));
  const weird = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
  const port = weird.address().port;
  const guarded = watch({ payingFetch, monitor: MONITOR });
  const before = payCalls;
  await assert.rejects(() => guarded(`http://localhost:${port}/weird`), (err) => err.reason === "unparseable_402");
  assert.equal(payCalls, before);
  weird.close();
});
