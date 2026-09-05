import { readFileSync } from "node:fs";

function unwrapQuotedValue(value: string) {
  if (value.length >= 2) {
    const [first] = value;
    const last = value.at(-1);

    if ((first === `"` && last === `"`) || (first === `'` && last === `'`)) {
      return value.slice(1, -1);
    }
  }

  return value;
}

export function loadEnvFileIfPresent(filePath: string) {
  let content: string;

  try {
    content = readFileSync(filePath, "utf-8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }

    throw error;
  }

  for (const rawLine of content.split(/\r?\n/u)) {
    const trimmed = rawLine.trim();

    if (trimmed === "" || trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    const rawKey = trimmed.slice(0, separatorIndex);
    const normalizedKey = rawKey.replace(/^export\s+/u, "").trim();

    if (normalizedKey === "" || process.env[normalizedKey] !== undefined) {
      continue;
    }

    const rawValue = trimmed.slice(separatorIndex + 1);
    process.env[normalizedKey] = unwrapQuotedValue(rawValue.trim());
  }
}

export function getFirstEnvValue(names: string[]) {
  return names
    .map((name) => process.env[name])
    .find((value) => value !== undefined && value !== "");
}
