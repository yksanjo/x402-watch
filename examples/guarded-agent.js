// The real integration: take an existing x402 agent and put its spend under
// supervision in 3 lines. Everything else in this file is a normal agent.
//
//   npm i @x402/fetch @x402/svm @solana/kit
//   MONITOR_URL=http://localhost:4040 SOLANA_SECRET_KEY='[...]' node examples/guarded-agent.js
//
// Guarantees (proven by test/watch.test.js):
//   - a payment the monitor denies NEVER reaches the signer
//   - monitor unreachable = no spend (fail-closed; opt into failOpen if you
//     want observability-only semantics)
//   - every lifecycle phase lands on the live tape at the monitor dashboard

import { watch, PaymentBlockedError } from "../src/watch.js";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { registerExactSvmScheme } from "@x402/svm/exact/client";
import { createKeyPairSignerFromBytes } from "@solana/kit";

// verified against @x402/* v2.14.0: kit signer + scheme registered on a client
const signer = await createKeyPairSignerFromBytes(
  Uint8Array.from(JSON.parse(process.env.SOLANA_SECRET_KEY))
);
const client = new x402Client();
registerExactSvmScheme(client, { signer });

// ---- the 3 lines ----------------------------------------------------------
const paidFetch = wrapFetchWithPayment(fetch, client); // your existing setup
const guarded = watch({ payingFetch: paidFetch });     // + supervision
// use `guarded` wherever you used `paidFetch`                    (that's it)
// ---------------------------------------------------------------------------

try {
  const res = await guarded(process.env.RESOURCE_URL || "http://localhost:4021/regime/latest");
  console.log("bought:", await res.json());
} catch (err) {
  if (err instanceof PaymentBlockedError) {
    // the monitor said no — caps, allowlist, or the human hit the kill-switch
    console.log(`payment blocked (${err.reason}) — no funds moved`);
  } else {
    throw err;
  }
}
