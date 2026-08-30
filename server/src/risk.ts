import { config, hasGeminiKey } from "./config.js";

export type RiskInput = {
  batchId: string;
  transactions: Array<{
    txnId: string;
    userId: string;
    merchantId: string;
    amountPaise: number;
    status: string;
    createdAt: string;
  }>;
  rejectedSignals: string[];
};

export type RiskReport = {
  score: number;
  summary: string;
  findings: string[];
  model: string;
};

const localHeuristicReport = (input: RiskInput): RiskReport => {
  const total = input.transactions.reduce((sum, txn) => sum + txn.amountPaise, 0);
  const highValueCount = input.transactions.filter((txn) => txn.amountPaise >= 40000).length;
  const score = Math.min(95, input.rejectedSignals.length * 25 + highValueCount * 10);

  const findings = [
    `${input.transactions.length} pending transaction(s), total ₹${(total / 100).toFixed(2)}.`,
    highValueCount > 0
      ? `${highValueCount} transaction(s) are near the offline limit.`
      : "No transaction is near the offline limit.",
    input.rejectedSignals.length > 0
      ? `Rejected signals observed: ${input.rejectedSignals.join(", ")}.`
      : "No replay or tamper rejection was observed in this batch."
  ];

  return {
    score,
    summary:
      score >= 60
        ? "Review recommended before settlement because the batch contains suspicious signals."
        : "Batch appears low risk under deterministic offline-payment checks.",
    findings,
    model: "local-heuristic-fallback"
  };
};

export const analyzeRisk = async (input: RiskInput): Promise<RiskReport> => {
  if (!hasGeminiKey) {
    return localHeuristicReport(input);
  }

  const prompt = `You are a payment risk analyst for a buildathon prototype. Return only JSON with keys score, summary, findings. Score 0-100. Analyze this offline payment sync batch:\n${JSON.stringify(
    input,
    null,
    2
  )}`;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${config.geminiModel}:generateContent`,
      {
        method: "POST",
        headers: {
          "x-goog-api-key": config.geminiApiKey,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.2,
            responseMimeType: "application/json"
          }
        })
      }
    );

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "<no body>");
      console.error(
        `Gemini API error (model=${config.geminiModel}): ${response.status} ${response.statusText} — ${errorBody}`
      );
      return {
        ...localHeuristicReport(input),
        summary: `Gemini was configured but unavailable (HTTP ${response.status}); fallback heuristic risk report was used.`
      };
    }

    const data = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";

    try {
      const parsed = JSON.parse(text) as Partial<RiskReport>;
      return {
        score: Number(parsed.score ?? 0),
        summary: String(parsed.summary ?? "Gemini returned a risk report."),
        findings: Array.isArray(parsed.findings) ? parsed.findings.map(String) : [],
        model: config.geminiModel
      };
    } catch {
      console.error(`Gemini returned non-JSON text (model=${config.geminiModel}): ${text.slice(0, 300)}`);
      return {
        ...localHeuristicReport(input),
        summary: "Gemini returned non-JSON text; fallback heuristic risk report was used."
      };
    }
  } catch (networkError) {
    // Covers DNS failures, timeouts, egress being blocked, etc. — anything
    // that throws before we even get an HTTP response. Without this, a
    // network-level failure here would propagate up as an unhandled error
    // and break the whole /api/sync/merchant request instead of degrading
    // gracefully to the heuristic report like every other failure mode does.
    const message = networkError instanceof Error ? networkError.message : String(networkError);
    console.error(`Gemini request failed before a response was received (model=${config.geminiModel}): ${message}`);
    return {
      ...localHeuristicReport(input),
      summary: "Gemini was configured but unreachable; fallback heuristic risk report was used."
    };
  }
};
