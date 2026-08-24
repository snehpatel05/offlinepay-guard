# Razorpay AI Buildathon Submission Notes

## Project Name

OfflinePay Guard

## One-Liner

AI-assisted offline payments for low-connectivity India: prepaid Razorpay-backed sub-wallets create cryptographically signed IOUs that merchants can verify offline and reconcile safely when internet returns.

## Problem

Digital payments fail in markets, transport, events, and rural areas when either customer or merchant internet is unreliable. Cash becomes the fallback even for small transactions.

## Solution

OfflinePay Guard lets a customer preload funds online, then issue low-value signed offline payment packets. Merchants verify signatures and nonces locally, store pending rows in SQLite, and sync them to the backend later. An AI risk agent summarizes anomalies for operators.

## AI Usage

Gemini reviews sync batches and produces structured risk analysis:

- replay attempts
- amount splitting
- expiry violations
- merchant mismatch
- abnormal offline velocity
- tamper/signature failure patterns

When Gemini is not configured, deterministic local heuristics keep the demo functional.

## Architecture

```text
Razorpay Test Mode -> Backend preload order -> Local customer wallet
Local customer wallet -> Signed offline packet -> Merchant local SQLite
Merchant pending ledger -> Sync API -> Signature verification -> Central ledger
Central ledger -> Gemini risk review -> Operator dashboard
```

## Security Controls

- Per-transaction nonce.
- Ed25519 signature over canonical payload.
- Merchant-bound payloads.
- Expiry timestamp.
- Offline transaction limit.
- Offline wallet cap.
- Replay-blocking nonce table.
- Re-verification during reconciliation.
- `.env` secrets ignored by Git.

## What Is Simulated

- Actual bank account lock/settlement.
- Regulated PSP production access.
- Secure hardware-backed private key storage.

## What Is Real in the Prototype

- Razorpay Orders API integration.
- Razorpay Checkout integration path.
- Razorpay payment signature verification.
- SQLite persistence.
- Offline packet signature and verification.
- Replay detection.
- Sync state transitions.
- Gemini API integration.
