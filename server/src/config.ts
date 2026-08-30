import dotenv from "dotenv";

dotenv.config({ path: "../.env" });
dotenv.config();

const numberFromEnv = (name: string, fallback: number) => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const config = {
  port: numberFromEnv("PORT", 8787),
  clientOrigin: process.env.CLIENT_ORIGIN ?? "http://localhost:5173",
  razorpayKeyId: process.env.RAZORPAY_KEY_ID ?? "",
  razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET ?? "",
  geminiApiKey: process.env.GEMINI_API_KEY ?? "",
  geminiModel: process.env.GEMINI_MODEL ?? "gemini-3.6-flash",
  offlineTxnLimitPaise: numberFromEnv("OFFLINE_TXN_LIMIT_PAISE", 50000),
  offlineWalletCapPaise: numberFromEnv("OFFLINE_WALLET_CAP_PAISE", 200000),
  allowSimulatedPreload: (process.env.DEMO_ALLOW_SIMULATED_PRELOAD ?? "true") === "true"
};

export const hasRazorpayKeys =
  config.razorpayKeyId.startsWith("rzp_test_") && config.razorpayKeySecret.length > 8;

export const hasGeminiKey = config.geminiApiKey.length > 12;
