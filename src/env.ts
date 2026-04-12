import {
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { MonkeError } from "./errors.ts";
import type { AssignedPort, RepoConfig } from "./types.ts";

export function seedWorktreeFiles(
  config: RepoConfig,
  worktreeRoot: string,
  onWarning?: (message: string) => void,
): void {
  const seededPaths = new Set<string>();

  for (const relativePath of listEnvFiles(config.sourceRoot)) {
    seedRelativePath(config.sourceRoot, worktreeRoot, relativePath, false, seededPaths, onWarning);
  }

  for (const relativePath of config.seedPaths) {
    seedRelativePath(config.sourceRoot, worktreeRoot, relativePath, true, seededPaths, onWarning);
  }
}

export function collectBaselinePorts(config: RepoConfig): Set<number> {
  const ports = new Set<number>();

  for (const app of config.appsInOrder) {
    if (app.localMappings.length === 0) {
      continue;
    }

    const envPath = path.join(app.absoluteAppPath, app.relativeEnvFile);
    if (!existsSync(envPath)) {
      continue;
    }

    const values = readActiveAssignments(envPath);
    for (const mapping of app.localMappings) {
      for (const rawValue of values.get(mapping.targetEnv) ?? []) {
        ports.add(extractPort(rawValue, `${envPath}:${mapping.targetEnv}`));
      }
    }
  }

  return ports;
}

export function rewriteManagedEnvFiles(
  config: RepoConfig,
  worktreeRoot: string,
  localAssignments: Map<string, number>,
  externalAssignments: AssignedPort[],
): void {
  const externalValuesByKey = new Map(
    externalAssignments.map((assignment) => [assignment.key, assignment.value]),
  );
  const externalByApp = new Map<string, Array<{ env: string; value: number }>>();
  for (const mapping of config.externalMappingsInOrder) {
    const value = externalValuesByKey.get(mapping.portKey);
    if (value === undefined) {
      continue;
    }
    const targetEntries = externalByApp.get(mapping.targetApp) ?? [];
    targetEntries.push({ env: mapping.targetEnv, value });
    externalByApp.set(mapping.targetApp, targetEntries);
  }

  for (const app of config.appsInOrder) {
    const requests = [
      ...app.localMappings.map((mapping) => ({
        env: mapping.targetEnv,
        value: requireAssignedPort(localAssignments, mapping.portKey, app.label),
      })),
      ...(externalByApp.get(app.label) ?? []),
    ];

    if (requests.length === 0) {
      continue;
    }

    const envPath = path.join(
      worktreeRoot,
      path.relative(config.sourceRoot, app.absoluteAppPath),
      app.relativeEnvFile,
    );

    if (!existsSync(envPath)) {
      throw new MonkeError(`Expected managed env file to exist at ${envPath}`);
    }

    rewriteEnvFile(envPath, new Map(requests.map((request) => [request.env, request.value])));
  }
}

export function syncRootEnvFile(
  worktreeRoot: string,
  assignments: Array<{ env: string; value: string }>,
): void {
  if (assignments.length === 0) {
    return;
  }

  const envPath = path.join(worktreeRoot, ".env");
  const requests = new Map(assignments.map((assignment) => [assignment.env, assignment.value]));
  const original = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const lines = original ? stripTrailingNewline(original).split("\n") : [];
  const touched = new Set<string>();

  const rewritten = lines.map((line) => {
    const parsed = parseAssignmentLine(line);
    if (!parsed) {
      return line;
    }

    const nextValue = requests.get(parsed.key);
    if (nextValue === undefined) {
      return line;
    }

    touched.add(parsed.key);
    return `${parsed.prefix}${nextValue}${parsed.comment}`;
  });

  for (const [env, value] of requests) {
    if (!touched.has(env)) {
      rewritten.push(`${env}=${value}`);
    }
  }

  writeFileSync(envPath, `${rewritten.join("\n")}\n`, "utf8");
}

export function rewriteEnvFile(filePath: string, requests: Map<string, number>): void {
  const original = readFileSync(filePath, "utf8");
  const lines = original.split("\n");
  const touched = new Set<string>();

  const rewritten = lines.map((line) => {
    const parsed = parseAssignmentLine(line);
    if (!parsed) {
      return line;
    }

    const newPort = requests.get(parsed.key);
    if (newPort === undefined) {
      return line;
    }

    touched.add(parsed.key);
    const nextValue = replacePortInValue(parsed.rawValue, newPort, `${filePath}:${parsed.key}`);
    return `${parsed.prefix}${nextValue}${parsed.comment}`;
  });

  const missing = [...requests.keys()].filter((key) => !touched.has(key));
  if (missing.length > 0) {
    throw new MonkeError(`Missing mapped env vars in ${filePath}: ${missing.join(", ")}`);
  }

  writeFileSync(filePath, rewritten.join("\n"), "utf8");
}

function listEnvFiles(root: string, relativeRoot: string = ""): string[] {
  const absoluteRoot = path.join(root, relativeRoot);
  const results: string[] = [];

  for (const entry of readdirSync(absoluteRoot, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".monke") {
      continue;
    }

    const nextRelativePath = path.join(relativeRoot, entry.name);
    if (entry.isDirectory()) {
      results.push(...listEnvFiles(root, nextRelativePath));
      continue;
    }

    if (entry.isFile() && entry.name.startsWith(".env")) {
      results.push(nextRelativePath);
    }
  }

  return results;
}

function seedRelativePath(
  sourceRoot: string,
  worktreeRoot: string,
  relativePath: string,
  warnIfMissing: boolean,
  seededPaths: Set<string>,
  onWarning?: (message: string) => void,
): void {
  const normalizedRelativePath = path.normalize(relativePath);
  if (seededPaths.has(normalizedRelativePath)) {
    return;
  }
  seededPaths.add(normalizedRelativePath);

  const sourcePath = path.join(sourceRoot, normalizedRelativePath);
  if (!existsSync(sourcePath)) {
    if (warnIfMissing) {
      onWarning?.(`Warning: seedPath ${normalizedRelativePath} is missing at ${sourcePath}; skipping`);
    }
    return;
  }

  const targetPath = path.join(worktreeRoot, normalizedRelativePath);
  if (existsSync(targetPath)) {
    return;
  }

  mkdirSync(path.dirname(targetPath), { recursive: true });
  if (statSync(sourcePath).isDirectory()) {
    cpSync(sourcePath, targetPath, { recursive: true });
    return;
  }

  copyFileSync(sourcePath, targetPath);
}

function readActiveAssignments(filePath: string): Map<string, string[]> {
  const values = new Map<string, string[]>();
  for (const line of readFileSync(filePath, "utf8").split("\n")) {
    const parsed = parseAssignmentLine(line);
    if (!parsed) {
      continue;
    }
    const next = values.get(parsed.key) ?? [];
    next.push(parsed.rawValue);
    values.set(parsed.key, next);
  }
  return values;
}

interface ParsedAssignmentLine {
  key: string;
  prefix: string;
  rawValue: string;
  comment: string;
}

function parseAssignmentLine(line: string): ParsedAssignmentLine | null {
  if (!line.trim() || /^\s*#/.test(line)) {
    return null;
  }

  const match = line.match(/^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/);
  if (!match) {
    return null;
  }

  const prefixStart = match[1] ?? "";
  const key = match[2] ?? "";
  const separator = match[3] ?? "=";
  const remainder = match[4] ?? "";
  const { value, comment } = splitValueAndComment(remainder);
  return {
    key,
    prefix: `${prefixStart}${key}${separator}`,
    rawValue: value,
    comment,
  };
}

function stripTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

function splitValueAndComment(value: string): { value: string; comment: string } {
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if ((char === "'" || char === '"') && (quote === null || quote === char)) {
      quote = quote === char ? null : char;
      continue;
    }

    if (char === "#" && quote === null) {
      const previous = index === 0 ? "" : value[index - 1];
      if (!previous || /\s/.test(previous)) {
        return {
          value: value.slice(0, index),
          comment: value.slice(index),
        };
      }
    }
  }

  return { value, comment: "" };
}

