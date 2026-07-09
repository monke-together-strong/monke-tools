import { readFileSync } from "node:fs";

function trimWhitespace(value: string): string {
  return value.trim();
}

function unwrapQuotedValue(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];

    if ((first === `"` && last === `"`) || (first === `'` && last === `'`)) {
      return value.slice(1, -1);
    }
  }

  return value;
}

export function loadEnvFileIfPresent(filePath: string): void {
  let content: string;

  try {
    content = readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }

    throw error;
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const trimmed = trimWhitespace(rawLine);

    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }

    const [rawKey, ...valueParts] = trimmed.split("=");
    const normalizedKey = trimWhitespace(rawKey.replace(/^export\s+/, ""));

    if (!normalizedKey || process.env[normalizedKey] !== undefined) {
      continue;
    }

    const rawValue = valueParts.join("=");
    process.env[normalizedKey] = unwrapQuotedValue(trimWhitespace(rawValue));
  }
}

export function getFirstEnvValue(names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];

    if (value) {
      return value;
    }
  }

  return undefined;
}
