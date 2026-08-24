import crypto from "node:crypto";
import { canonicalJson, fromBase64Url, toBase64Url } from "./canonical.js";

export type OfflinePayload = {
  type: "OFFLINE_IOU";
  version: 1;
  userId: string;
  merchantId: string;
  amountPaise: number;
  currency: "INR";
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  previousBalancePaise: number;
  keyId: string;
};

export type OfflinePacket = {
  payload: OfflinePayload;
  signature: string;
  algorithm: "Ed25519";
};

export const generateDeviceKeyPair = () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  };
};

export const signPayload = (payload: OfflinePayload, privateKeyPem: string): OfflinePacket => {
  const bytes = Buffer.from(canonicalJson(payload));
  const signature = crypto.sign(null, bytes, privateKeyPem).toString("base64url");
  return { payload, signature, algorithm: "Ed25519" };
};

export const verifyPacket = (packet: OfflinePacket, publicKeyPem: string) => {
  const bytes = Buffer.from(canonicalJson(packet.payload));
  return crypto.verify(null, bytes, publicKeyPem, Buffer.from(packet.signature, "base64url"));
};

export const encodePacket = (packet: OfflinePacket) => `OPG1.${toBase64Url(canonicalJson(packet))}`;

export const decodePacket = (armored: string): OfflinePacket => {
  if (!armored.startsWith("OPG1.")) {
    throw new Error("Unsupported packet format");
  }
  return JSON.parse(fromBase64Url(armored.slice(5))) as OfflinePacket;
};

export const sha256Hex = (value: string) =>
  crypto.createHash("sha256").update(value).digest("hex");

export const timingSafeEqualText = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};
