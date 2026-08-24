import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { generateDeviceKeyPair } from "./cryptoEngine.js";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(serverRoot, "data");
fs.mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(path.join(dataDir, "offlinepay.db"));
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS wallets (
    user_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    balance_paise INTEGER NOT NULL,
    reserved_paise INTEGER NOT NULL DEFAULT 0,
    public_key_pem TEXT NOT NULL,
    private_key_pem TEXT NOT NULL,
    key_id TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS preloads (
    order_id TEXT PRIMARY KEY,
    amount_paise INTEGER NOT NULL,
    source TEXT NOT NULL,
    status TEXT NOT NULL,
    payment_id TEXT,
    raw_json TEXT,
    created_at TEXT NOT NULL,
    paid_at TEXT
  );

  CREATE TABLE IF NOT EXISTS customer_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    txn_id TEXT NOT NULL UNIQUE,
    amount_paise INTEGER NOT NULL,
    direction TEXT NOT NULL,
    status TEXT NOT NULL,
    payload TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS merchant_transactions (
    txn_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    merchant_id TEXT NOT NULL,
    amount_paise INTEGER NOT NULL,
    nonce TEXT NOT NULL UNIQUE,
    packet TEXT NOT NULL,
    signature_status TEXT NOT NULL,
    status TEXT NOT NULL,
    risk_score INTEGER DEFAULT 0,
    risk_summary TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    synced_at TEXT
  );

  CREATE TABLE IF NOT EXISTS central_transactions (
    txn_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    merchant_id TEXT NOT NULL,
    amount_paise INTEGER NOT NULL,
    status TEXT NOT NULL,
    verified_at TEXT NOT NULL,
    packet_hash TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS risk_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id TEXT NOT NULL,
    score INTEGER NOT NULL,
    summary TEXT NOT NULL,
    raw_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

const walletCount = db.prepare("SELECT COUNT(*) AS count FROM wallets").get() as { count: number };

if (walletCount.count === 0) {
  const now = new Date().toISOString();
  const keys = generateDeviceKeyPair();
  db.prepare(`
    INSERT INTO wallets (
      user_id, display_name, balance_paise, reserved_paise,
      public_key_pem, private_key_pem, key_id, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "USER1",
    "Demo Customer",
    0,
    0,
    keys.publicKeyPem,
    keys.privateKeyPem,
    "USER1-DEVICE-ED25519",
    now
  );
}

export const nowIso = () => new Date().toISOString();
