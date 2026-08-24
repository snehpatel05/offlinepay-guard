# OfflinePay Guard

> **AI-assisted offline payments for low-connectivity commerce, built for the Razorpay AI Buildathon.**

<p align="center">
  <a href="https://offlinepay-guard.onrender.com">
    <strong>🚀 LIVE DEMO — OPEN OFFLINEPAY GUARD</strong>
  </a>
</p>

<p align="center">
  <a href="https://offlinepay-guard.onrender.com">
    https://offlinepay-guard.onrender.com
  </a>
</p>

OfflinePay Guard lets a customer preload a small sub-wallet online, generate a cryptographically signed offline payment packet, let a merchant verify it without internet, and reconcile the transaction safely when connectivity returns. A Gemini-powered risk layer explains suspicious sync batches such as replay attempts, tampered packets, high-value offline activity, or duplicate nonces.

> **Razorpay Test Mode Buildathon Prototype**  
> This is not a production payment system or a regulated PSP implementation.

---

## 🚀 Live Demo

**[Open OfflinePay Guard →](https://offlinepay-guard.onrender.com)**

Experience the complete prototype:

**Preload → Go Offline → Generate Signed Payment → Merchant Verification → Replay/Tamper Protection → Reconciliation → AI Risk Review**

> **Note:** The demo is hosted on Render's free tier and may take a few seconds to wake up after a period of inactivity.

---

## Why This Matters
## Why This Matters

Digital payments are excellent until the network disappears. Small merchants, rural stores, event counters, transport points, campus canteens, and crowded markets often face unreliable connectivity. When UPI or card flows fail, cash becomes the fallback.

OfflinePay Guard explores a safer middle path for low-value offline payments:

- preload money while online
- enforce a strict offline transaction limit
- sign each offline IOU with device keys
- let merchants verify packets locally
- block replay attacks with nonce history
- sync and re-verify everything later
- use AI to explain risk during reconciliation

## Core Demo

```text
Razorpay Test Mode
        |
        v
Customer Local Sub-Wallet
        |
        | signed offline packet
        v
Merchant Local SQLite Ledger
        |
        | pending sync batch
        v
Backend Reconciliation API
        |
        v
Gemini Risk Review
```

## Features

- Razorpay Test Mode preload using Orders API.
- Razorpay Checkout integration.
- Backend verification of Razorpay payment signatures.
- Local SQLite wallet and merchant ledgers.
- Offline signed payment packets using Ed25519.
- Merchant-side signature validation.
- Nonce-based replay protection.
- Tamper rejection.
- Pending sync state with `PENDING_SYNC` and `SYNCED`.
- Gemini AI risk report after reconciliation.
- Local heuristic risk fallback if Gemini is not configured.
- Safe `.env` based secret handling.
- Single local app URL for fast judging/demo.

## Tech Stack

- Node.js 24
- Express
- TypeScript
- Node built-in SQLite
- Razorpay Test Mode APIs
- Gemini API
- HTML/CSS/JavaScript frontend served by Express
- Ed25519 signatures using Node crypto

## Project Structure

```text
.
├── client/
│   └── static/              # Judge-facing frontend
├── server/
│   └── src/                 # Express API, crypto, DB, Razorpay, AI risk
├── docs/
│   └── SUBMISSION.md        # Buildathon submission notes
├── .env.example             # Safe template only
├── .gitignore
├── package.json
└── README.md
```

## Setup

Install dependencies:

```bash
npm install
```

Create your private environment file:

```bash
copy .env.example .env
```

Paste your own test keys into `.env`:

```env
PORT=8787
CLIENT_ORIGIN=http://localhost:5173

RAZORPAY_KEY_ID=rzp_test_your_key_id_here
RAZORPAY_KEY_SECRET=your_test_secret_here

GEMINI_API_KEY=your_gemini_key_here
GEMINI_MODEL=gemini-2.5-flash

OFFLINE_TXN_LIMIT_PAISE=50000
OFFLINE_WALLET_CAP_PAISE=200000
DEMO_ALLOW_SIMULATED_PRELOAD=true
```

Start the app:

```bash
npm start
```

Open:

```text
http://localhost:8787
```

Health check:

```text
http://localhost:8787/api/health
```

## API Key Safety

Use only Razorpay Test Mode keys.

Safe:

```text
rzp_test_...
```

Do not use:

```text
rzp_live_...
```

Never commit `.env`. This repo intentionally keeps `.env` ignored through `.gitignore`.

## Demo Flow

Use this flow for the 5-minute buildathon pitch.

```text
START
  |
  v
Open http://localhost:8787
  |
  v
Check top badges:
Razorpay ready + AI Gemini
  |
  v
ACT 1: PRELOAD
Click "Open Razorpay Checkout"
  |
  v
Use dummy contact details
Phone: 9876543210
Email: test@example.com
  |
  v
Choose Netbanking in Razorpay Test Mode
  |
  v
Complete test payment
  |
  v
Wallet balance increases
  |
  v
Click "Go Offline"
  |
  v
ACT 2: OFFLINE PAYMENT
Amount: ₹200
Merchant: MCH1
Click "Generate Signed Packet"
  |
  v
Signed offline packet appears
  |
  v
Click "Merchant Accept"
  |
  v
Merchant ledger stores PENDING_SYNC row
  |
  v
Click "Merchant Accept" again
  |
  v
Replay attack is blocked
  |
  v
Optional: click "Tamper Test"
  |
  v
Click "Merchant Accept"
  |
  v
Signature validation fails
  |
  v
Click "Go Online"
  |
  v
ACT 3: RECONCILIATION
Click "Sync Pending Ledger"
  |
  v
Backend re-verifies packet signatures
  |
  v
Rows become SYNCED
  |
  v
Gemini generates AI risk analysis
  |
  v
END
```

## Razorpay Test Checkout Notes

For the demo, prefer Netbanking in Razorpay Checkout. It avoids card-specific restrictions such as international-card blocking.

Use dummy contact details:

```text
Name: Test User
Email: test@example.com
Phone: 9876543210
```

Do not enter real OTPs during demos. If a real OTP appears because a real phone number was entered, close the checkout and restart with dummy details.

## Security Model

OfflinePay Guard uses a signed IOU model.

Each offline packet contains:

- user ID
- merchant ID
- amount
- currency
- nonce
- issue timestamp
- expiry timestamp
- previous wallet balance
- device key ID
- Ed25519 signature

Merchant validation checks:

- packet format
- transaction amount limit
- merchant binding
- expiry
- user public key
- Ed25519 signature
- nonce replay history

Sync validation checks signatures again before inserting into the central ledger.

## AI Layer

Gemini reviews reconciliation batches and returns:

- risk score
- short summary
- findings

Examples of signals:

- duplicate nonce
- replay attempt
- tampered payload
- near-limit transaction
- suspicious offline activity pattern
- rejected sync row

If `GEMINI_API_KEY` is missing, the app uses deterministic local heuristics so the demo still works.

## API Endpoints

```text
GET  /api/health
GET  /api/config
GET  /api/state
POST /api/preload/create
POST /api/preload/confirm
POST /api/offline/create-payment
POST /api/merchant/accept
POST /api/sync/merchant
POST /api/demo/reset
```

## Verification

Run checks:

```bash
npm run check
```

Build:

```bash
npm run build
```

Expected result:

```text
server TypeScript check passes
client static JavaScript syntax check passes
server build passes
```

## What Is Real

- Razorpay Orders API call.
- Razorpay Checkout integration.
- Razorpay payment signature verification.
- SQLite persistence.
- Offline payment packet generation.
- Ed25519 signature verification.
- Replay blocking.
- Sync state transitions.
- Gemini risk analysis.

## What Is Simulated

- Production bank account lock.
- Actual regulated settlement.
- PSP-grade device attestation.
- Hardware-backed private key storage.
- Dispute and refund operations.

## Future Scope

- Hardware-backed secure element for private keys.
- QR/audio/NFC local transmission.
- Merchant app as Android PWA.
- Risk thresholds configurable per merchant.
- Settlement dashboard for operators.
- Multi-device wallet recovery.
- Formal audit log exports.
- Partner-bank or PSP integration for regulated deployment.

## Buildathon Pitch

OfflinePay Guard is not trying to replace UPI. It asks a focused question:

> What should happen when a legitimate low-value payment needs to work, but the network does not?

The prototype answers with a constrained offline wallet, cryptographic IOUs, merchant-local verification, delayed reconciliation, and AI-assisted risk review. It is built to fail safely: high amounts are rejected, tampered packets fail, duplicates are blocked, and every offline payment is re-verified before sync.

