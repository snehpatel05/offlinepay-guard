/* ============================================================
   OfflinePay Guard — server/src/index.ts
   FULL REPLACEMENT FILE

   What changed vs the original:
   1. New route: POST /api/wallet/register-key
      Lets the browser register the public key it generated
      locally. The server never sees the matching private key.

   2. Reworked route: POST /api/sync/merchant
      Previously this synced rows that /api/merchant/accept had
      already written into merchant_transactions. Now the client
      does signing AND merchant-accept validation locally (see
      client/static/app.js), so this endpoint instead receives
      the batch of locally-accepted packets directly, verifies
      every signature itself (never trusts the client), applies
      the wallet debit, and writes to customer_ledger /
      central_transactions exactly as before.

   Everything else — /api/health, /api/config, /api/state,
   /api/demo/reset, /api/preload/create, /api/preload/confirm,
   the old /api/offline/create-payment and /api/merchant/accept
   routes, static file serving, error handling — is UNCHANGED.
   The two old routes are left in place (harmless, unused by the
   new client flow) so nothing else in your app can break.

   No changes needed to: canonical.ts, cryptoEngine.ts, db.ts,
   config.ts, razorpay.ts, risk.ts, package.json, index.html.
   ============================================================ */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import { z } from "zod";
import { canonicalJson } from "./canonical.js";
import { config, hasGeminiKey, hasRazorpayKeys } from "./config.js";
import { db, nowIso } from "./db.js";
import {
  decodePacket,
  encodePacket,
  OfflinePacket,
  OfflinePayload,
  sha256Hex,
  signPayload,
  verifyPacket
} from "./cryptoEngine.js";
import { analyzeRisk } from "./risk.js";
import { createRazorpayOrder, verifyRazorpayPaymentSignature } from "./razorpay.js";

const app = express();

app.use(cors({ origin: config.clientOrigin, credentials: true }));
app.use(express.json({ limit: "1mb" }));

const rupeesToPaise = (value: number) => Math.round(value * 100);
const paiseToRupees = (value: number) => value / 100;

const getWallet = () =>
  db.prepare("SELECT * FROM wallets WHERE user_id = ?").get("USER1") as {
    user_id: string;
    display_name: string;
    balance_paise: number;
    reserved_paise: number;
    public_key_pem: string;
    private_key_pem: string;
    key_id: string;
    updated_at: string;
  };

const getPublicKeyForUser = (userId: string) => {
  const row = db.prepare("SELECT public_key_pem FROM wallets WHERE user_id = ?").get(userId) as
    | { public_key_pem: string }
    | undefined;
  return row?.public_key_pem;
};

const asyncHandler =
  (handler: express.RequestHandler): express.RequestHandler =>
  (req, res, next) =>
    Promise.resolve(handler(req, res, next)).catch(next);

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "OfflinePay Guard",
    time: nowIso(),
    integrations: {
      razorpay: hasRazorpayKeys ? "configured" : "demo-mode",
      gemini: hasGeminiKey ? "configured" : "heuristic-fallback"
    }
  });
});

app.get("/api/config", (_req, res) => {
  res.json({
    razorpayKeyId: hasRazorpayKeys ? config.razorpayKeyId : "",
    hasRazorpayKeys,
    hasGeminiKey,
    offlineTxnLimitPaise: config.offlineTxnLimitPaise,
    offlineWalletCapPaise: config.offlineWalletCapPaise,
    allowSimulatedPreload: config.allowSimulatedPreload
  });
});

app.get("/api/state", (_req, res) => {
  const wallet = getWallet();
  const customerLedger = db
    .prepare("SELECT * FROM customer_ledger ORDER BY id DESC LIMIT 10")
    .all();
  const merchantTransactions = db
    .prepare("SELECT * FROM merchant_transactions ORDER BY created_at DESC LIMIT 20")
    .all();
  const riskReports = db.prepare("SELECT * FROM risk_reports ORDER BY id DESC LIMIT 5").all();

  res.json({
    wallet: {
      userId: wallet.user_id,
      displayName: wallet.display_name,
      balancePaise: wallet.balance_paise,
      reservedPaise: wallet.reserved_paise,
      keyId: wallet.key_id,
      updatedAt: wallet.updated_at
    },
    customerLedger,
    merchantTransactions,
    riskReports
  });
});

