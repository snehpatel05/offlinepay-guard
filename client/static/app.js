/* ============================================================
   OfflinePay Guard — client/static/app.js
   FULL REPLACEMENT FILE

   What changed vs the original:
   - Added a self-contained Ed25519 module using the browser's
     native Web Crypto API (no external library, no CDN, no new
     npm dependency).
   - The device generates its own keypair on first load and keeps
     the private key ONLY in this browser (localStorage). The
     private key is never sent anywhere.
   - "Generate Signed Packet" (handleGenerate) now signs locally.
     Zero network calls. Works with wifi fully off.
   - "Merchant Accept" (handleAccept) now verifies the signature
     locally too, so the whole Act 2 handshake is offline.
   - A small local ledger (in localStorage) tracks the offline
     balance and pending merchant transactions until you press
     "Sync Pending Ledger", which is the only step that still
     talks to the server (by design — that's the reconciliation
     step).
   - Everything else (preload, Razorpay checkout, network pill,
     reset, table rendering) behaves the same as before.

   Nothing here requires index.html to change. This is still a
   plain classic script (no <script type="module">), so your
   existing script tag keeps working as-is.
   ============================================================ */

/* ---------------------------------------------------------------
   SECTION 1: Local Ed25519 crypto (Web Crypto API)
   --------------------------------------------------------------- */

const DEVICE_KEY_STORAGE = "opg_device_keypair_v1";
const LOCAL_WALLET_STORAGE = "opg_local_wallet_v1";

// DER prefix for an Ed25519 SubjectPublicKeyInfo (SPKI) structure.
// This matches exactly what Node's crypto.KeyObject.export({type:"spki"})
// produces for Ed25519 keys, so the server's existing verifyPacket()
// (which expects a PEM-wrapped SPKI key) keeps working unmodified.
const SPKI_PREFIX = new Uint8Array([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00
]);

const bytesToBase64 = (bytes) => {
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
};

const base64ToBytes = (b64) =>
  Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

const bytesToBase64Url = (bytes) =>
  bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const base64UrlToBytes = (value) => {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  return base64ToBytes(padded);
};

const publicKeyRawToSpkiPem = (rawPublicKeyBytes) => {
  const der = new Uint8Array(SPKI_PREFIX.length + rawPublicKeyBytes.length);
  der.set(SPKI_PREFIX, 0);
  der.set(rawPublicKeyBytes, SPKI_PREFIX.length);
  const b64 = bytesToBase64(der);
  const lines = b64.match(/.{1,64}/g).join("\n");
  return `-----BEGIN PUBLIC KEY-----\n${lines}\n-----END PUBLIC KEY-----\n`;
};

