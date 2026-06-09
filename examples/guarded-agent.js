// The real integration: take an existing x402 agent and put its spend under
// supervision in 3 lines. Everything else in this file is a normal agent.
//
//   npm i @x402/fetch @x402/svm @solana/web3.js
//   MONITOR_URL=http://localhost:4040 SOLANA_SECRET_KEY='[...]' node examples/guarded-agent.js
//
// Guarantees (proven by test/watch.test.js):
//   - a payment the monitor denies NEVER reaches the signer
//   - monitor unreachable = no spend (fail-closed; opt into failOpen if you
//     want observability-only semantics)
//   - every lifecycle phase lands on the live tape at the monitor dashboard

import { watch, PaymentBlockedError } from "../src/watch.js";
import { wrapFetchWithPayment } from "@x402/fetch";
import { createSvmSigner } from "@x402/svm";
import { Keypair } from "@solana/web3.js";

const signer = createSvmSigner(
  Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.SOLANA_SECRET_KEY)))
);

// ---- the 3 lines ----------------------------------------------------------
const paidFetch = wrapFetchWithPayment(fetch, signer); // your existing setup
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