app.post(
  "/api/demo/reset",
  asyncHandler(async (_req, res) => {
    db.exec(`
      DELETE FROM preloads;
      DELETE FROM customer_ledger;
      DELETE FROM merchant_transactions;
      DELETE FROM central_transactions;
      DELETE FROM risk_reports;
      UPDATE wallets SET balance_paise = 0, reserved_paise = 0, updated_at = '${nowIso()}' WHERE user_id = 'USER1';
    `);
    res.json({ ok: true });
  })
);

/* ----------------------------------------------------------------
   NEW: device public-key registration.
   The browser generates its own Ed25519 keypair (Web Crypto API),
   keeps the private key local, and calls this once to tell the
   server which public key to verify future packets against.
   This intentionally overwrites public_key_pem only — it never
   touches private_key_pem, so the old server-side signing routes
   below still work if you ever want them for a fallback demo.
   ---------------------------------------------------------------- */
app.post(
  "/api/wallet/register-key",
  asyncHandler(async (req, res) => {
    const parsed = z
      .object({ publicKeyPem: z.string().min(20).max(2000) })
      .parse(req.body);

    // Sanity-check it's actually a usable Ed25519 public key before storing it.
    try {
      crypto.createPublicKey(parsed.publicKeyPem);
    } catch {
      res.status(400).json({ error: "Invalid public key format." });
      return;
    }

    db.prepare("UPDATE wallets SET public_key_pem = ?, updated_at = ? WHERE user_id = ?").run(
      parsed.publicKeyPem,
      nowIso(),
      "USER1"
    );
    res.json({ ok: true });
  })
);