// Same canonical JSON algorithm as server/src/canonical.ts (canonicalJson).
// Must stay byte-for-byte identical or signatures won't verify server-side.
const canonicalJson = (input) => {
  if (input === null || typeof input !== "object") {
    return JSON.stringify(input);
  }
  if (Array.isArray(input)) {
    return `[${input.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const keys = Object.keys(input).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(input[key])}`)
    .join(",")}}`;
};

const toBase64UrlString = (str) => bytesToBase64Url(new TextEncoder().encode(str));
const fromBase64UrlString = (value) => new TextDecoder().decode(base64UrlToBytes(value));

let deviceKeyPair = null; // { privateKey: CryptoKey, publicKey: CryptoKey, publicKeyRaw: Uint8Array }

const generateDeviceKeyPair = async () => {
  const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const privateJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  localStorage.setItem(
    DEVICE_KEY_STORAGE,
    JSON.stringify({ privateJwk, publicKeyRawB64: bytesToBase64(publicRaw) })
  );
  return { privateKey: keyPair.privateKey, publicKey: keyPair.publicKey, publicKeyRaw: publicRaw };
};

const loadDeviceKeyPair = async () => {
  const raw = localStorage.getItem(DEVICE_KEY_STORAGE);
  if (!raw) return generateDeviceKeyPair();

  try {
    const { privateJwk, publicKeyRawB64 } = JSON.parse(raw);
    const privateKey = await crypto.subtle.importKey(
      "jwk",
      privateJwk,
      { name: "Ed25519" },
      true,
      ["sign"]
    );
    const publicKeyRaw = base64ToBytes(publicKeyRawB64);
    const publicKey = await crypto.subtle.importKey(
      "raw",
      publicKeyRaw,
      { name: "Ed25519" },
      true,
      ["verify"]
    );
    return { privateKey, publicKey, publicKeyRaw };
  } catch (err) {
    console.error("Stored device key was invalid, generating a new one:", err);
    return generateDeviceKeyPair();
  }
};

const signPayloadLocally = async (payload) => {
  const bytes = new TextEncoder().encode(canonicalJson(payload));
  const sigBuf = await crypto.subtle.sign({ name: "Ed25519" }, deviceKeyPair.privateKey, bytes);
  return bytesToBase64Url(new Uint8Array(sigBuf));
};

const verifyPacketLocally = async (packet) => {
  try {
    const bytes = new TextEncoder().encode(canonicalJson(packet.payload));
    const sigBytes = base64UrlToBytes(packet.signature);
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      deviceKeyPair.publicKey,
      sigBytes,
      bytes
    );
  } catch {
    return false;
  }
};

const sha256Hex = async (value) => {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

const encodePacket = (packet) => `OPG1.${toBase64UrlString(canonicalJson(packet))}`;
const decodePacket = (armored) => {
  if (!armored.startsWith("OPG1.")) throw new Error("Unsupported packet format");
  return JSON.parse(fromBase64UrlString(armored.slice(5)));
};

/* ---------------------------------------------------------------
   SECTION 2: Local wallet / ledger state (localStorage)
   --------------------------------------------------------------- */

const defaultLocalState = () => ({
  balancePaise: 0,
  pendingCustomerDebits: [], // rows for the "Local Sub-Wallet Ledger" table
  pendingMerchantLedger: [], // rows for the "Pending Sync Ledger" table
  seenNonces: []
});

const loadLocalState = () => {
  const raw = localStorage.getItem(LOCAL_WALLET_STORAGE);
  if (!raw) return defaultLocalState();
  try {
    return { ...defaultLocalState(), ...JSON.parse(raw) };
  } catch {
    return defaultLocalState();
  }
};

const saveLocalState = (state) => localStorage.setItem(LOCAL_WALLET_STORAGE, JSON.stringify(state));

// Called after every successful /api/state refresh, so local balance
// stays anchored to the server's last known truth (e.g. after preload
// or after a sync clears pending items).
const syncLocalBalanceFromServer = (serverBalancePaise) => {
  const state = loadLocalState();
  state.balancePaise = serverBalancePaise;
  saveLocalState(state);
};

/* ---------------------------------------------------------------
   SECTION 3: Original DOM wiring (kept the same shape as before)
   --------------------------------------------------------------- */

const elements = {
  walletBalance: document.querySelector("#walletBalance"),
  offlineLimit: document.querySelector("#offlineLimit"),
  pendingCount: document.querySelector("#pendingCount"),
  razorpayPill: document.querySelector("#razorpayPill"),
  aiPill: document.querySelector("#aiPill"),
  networkPill: document.querySelector("#networkPill"),
  networkBtn: document.querySelector("#networkBtn"),
  refreshBtn: document.querySelector("#refreshBtn"),
  resetBtn: document.querySelector("#resetBtn"),
  preloadAmount: document.querySelector("#preloadAmount"),
  preloadBtn: document.querySelector("#preloadBtn"),
  payAmount: document.querySelector("#payAmount"),
  merchantId: document.querySelector("#merchantId"),
  generateBtn: document.querySelector("#generateBtn"),
  packetBox: document.querySelector("#packetBox"),
  acceptBtn: document.querySelector("#acceptBtn"),
  tamperBtn: document.querySelector("#tamperBtn"),
  syncBtn: document.querySelector("#syncBtn"),
  packetHash: document.querySelector("#packetHash"),
  customerLedger: document.querySelector("#customerLedger"),
  merchantLedger: document.querySelector("#merchantLedger"),
  riskBox: document.querySelector("#riskBox"),
  toast: document.querySelector("#toast")
};

let appConfig = null;
let appState = null;
let isOnline = true;
let keyRegistered = false;

const money = (paise) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0
  }).format(paise / 100);

const api = async (path, options = {}) => {
  const response = await fetch(path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "Request failed");
  return body;
};

const postJson = (path, body = {}) =>
  api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

const toast = (message, type = "info") => {
  elements.toast.textContent = message;
  elements.toast.className = `toast ${type}`;
  window.setTimeout(() => {
    elements.toast.className = "toast hidden";
  }, 4300);
};

const setBusy = (button, busy, label) => {
  button.disabled = busy;
  button.textContent = busy ? "Working..." : label;
};

const loadRazorpayCheckout = () =>
  new Promise((resolve) => {
    if (window.Razorpay) {
      resolve(true);
      return;
    }
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.body.appendChild(script);
  });

const formatTime = (value) => {
  if (!value) return "";
  return new Intl.DateTimeFormat("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
};

const row = (cells, colspan) => {
  const tr = document.createElement("tr");
  cells.forEach((cell) => {
    const td = document.createElement("td");
    if (typeof cell === "object") {
      td.appendChild(cell);
    } else {
      td.textContent = String(cell);
    }
    if (colspan) td.colSpan = colspan;
    tr.appendChild(td);
  });
  return tr;
};

const badge = (text) => {
  const span = document.createElement("span");
  span.className = "tableBadge";
  span.textContent = text;
  return span;
};

// Combines server-confirmed rows (appState) with locally pending,
// not-yet-synced rows (local storage) so both tables show the full
// picture even while offline.
const renderLedgers = () => {
  const local = loadLocalState();
  elements.customerLedger.innerHTML = "";
  elements.merchantLedger.innerHTML = "";

  const customerRows = [...local.pendingCustomerDebits, ...(appState.customerLedger || [])];
  if (!customerRows.length) {
    elements.customerLedger.appendChild(row(["No local wallet entries yet."], 4));
  } else {
    customerRows.forEach((entry) => {
      elements.customerLedger.appendChild(
        row([
          String(entry.txn_id).slice(0, 18),
          entry.direction,
          badge(entry.status),
          money(Number(entry.amount_paise))
        ])
      );
    });
  }

  const merchantRows = [...local.pendingMerchantLedger, ...(appState.merchantTransactions || [])];
  if (!merchantRows.length) {
    elements.merchantLedger.appendChild(row(["No merchant packets accepted yet."], 5));
  } else {
    merchantRows.forEach((entry) => {
      elements.merchantLedger.appendChild(
        row([
          String(entry.txn_id).slice(0, 18),
          entry.merchant_id,
          badge(entry.status),
          money(Number(entry.amount_paise)),
          formatTime(entry.created_at)
        ])
      );
    });
  }

  const pendingLocalCount = local.pendingMerchantLedger.length;
  const pendingServerCount = (appState.merchantTransactions || []).filter(
    (txn) => txn.status === "PENDING_SYNC"
  ).length;
  elements.pendingCount.textContent = String(pendingLocalCount + pendingServerCount);
};

const refresh = async () => {
  const [config, state] = await Promise.all([api("/api/config"), api("/api/state")]);
  appConfig = config;
  appState = state;

  // Anchor local balance to the server's confirmed balance, then
  // subtract anything still queued locally that the server hasn't
  // seen yet (i.e. generated offline but not yet synced).
  const local = loadLocalState();
  const stillPendingDebit = local.pendingCustomerDebits.reduce(
    (sum, entry) => sum + Number(entry.amount_paise || 0),
    0
  );
  syncLocalBalanceFromServer(state.wallet.balancePaise - stillPendingDebit);

  elements.walletBalance.textContent = money(loadLocalState().balancePaise);
  elements.offlineLimit.textContent = money(config.offlineTxnLimitPaise);
  elements.razorpayPill.textContent = config.hasRazorpayKeys ? "Razorpay ready" : "Razorpay demo";
  elements.razorpayPill.classList.toggle("pillActive", config.hasRazorpayKeys);
  elements.aiPill.textContent = config.hasGeminiKey ? "AI Gemini" : "AI heuristic";
  elements.aiPill.classList.toggle("pillActive", config.hasGeminiKey);
  elements.preloadBtn.textContent = config.hasRazorpayKeys ? "Open Razorpay Checkout" : "Simulate Test Preload";
  renderLedgers();

  if (!keyRegistered) {
    try {
      const pem = publicKeyRawToSpkiPem(deviceKeyPair.publicKeyRaw);
      await postJson("/api/wallet/register-key", { publicKeyPem: pem });
      keyRegistered = true;
    } catch (err) {
      // Non-fatal: if this fails (e.g. genuinely offline on first load),
      // it will just retry on the next refresh().
      console.warn("Device key registration will retry on next refresh:", err);
    }
  }
};

const setNetwork = () => {
  isOnline = !isOnline;
  elements.networkPill.textContent = isOnline ? "Online mode" : "Offline mode";
  elements.networkBtn.textContent = isOnline ? "Go Offline" : "Go Online";
  elements.networkPill.classList.toggle("pillActive", isOnline);
};

const handlePreload = async () => {
  setBusy(elements.preloadBtn, true, "");
  try {
    const amountRupees = Number(elements.preloadAmount.value);
    const created = await postJson("/api/preload/create", { amountRupees });

    if (created.mode === "simulated" || !appConfig.hasRazorpayKeys) {
      await postJson("/api/preload/confirm", { orderId: created.order.id, simulated: true });
      toast(`Simulated preload settled: ${money(created.order.amount)}`, "success");
      await refresh();
      return;
    }

    const loaded = await loadRazorpayCheckout();
    if (!loaded || !window.Razorpay) throw new Error("Could not load Razorpay Checkout.");

    const checkout = new window.Razorpay({
      key: appConfig.razorpayKeyId,
      amount: created.order.amount,
      currency: "INR",
      name: "OfflinePay Guard",
      description: "Buildathon sub-wallet preload",
      order_id: created.order.id,
      theme: { color: "#176B5B" },
      handler: async (response) => {
        await postJson("/api/preload/confirm", {
          orderId: response.razorpay_order_id,
          paymentId: response.razorpay_payment_id,
          signature: response.razorpay_signature
        });
        toast("Razorpay Test Mode preload verified and credited.", "success");
        await refresh();
      }
    });
    checkout.open();
  } catch (error) {
    toast(error.message, "error");
  } finally {
    setBusy(
      elements.preloadBtn,
      false,
      appConfig && appConfig.hasRazorpayKeys ? "Open Razorpay Checkout" : "Simulate Test Preload"
    );
  }
};

/* ---------------------------------------------------------------
   SECTION 4: Act 2 — fully offline generate / accept / tamper
   --------------------------------------------------------------- */

const handleGenerate = async () => {
  setBusy(elements.generateBtn, true, "");
  try {
    if (!deviceKeyPair) throw new Error("Device key not ready yet, try again in a moment.");

    const amountPaise = Math.round(Number(elements.payAmount.value) * 100);
    const merchantId = elements.merchantId.value.toUpperCase();
    const local = loadLocalState();

    if (!amountPaise || amountPaise <= 0) throw new Error("Enter a valid amount.");
    if (amountPaise > appConfig.offlineTxnLimitPaise) {
      throw new Error(`Exceeds ₹${appConfig.offlineTxnLimitPaise / 100} offline limit.`);
    }
    if (amountPaise > local.balancePaise) {
      throw new Error("Insufficient offline sub-wallet balance.");
    }

    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + 10 * 60 * 1000);
    const nonce = crypto.randomUUID();

    const payload = {
      type: "OFFLINE_IOU",
      version: 1,
      userId: appState.wallet.userId,
      merchantId,
      amountPaise,
      currency: "INR",
      nonce,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      previousBalancePaise: local.balancePaise,
      keyId: appState.wallet.keyId
    };

    const signature = await signPayloadLocally(payload);
    const packet = { payload, signature, algorithm: "Ed25519" };
    const armored = encodePacket(packet);
    const packetHash = await sha256Hex(armored);

    local.balancePaise -= amountPaise;
    local.pendingCustomerDebits.push({
      txn_id: nonce,
      amount_paise: amountPaise,
      direction: "DEBIT",
      status: "OFFLINE_ISSUED"
    });
    saveLocalState(local);

    elements.packetBox.value = armored;
    elements.packetHash.textContent = `Packet hash ${packetHash.slice(0, 32)}...`;
    elements.walletBalance.textContent = money(local.balancePaise);
    toast("Offline signed payment packet generated — no network used.", "success");
    renderLedgers();
  } catch (error) {
    toast(error.message, "error");
  } finally {
    setBusy(elements.generateBtn, false, "Generate Signed Packet");
  }
};

const handleAccept = async () => {
  setBusy(elements.acceptBtn, true, "");
  try {
    const armored = elements.packetBox.value.trim();
    if (!armored) throw new Error("No packet to accept.");

    const merchantId = elements.merchantId.value.toUpperCase();
    let packet;
    try {
      packet = decodePacket(armored);
    } catch {
      throw new Error("Malformed offline packet.");
    }

    const payload = packet.payload;
    if (payload.type !== "OFFLINE_IOU" || payload.currency !== "INR") {
      throw new Error("Unsupported payment payload.");
    }
    if (payload.amountPaise > appConfig.offlineTxnLimitPaise) {
      throw new Error("Exceeds offline transaction limit.");
    }
    if (payload.merchantId !== merchantId) {
      throw new Error("Merchant mismatch. Packet is not payable to this merchant.");
    }
    if (Date.parse(payload.expiresAt) < Date.now()) {
      throw new Error("Expired offline packet.");
    }

    const local = loadLocalState();
    if (local.seenNonces.includes(payload.nonce)) {
      throw new Error("Duplicate transaction. Replay attack blocked.");
    }

    const validSignature = await verifyPacketLocally(packet);
    if (!validSignature) {
      throw new Error("Data tampered. Signature validation failed.");
    }

    local.seenNonces.push(payload.nonce);
    local.pendingMerchantLedger.push({
      txn_id: payload.nonce,
      merchant_id: payload.merchantId,
      amount_paise: payload.amountPaise,
      status: "PENDING_SYNC",
      created_at: new Date().toISOString(),
      packet: armored
    });
    saveLocalState(local);

    toast("Merchant verified signature locally and queued for sync.", "success");
    renderLedgers();
  } catch (error) {
    toast(error.message, "error");
  } finally {
    setBusy(elements.acceptBtn, false, "Merchant Accept");
  }
};

const handleTamper = () => {
  const packet = elements.packetBox.value;
  if (!packet) return;
  const index = Math.max(8, packet.length - 8);
  elements.packetBox.value = `${packet.slice(0, index)}A${packet.slice(index + 1)}`;
  toast("Packet changed. Accepting it should now fail signature validation.", "info");
};

/* ---------------------------------------------------------------
   SECTION 5: Act 3 — reconciliation (the one step that needs network)
   --------------------------------------------------------------- */

const renderRisk = (report) => {
  elements.riskBox.classList.remove("hidden");
  elements.riskBox.innerHTML = "";

  const scoreLine = document.createElement("div");
  const label = document.createElement("span");
  const score = document.createElement("strong");
  label.textContent = "AI Risk Score";
  score.textContent = `${report.score}/100`;
  scoreLine.append(label, score);

  const summary = document.createElement("p");
  summary.textContent = report.summary;
  elements.riskBox.append(scoreLine, summary);

  report.findings.slice(0, 3).forEach((finding) => {
    const small = document.createElement("small");
    small.textContent = finding;
    elements.riskBox.appendChild(small);
  });
};

const handleSync = async () => {
  setBusy(elements.syncBtn, true, "");
  try {
    const local = loadLocalState();
    const packets = local.pendingMerchantLedger.map((entry) => ({
      txnId: entry.txn_id,
      armored: entry.packet
    }));

    const result = await postJson("/api/sync/merchant", { packets });
    renderRisk(result.riskReport);

    // Clear what the server confirmed as synced or rejected — both
    // outcomes are now recorded server-side, so drop the local copies
    // (server's ledger, pulled in by refresh(), becomes the source of truth).
    local.pendingMerchantLedger = [];
    local.pendingCustomerDebits = [];
    local.seenNonces = [];
    saveLocalState(local);

    toast(`${result.synced} transaction(s) synced in ${result.batchId}.`, "success");
    await refresh();
  } catch (error) {
    toast(error.message, "error");
  } finally {
    setBusy(elements.syncBtn, false, "Sync Pending Ledger");
  }
};

/* ---------------------------------------------------------------
   SECTION 6: Wiring + boot
   --------------------------------------------------------------- */

elements.networkBtn.addEventListener("click", setNetwork);
elements.refreshBtn.addEventListener("click", () => refresh().catch((error) => toast(error.message, "error")));
elements.preloadBtn.addEventListener("click", handlePreload);
elements.generateBtn.addEventListener("click", handleGenerate);
elements.acceptBtn.addEventListener("click", handleAccept);
elements.tamperBtn.addEventListener("click", handleTamper);
elements.syncBtn.addEventListener("click", handleSync);
elements.resetBtn.addEventListener("click", async () => {
  await api("/api/demo/reset", { method: "POST" });
  localStorage.removeItem(LOCAL_WALLET_STORAGE);
  elements.packetBox.value = "";
  elements.packetHash.textContent = "Packet hash appears after generation.";
  elements.riskBox.className = "riskBox hidden";
  toast("Demo state reset.", "info");
  await refresh();
});

(async () => {
  try {
    deviceKeyPair = await loadDeviceKeyPair();
  } catch (err) {
    console.error("Ed25519 key setup failed — this browser may not support Web Crypto Ed25519.", err);
    toast("This browser doesn't support the crypto needed for offline signing. Try a recent Chrome/Edge/Firefox/Safari.", "error");
  }
  refresh().catch((error) => toast(error.message, "error"));
})();
