export const canonicalJson = (input: unknown): string => {
  if (input === null || typeof input !== "object") {
    return JSON.stringify(input);
  }

  if (Array.isArray(input)) {
    return `[${input.map((item) => canonicalJson(item)).join(",")}]`;
  }

  const objectInput = input as Record<string, unknown>;
  return `{${Object.keys(objectInput)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(objectInput[key])}`)
    .join(",")}}`;
};

export const toBase64Url = (value: string | Buffer) =>
  Buffer.from(value).toString("base64url");

export const fromBase64Url = (value: string) =>
  Buffer.from(value, "base64url").toString("utf8");