app.post(
  "/api/preload/create",
  asyncHandler(async (req, res) => {
    const parsed = z.object({ amountRupees: z.number().positive().max(2000) }).parse(req.body);
    const amountPaise = rupeesToPaise(parsed.amountRupees);
    if (amountPaise > config.offlineWalletCapPaise) {
      res.status(400).json({ error: "Preload exceeds the offline wallet cap." });
      return;
    }

    if (!hasRazorpayKeys) {
      if (!config.allowSimulatedPreload) {
        res.status(400).json({ error: "Razorpay keys are required and simulated preload is disabled." });
        return;
      }
      const orderId = `order_demo_${crypto.randomUUID().slice(0, 8)}`;
      db.prepare(
        "INSERT INTO preloads (order_id, amount_paise, source, status, raw_json, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(orderId, amountPaise, "SIMULATED", "CREATED", JSON.stringify({ id: orderId }), nowIso());
      res.json({
        order: { id: orderId, amount: amountPaise, currency: "INR", status: "created" },
        mode: "simulated"
      });
      return;
    }

    const order = await createRazorpayOrder(amountPaise);
    db.prepare(
      "INSERT INTO preloads (order_id, amount_paise, source, status, raw_json, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(order.id, amountPaise, "RAZORPAY_TEST", "CREATED", JSON.stringify(order), nowIso());
    res.json({ order, mode: "razorpay" });
  })
);

app.post(
  "/api/preload/confirm",
  asyncHandler(async (req, res) => {
    const parsed = z
      .object({
        orderId: z.string(),
        paymentId: z.string().optional(),
        signature: z.string().optional(),
        simulated: z.boolean().optional()
      })
      .parse(req.body);

    const preload = db.prepare("SELECT * FROM preloads WHERE order_id = ?").get(parsed.orderId) as
      | { order_id: string; amount_paise: number; source: string; status: string }
      | undefined;

    if (!preload) {
      res.status(404).json({ error: "Preload order not found." });
      return;
    }
    if (preload.status === "PAID") {
      res.json({ ok: true, alreadyPaid: true });
      return;
    }

    const isSimulated = parsed.simulated && preload.source === "SIMULATED" && config.allowSimulatedPreload;
    const isVerified =
      parsed.paymentId &&
      parsed.signature &&
      verifyRazorpayPaymentSignature({
        orderId: parsed.orderId,
        paymentId: parsed.paymentId,
        signature: parsed.signature
      });

    if (!isSimulated && !isVerified) {
      res.status(400).json({ error: "Razorpay payment signature verification failed." });
      return;
    }

    const now = nowIso();
    db.exec("BEGIN");
    try {
      db.prepare("UPDATE preloads SET status = ?, payment_id = ?, paid_at = ? WHERE order_id = ?").run(
        "PAID",
        parsed.paymentId ?? "pay_demo_success",
        now,
        parsed.orderId
      );
      db.prepare("UPDATE wallets SET balance_paise = balance_paise + ?, updated_at = ? WHERE user_id = ?").run(
        preload.amount_paise,
        now,
        "USER1"
      );
      db.prepare(
        "INSERT INTO customer_ledger (txn_id, amount_paise, direction, status, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(`PRELOAD-${parsed.orderId}`, preload.amount_paise, "CREDIT", "SETTLED", parsed.orderId, now);
      db.exec("COMMIT");
      res.json({ ok: true, addedPaise: preload.amount_paise });
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  })
);

/* ----------------------------------------------------------------
   UNCHANGED (kept as a fallback / reference — the new client no
   longer calls this route, since signing now happens in-browser).
   ---------------------------------------------------------------- */
app.post(
  "/api/offline/create-payment",
  asyncHandler(async (req, res) => {
    const parsed = z
      .object({
        amountRupees: z.number().positive(),
        merchantId: z.string().min(2).default("MCH1")
      })
      .parse(req.body);
    const amountPaise = rupeesToPaise(parsed.amountRupees);

    if (amountPaise > config.offlineTxnLimitPaise) {
      res.status(400).json({ error: `Exceeds ₹${paiseToRupees(config.offlineTxnLimitPaise)} offline limit.` });
      return;
    }

    const wallet = getWallet();
    if (wallet.balance_paise < amountPaise) {
      res.status(400).json({ error: "Insufficient offline sub-wallet balance." });
      return;
    }

    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + 10 * 60 * 1000);
    const nonce = crypto.randomUUID();
    const payload: OfflinePayload = {
      type: "OFFLINE_IOU",
      version: 1,
      userId: wallet.user_id,
      merchantId: parsed.merchantId,
      amountPaise,
      currency: "INR",
      nonce,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      previousBalancePaise: wallet.balance_paise,
      keyId: wallet.key_id
    };
    const packet = signPayload(payload, wallet.private_key_pem);
    const armored = encodePacket(packet);

    const now = nowIso();
    db.exec("BEGIN");
    try {
      db.prepare("UPDATE wallets SET balance_paise = balance_paise - ?, updated_at = ? WHERE user_id = ?").run(
        amountPaise,
        now,
        wallet.user_id
      );
      db.prepare(
        "INSERT INTO customer_ledger (txn_id, amount_paise, direction, status, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(nonce, amountPaise, "DEBIT", "OFFLINE_ISSUED", armored, now);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    res.json({
      ok: true,
      packet: armored,
      payload,
      signaturePreview: packet.signature.slice(0, 20),
      packetHash: sha256Hex(armored)
    });
  })
);

/* ----------------------------------------------------------------
   UNCHANGED (kept as a fallback / reference — the new client now
   validates merchant-accept locally instead of calling this route).
   ---------------------------------------------------------------- */
app.post(
  "/api/merchant/accept",
  asyncHandler(async (req, res) => {
    const parsed = z.object({ packet: z.string().min(10), merchantId: z.string().default("MCH1") }).parse(req.body);
    let packet: OfflinePacket;
    try {
      packet = decodePacket(parsed.packet.trim());
    } catch {
      res.status(400).json({ error: "Malformed offline packet." });
      return;
    }

    const payload = packet.payload;
    if (payload.type !== "OFFLINE_IOU" || payload.currency !== "INR") {
      res.status(400).json({ error: "Unsupported payment payload." });
      return;
    }
    if (payload.amountPaise > config.offlineTxnLimitPaise) {
      res.status(400).json({ error: "Exceeds offline transaction limit." });
      return;
    }
    if (payload.merchantId !== parsed.merchantId) {
      res.status(400).json({ error: "Merchant mismatch. Packet is not payable to this merchant." });
      return;
    }
    if (Date.parse(payload.expiresAt) < Date.now()) {
      res.status(400).json({ error: "Expired offline packet." });
      return;
    }

    const publicKey = getPublicKeyForUser(payload.userId);
    if (!publicKey || !verifyPacket(packet, publicKey)) {
      res.status(400).json({ error: "Data tampered. Signature validation failed." });
      return;
    }

    const duplicate = db
      .prepare("SELECT txn_id FROM merchant_transactions WHERE nonce = ? OR txn_id = ?")
      .get(payload.nonce, payload.nonce);
    if (duplicate) {
      res.status(409).json({ error: "Duplicate transaction. Replay attack blocked." });
      return;
    }

    const now = nowIso();
    db.prepare(
      `INSERT INTO merchant_transactions (
        txn_id, user_id, merchant_id, amount_paise, nonce, packet,
        signature_status, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      payload.nonce,
      payload.userId,
      payload.merchantId,
      payload.amountPaise,
      payload.nonce,
      parsed.packet.trim(),
      "VALID",
      "PENDING_SYNC",
      now
    );

    res.json({
      ok: true,
      message: "Verified offline payment committed to merchant ledger.",
      transaction: {
        txnId: payload.nonce,
        amountPaise: payload.amountPaise,
        status: "PENDING_SYNC",
        createdAt: now
      }
    });
  })
);

/* ----------------------------------------------------------------
   REWORKED: now receives packets the client generated AND accepted
   fully offline. Every signature is independently re-verified here
   against the public key on file — the server never trusts the
   client's word that a packet is valid. This is also where the
   wallet debit finally happens (since the server had no visibility
   into the transaction until this point).
   ---------------------------------------------------------------- */
app.post(
  "/api/sync/merchant",
  asyncHandler(async (req, res) => {
    const parsed = z
      .object({
        packets: z
          .array(
            z.object({
              txnId: z.string(),
              armored: z.string().min(10)
            })
          )
          .default([])
      })
      .parse(req.body);

    // Also pick up any legacy rows created via the old /api/merchant/accept
    // route, if present, so nothing that used the old path silently vanishes.
    const legacyPending = db
      .prepare("SELECT * FROM merchant_transactions WHERE status = ? ORDER BY created_at ASC")
      .all("PENDING_SYNC") as Array<{
      txn_id: string;
      user_id: string;
      merchant_id: string;
      amount_paise: number;
      packet: string;
      created_at: string;
    }>;

    const batchId = `BATCH-${Date.now()}`;
    const rejectedSignals: string[] = [];
    let synced = 0;

    const wallet = getWallet();
    let runningBalance = wallet.balance_paise;

    const riskTransactions: Array<{
      txnId: string;
      userId: string;
      merchantId: string;
      amountPaise: number;
      status: string;
      createdAt: string;
    }> = [];

    db.exec("BEGIN");
    try {
      // 1) New-style: client-signed-and-accepted packets submitted directly.
      for (const item of parsed.packets) {
        let packet: OfflinePacket;
        try {
          packet = decodePacket(item.armored);
        } catch {
          rejectedSignals.push(`rejected:${item.txnId}:malformed`);
          continue;
        }
        const payload = packet.payload;

        riskTransactions.push({
          txnId: payload.nonce,
          userId: payload.userId,
          merchantId: payload.merchantId,
          amountPaise: payload.amountPaise,
          status: "PENDING_SYNC",
          createdAt: nowIso()
        });

        const publicKey = getPublicKeyForUser(payload.userId);
        const alreadyCentral = db
          .prepare("SELECT txn_id FROM central_transactions WHERE txn_id = ?")
          .get(payload.nonce);

        const withinLimit = payload.amountPaise <= config.offlineTxnLimitPaise;
        const notExpired = Date.parse(payload.expiresAt) >= Date.parse(payload.issuedAt);
        const sigValid = Boolean(publicKey) && verifyPacket(packet, publicKey as string);
        const balanceOk = runningBalance - payload.amountPaise >= 0;

        if (!sigValid || alreadyCentral || !withinLimit || !notExpired || !balanceOk) {
          rejectedSignals.push(`rejected:${payload.nonce}`);
          continue;
        }

        runningBalance -= payload.amountPaise;

        db.prepare(
          "INSERT INTO central_transactions (txn_id, user_id, merchant_id, amount_paise, status, verified_at, packet_hash) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).run(
          payload.nonce,
          payload.userId,
          payload.merchantId,
          payload.amountPaise,
          "VERIFIED",
          nowIso(),
          sha256Hex(canonicalJson(packet))
        );

        db.prepare(
          "INSERT INTO customer_ledger (txn_id, amount_paise, direction, status, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)"
        ).run(payload.nonce, payload.amountPaise, "DEBIT", "SYNCED", item.armored, nowIso());

        const alreadyInMerchantLedger = db
          .prepare("SELECT txn_id FROM merchant_transactions WHERE txn_id = ?")
          .get(payload.nonce);

        if (!alreadyInMerchantLedger) {
          db.prepare(
            `INSERT INTO merchant_transactions (
              txn_id, user_id, merchant_id, amount_paise, nonce, packet,
              signature_status, status, created_at, synced_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(
            payload.nonce,
            payload.userId,
            payload.merchantId,
            payload.amountPaise,
            payload.nonce,
            item.armored,
            "VALID",
            "SYNCED",
            nowIso(),
            nowIso()
          );
        } else {
          db.prepare("UPDATE merchant_transactions SET status = ?, synced_at = ? WHERE txn_id = ?").run(
            "SYNCED",
            nowIso(),
            payload.nonce
          );
        }

        synced += 1;
      }

      // 2) Legacy-style: rows already sitting in merchant_transactions from
      //    the old /api/merchant/accept route (harmless to keep supporting).
      for (const txn of legacyPending) {
        const packet = decodePacket(txn.packet);
        const publicKey = getPublicKeyForUser(packet.payload.userId);
        const alreadyCentral = db
          .prepare("SELECT txn_id FROM central_transactions WHERE txn_id = ?")
          .get(txn.txn_id);

        riskTransactions.push({
          txnId: txn.txn_id,
          userId: txn.user_id,
          merchantId: txn.merchant_id,
          amountPaise: txn.amount_paise,
          status: "PENDING_SYNC",
          createdAt: txn.created_at
        });

        const balanceOk = runningBalance - txn.amount_paise >= 0;

        if (!publicKey || !verifyPacket(packet, publicKey) || alreadyCentral || !balanceOk) {
          rejectedSignals.push(`rejected:${txn.txn_id}`);
          db.prepare("UPDATE merchant_transactions SET status = ?, risk_score = ? WHERE txn_id = ?").run(
            "REJECTED_SYNC",
            95,
            txn.txn_id
          );
          continue;
        }

        runningBalance -= txn.amount_paise;

        db.prepare(
          "INSERT INTO central_transactions (txn_id, user_id, merchant_id, amount_paise, status, verified_at, packet_hash) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).run(
          txn.txn_id,
          txn.user_id,
          txn.merchant_id,
          txn.amount_paise,
          "VERIFIED",
          nowIso(),
          sha256Hex(canonicalJson(packet))
        );
        db.prepare("UPDATE merchant_transactions SET status = ?, synced_at = ? WHERE txn_id = ?").run(
          "SYNCED",
          nowIso(),
          txn.txn_id
        );
        synced += 1;
      }

      db.prepare("UPDATE wallets SET balance_paise = ?, updated_at = ? WHERE user_id = ?").run(
        runningBalance,
        nowIso(),
        "USER1"
      );

      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    const riskReport = await analyzeRisk({
      batchId,
      rejectedSignals,
      transactions: riskTransactions
    });

    db.prepare(
      "INSERT INTO risk_reports (batch_id, score, summary, raw_json, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(batchId, riskReport.score, riskReport.summary, JSON.stringify(riskReport), nowIso());

    res.json({
      ok: true,
      batchId,
      pending: parsed.packets.length + legacyPending.length,
      synced,
      rejected: rejectedSignals.length,
      riskReport
    });
  })
);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof z.ZodError) {
    res.status(400).json({ error: err.errors.map((item) => item.message).join(", ") });
    return;
  }
  const message = err instanceof Error ? err.message : "Unexpected server error";
  res.status(500).json({ error: message });
});

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = path.resolve(serverRoot, "..");
const builtClient = path.join(projectRoot, "client", "dist");
const staticClient = path.join(projectRoot, "client", "static");
const staticDir = fs.existsSync(path.join(builtClient, "index.html")) ? builtClient : staticClient;
app.use(express.static(staticDir));
app.get("*", (_req, res) => {
  res.sendFile(path.join(staticDir, "index.html"));
});

app.listen(config.port, () => {
  console.log(`OfflinePay Guard API running on http://localhost:${config.port}`);
});
