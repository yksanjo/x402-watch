// x402-watch · optional local merchant (real-mode only)
// A tiny x402-gated resource so you can run the whole loop end-to-end on
// Solana devnet without depending on a third-party paid endpoint.
//
// Real-mode only. Requires the optional deps (npm i) and a devnet PAY_TO
// wallet. In sim mode you do not need this — the agent simulates settlement.

import express from "express";

const PORT = process.env.MERCHANT_PORT || 4021;
const PAY_TO = process.env.PAY_TO;           // your devnet receiving address
const NETWORK = process.env.X402_NETWORK || "solana-devnet";
const FACILITATOR_URL = process.env.FACILITATOR_URL || "https://facilitator.payai.network";

if (!PAY_TO) {
  console.error("set PAY_TO to a Solana devnet address before running the merchant");
  process.exit(1);
}

const app = express();

// Wired against @x402/express + @x402/svm (v2.14.x). Confirm scheme registration
// against the installed package README — the SDK surface changes frequently.
const { paymentMiddleware, x402ResourceServer } = await import("@x402/express");
const { HTTPFacilitatorClient } = await import("@x402/core/server");
const { ExactSvmScheme } = await import("@x402/svm/exact/server");

const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
// CAIP-2 id for Solana devnet:
const SOLANA_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const resourceServer = new x402ResourceServer(facilitator).register(
  SOLANA_DEVNET,
  new ExactSvmScheme()
);

app.use(
  paymentMiddleware(
    {
      "GET /regime/latest": {
        accepts: [{ scheme: "exact", price: "$0.05", network: SOLANA_DEVNET, payTo: PAY_TO }],
        description: "Latest cross-venue perps regime classification",
        mimeType: "application/json",
      },
    },
    resourceServer
  )
);

app.get("/regime/latest", (_req, res) => {
  res.json({ regime: "risk-on", confidence: 0.72, venues: ["drift", "jupiter"], ts: Date.now() });
});

app.listen(PORT, () => console.log(`merchant on http://localhost:${PORT} · payTo=${PAY_TO} · ${NETWORK}`));