function replacePortInValue(rawValue: string, newPort: number, location: string): string {
  const leadingWhitespace = rawValue.match(/^\s*/)?.[0] ?? "";
  const trailingWhitespace = rawValue.match(/\s*$/)?.[0] ?? "";
  const trimmed = rawValue.trim();
  if (!trimmed) {
    throw new MonkeError(`Empty env value at ${location}`);
  }

  const quote =
    trimmed.startsWith('"') && trimmed.endsWith('"')
      ? '"'
      : trimmed.startsWith("'") && trimmed.endsWith("'")
        ? "'"
        : null;
  const innerValue = quote ? trimmed.slice(1, -1) : trimmed;
  if (!innerValue) {
    throw new MonkeError(`Empty env value at ${location}`);
  }

  let nextInnerValue: string;
  if (/^\d+$/.test(innerValue)) {
    nextInnerValue = String(newPort);
  } else if (innerValue.includes("://")) {
    nextInnerValue = replaceUrlPort(innerValue, newPort, location);
  } else {
    throw new MonkeError(`Unsupported env value at ${location}: ${innerValue}`);
  }

  const nextCore = quote ? `${quote}${nextInnerValue}${quote}` : nextInnerValue;
  return `${leadingWhitespace}${nextCore}${trailingWhitespace}`;
}

