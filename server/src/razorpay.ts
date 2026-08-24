import crypto from "node:crypto";
import { config, hasRazorpayKeys } from "./config.js";
import { timingSafeEqualText } from "./cryptoEngine.js";

export type RazorpayOrderResponse = {
  id: string;
  amount: number;
  currency: string;
  receipt: string;
  status: string;
  entity?: string;
};

export const createRazorpayOrder = async (amountPaise: number): Promise<RazorpayOrderResponse> => {
  if (!hasRazorpayKeys) {
    throw new Error("Razorpay Test Mode keys are not configured");
  }

  const receipt = `opg_${Date.now()}`.slice(0, 40);
  const auth = Buffer.from(`${config.razorpayKeyId}:${config.razorpayKeySecret}`).toString("base64");

  const response = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      amount: amountPaise,
      currency: "INR",
      receipt,
      notes: {
        product: "OfflinePay Guard",
        mode: "buildathon_test"
      }
    })
  });

  const body = (await response.json()) as RazorpayOrderResponse & { error?: { description?: string } };
  if (!response.ok) {
    throw new Error(body.error?.description ?? "Razorpay order creation failed");
  }
  return body;
};

export const verifyRazorpayPaymentSignature = ({
  orderId,
  paymentId,
  signature
}: {
  orderId: string;
  paymentId: string;
  signature: string;
}) => {
  if (!hasRazorpayKeys) return false;
  const expected = crypto
    .createHmac("sha256", config.razorpayKeySecret)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");
  return timingSafeEqualText(expected, signature);
};
