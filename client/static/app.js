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

const renderLedgers = () => {
  elements.customerLedger.innerHTML = "";
  elements.merchantLedger.innerHTML = "";

  if (!appState.customerLedger.length) {
    elements.customerLedger.appendChild(row(["No local wallet entries yet."], 4));
  } else {
    appState.customerLedger.forEach((entry) => {
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

  if (!appState.merchantTransactions.length) {
    elements.merchantLedger.appendChild(row(["No merchant packets accepted yet."], 5));
  } else {
    appState.merchantTransactions.forEach((entry) => {
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
};

const refresh = async () => {
  const [config, state] = await Promise.all([api("/api/config"), api("/api/state")]);
  appConfig = config;
  appState = state;

  elements.walletBalance.textContent = money(state.wallet.balancePaise);
  elements.offlineLimit.textContent = money(config.offlineTxnLimitPaise);
  elements.pendingCount.textContent = String(
    state.merchantTransactions.filter((txn) => txn.status === "PENDING_SYNC").length
  );
  elements.razorpayPill.textContent = config.hasRazorpayKeys ? "Razorpay ready" : "Razorpay demo";
  elements.razorpayPill.classList.toggle("pillActive", config.hasRazorpayKeys);
  elements.aiPill.textContent = config.hasGeminiKey ? "AI Gemini" : "AI heuristic";
  elements.aiPill.classList.toggle("pillActive", config.hasGeminiKey);
  elements.preloadBtn.textContent = config.hasRazorpayKeys ? "Open Razorpay Checkout" : "Simulate Test Preload";
  renderLedgers();
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

const handleGenerate = async () => {
  setBusy(elements.generateBtn, true, "");
  try {
    const result = await postJson("/api/offline/create-payment", {
      amountRupees: Number(elements.payAmount.value),
      merchantId: elements.merchantId.value.toUpperCase()
    });
    elements.packetBox.value = result.packet;
    elements.packetHash.textContent = `Packet hash ${result.packetHash.slice(0, 32)}...`;
    toast("Offline signed payment packet generated.", "success");
    await refresh();
  } catch (error) {
    toast(error.message, "error");
  } finally {
    setBusy(elements.generateBtn, false, "Generate Signed Packet");
  }
};

const handleAccept = async () => {
  setBusy(elements.acceptBtn, true, "");
  try {
    await postJson("/api/merchant/accept", {
      packet: elements.packetBox.value,
      merchantId: elements.merchantId.value.toUpperCase()
    });
    toast("Merchant verified signature and committed PENDING_SYNC.", "success");
    await refresh();
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
    const result = await postJson("/api/sync/merchant");
    renderRisk(result.riskReport);
    toast(`${result.synced} transaction(s) synced in ${result.batchId}.`, "success");
    await refresh();
  } catch (error) {
    toast(error.message, "error");
  } finally {
    setBusy(elements.syncBtn, false, "Sync Pending Ledger");
  }
};

elements.networkBtn.addEventListener("click", setNetwork);
elements.refreshBtn.addEventListener("click", () => refresh().catch((error) => toast(error.message, "error")));
elements.preloadBtn.addEventListener("click", handlePreload);
elements.generateBtn.addEventListener("click", handleGenerate);
elements.acceptBtn.addEventListener("click", handleAccept);
elements.tamperBtn.addEventListener("click", handleTamper);
elements.syncBtn.addEventListener("click", handleSync);
elements.resetBtn.addEventListener("click", async () => {
  await api("/api/demo/reset", { method: "POST" });
  elements.packetBox.value = "";
  elements.packetHash.textContent = "Packet hash appears after generation.";
  elements.riskBox.className = "riskBox hidden";
  toast("Demo state reset.", "info");
  await refresh();
});

refresh().catch((error) => toast(error.message, "error"));