function replaceUrlPort(value: string, newPort: number, location: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new MonkeError(`Malformed URL or DSN at ${location}: ${value}`);
  }

  if (!parsed.port) {
    throw new MonkeError(`Expected explicit port at ${location}: ${value}`);
  }

  const schemeIndex = value.indexOf("://");
  const authorityStart = schemeIndex + 3;
  const authorityEndCandidates = [
    value.indexOf("/", authorityStart),
    value.indexOf("?", authorityStart),
    value.indexOf("#", authorityStart),
  ].filter((index) => index >= 0);
  const authorityEnd =
    authorityEndCandidates.length > 0 ? Math.min(...authorityEndCandidates) : value.length;
  const authority = value.slice(authorityStart, authorityEnd);
  const lastAt = authority.lastIndexOf("@");
  const hostPort = lastAt >= 0 ? authority.slice(lastAt + 1) : authority;

  let portStartInHostPort = -1;
  let currentPort = "";
  if (hostPort.startsWith("[")) {
    const bracketIndex = hostPort.indexOf("]");
    if (bracketIndex < 0 || hostPort[bracketIndex + 1] !== ":") {
      throw new MonkeError(`Expected explicit port at ${location}: ${value}`);
    }
    portStartInHostPort = bracketIndex + 2;
    currentPort = hostPort.slice(portStartInHostPort);
  } else {
    const colonIndex = hostPort.lastIndexOf(":");
    if (colonIndex < 0) {
      throw new MonkeError(`Expected explicit port at ${location}: ${value}`);
    }
    portStartInHostPort = colonIndex + 1;
    currentPort = hostPort.slice(portStartInHostPort);
  }

  if (!/^\d+$/.test(currentPort)) {
    throw new MonkeError(`Malformed explicit port at ${location}: ${value}`);
  }

  const absolutePortStart = authorityStart + (lastAt >= 0 ? lastAt + 1 : 0) + portStartInHostPort;
  const absolutePortEnd = absolutePortStart + currentPort.length;
  return `${value.slice(0, absolutePortStart)}${newPort}${value.slice(absolutePortEnd)}`;
}

function extractPort(rawValue: string, location: string): number {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    throw new MonkeError(`Empty env value at ${location}`);
  }

  const unwrapped =
    trimmed.startsWith('"') && trimmed.endsWith('"')
      ? trimmed.slice(1, -1)
      : trimmed.startsWith("'") && trimmed.endsWith("'")
        ? trimmed.slice(1, -1)
        : trimmed;
  if (/^\d+$/.test(unwrapped)) {
    return Number(unwrapped);
  }

  if (!unwrapped.includes("://")) {
    throw new MonkeError(`Unsupported env value at ${location}: ${unwrapped}`);
  }

  let parsed: URL;
  try {
    parsed = new URL(unwrapped);
  } catch {
    throw new MonkeError(`Malformed URL or DSN at ${location}: ${unwrapped}`);
  }

  if (!parsed.port) {
    throw new MonkeError(`Expected explicit port at ${location}: ${unwrapped}`);
  }

  return Number(parsed.port);
}

function requireAssignedPort(
  assignments: Map<string, number>,
  key: string,
  appLabel: string,
): number {
  const value = assignments.get(key);
  if (value === undefined) {
    throw new MonkeError(`Missing assigned local port ${key} for ${appLabel}`);
  }
  return value;
}
