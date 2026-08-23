import {
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

import { MonkeError } from "./errors.ts";
import { samePath } from "./path-identity.ts";
import type { AssignedPort, RepoConfig } from "./types.ts";

/** Options for collecting baseline ports from a concrete repo-content root. */
export interface CollectBaselinePortsFromRootOptions {
  /** Parsed repo config whose app env files are inspected. */
  config: RepoConfig;
  /** Source content root to read app env files from. */
  sourceRoot: string;
}

/** Seed local env files and configured seed paths from the source checkout. */
export function seedWorktreeFiles(
  config: RepoConfig,
  worktreeRoot: string,
  onWarning?: (message: string) => void
) {
  const seededPaths = new Set<string>();

  for (const relativePath of listEnvFiles(config.sourceRoot)) {
    seedRelativePath(config.sourceRoot, worktreeRoot, relativePath, false, seededPaths, onWarning);
  }

  for (const relativePath of config.seedPaths) {
    seedRelativePath(config.sourceRoot, worktreeRoot, relativePath, true, seededPaths, onWarning);
  }
}

/** Collect content-root ports that local session allocations should avoid. */
export function collectBaselinePortsFromRoot(options: CollectBaselinePortsFromRootOptions) {
  const ports = new Set<number>();

  for (const app of options.config.appsInOrder) {
    if (app.localMappings.length === 0) {
      continue;
    }

    const envPath = path.join(
      options.sourceRoot,
      path.relative(options.config.sourceRoot, app.absoluteAppPath),
      app.relativeEnvFile
    );
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
  externalAssignments: AssignedPort[]
) {
  const externalValuesByKey = new Map(
    externalAssignments.map((assignment) => [assignment.key, assignment.value])
  );
  const externalByApp = new Map<string, { env: string; value: number }[]>();
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
        value: requireAssignedPort(localAssignments, mapping.portKey, app.label)
      })),
      ...(externalByApp.get(app.label) ?? [])
    ];

    if (requests.length === 0) {
      continue;
    }

    const envPath = path.join(
      worktreeRoot,
      path.relative(config.sourceRoot, app.absoluteAppPath),
      app.relativeEnvFile
    );

    if (!existsSync(envPath)) {
      throw new MonkeError(`Expected managed env file to exist at ${envPath}`);
    }

    rewriteEnvFile(envPath, new Map(requests.map((request) => [request.env, request.value])));
  }
}

export function syncRootEnvFile(
  worktreeRoot: string,
  assignments: { env: string; value: string }[]
) {
  syncRootEnvFileWithRemovals(worktreeRoot, assignments, []);
}

/** Synchronize assignments in the supplied checkout's root `.env` and remove stale names. */
export function syncRootEnvFileWithRemovals(
  worktreeRoot: string,
  assignments: { env: string; value: string }[],
  removedEnvNames: string[]
) {
  if (assignments.length === 0 && removedEnvNames.length === 0) {
    return;
  }

  const envPath = path.join(worktreeRoot, ".env");
  if (!existsSync(envPath) && assignments.length === 0) {
    return;
  }

  const requests = new Map(assignments.map((assignment) => [assignment.env, assignment.value]));
  const removals = new Set(removedEnvNames.filter((env) => !requests.has(env)));
  const original = existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";
  const lines = original ? stripTrailingNewline(original).split("\n") : [];
  const touched = new Set<string>();
  const rewritten: string[] = [];

  for (const line of lines) {
    const parsed = parseAssignmentLine(line);
    if (!parsed) {
      rewritten.push(line);
      continue;
    }

    const nextValue = requests.get(parsed.key);
    if (nextValue !== undefined) {
      touched.add(parsed.key);
      rewritten.push(`${parsed.prefix}${nextValue}${parsed.comment}`);
      continue;
    }

    if (!removals.has(parsed.key)) {
      rewritten.push(line);
    }
  }

  for (const [env, value] of requests) {
    if (!touched.has(env)) {
      rewritten.push(`${env}=${value}`);
    }
  }

  writeFileSync(envPath, rewritten.length > 0 ? `${rewritten.join("\n")}\n` : "", "utf-8");
}

export function rewriteEnvFile(filePath: string, requests: Map<string, number>) {
  const original = readFileSync(filePath, "utf-8");
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

  writeFileSync(filePath, rewritten.join("\n"), "utf-8");
}

function listEnvFiles(root: string, relativeRoot = "") {
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

    if (entry.isFile() && isEnvSeedFile(entry.name)) {
      results.push(nextRelativePath);
    }
  }

  return results;
}

function isEnvSeedFile(fileName: string) {
  return fileName === ".env" || fileName.startsWith(".env.");
}

function seedRelativePath(
  sourceRoot: string,
  worktreeRoot: string,
  relativePath: string,
  warnIfMissing: boolean,
  seededPaths: Set<string>,
  onWarning?: (message: string) => void
) {
  const normalizedRelativePath = path.normalize(relativePath);
  if (seededPaths.has(normalizedRelativePath)) {
    return;
  }
  seededPaths.add(normalizedRelativePath);

  const sourcePath = path.join(sourceRoot, normalizedRelativePath);
  if (!existsSync(sourcePath)) {
    if (warnIfMissing) {
      onWarning?.(
        `Warning: seedPath ${normalizedRelativePath} is missing at ${sourcePath}; skipping`
      );
    }
    return;
  }

  const targetPath = path.join(worktreeRoot, normalizedRelativePath);
  const sourceIsDirectory = statSync(sourcePath).isDirectory();
  if (samePath(sourcePath, targetPath)) {
    return;
  }

  if (existsSync(targetPath)) {
    if (sourceIsDirectory) {
      cpSync(sourcePath, targetPath, {
        errorOnExist: false,
        force: false,
        recursive: true
      });
    }
    return;
  }

  mkdirSync(path.dirname(targetPath), { recursive: true });
  if (sourceIsDirectory) {
    cpSync(sourcePath, targetPath, {
      errorOnExist: false,
      force: false,
      recursive: true
    });
    return;
  }

  copyFileSync(sourcePath, targetPath);
}

function readActiveAssignments(filePath: string) {
  const values = new Map<string, string[]>();
  for (const line of readFileSync(filePath, "utf-8").split("\n")) {
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

function parseAssignmentLine(line: string) {
  if (!line.trim() || /^\s*#/u.test(line)) {
    return null;
  }

  const match =
    /^(?<prefixStart>\s*(?:export\s+)?)(?<key>[A-Za-z_][A-Za-z0-9_]*)(?<separator>\s*=\s*)(?<remainder>.*)$/u.exec(
      line
    );
  if (!match?.groups) {
    return null;
  }

  const { key = "", prefixStart = "", remainder = "", separator = "=" } = match.groups;
  const { comment, value } = splitValueAndComment(remainder);
  return {
    comment,
    key,
    prefix: `${prefixStart}${key}${separator}`,
    rawValue: value
  };
}

function stripTrailingNewline(text: string) {
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

function splitValueAndComment(value: string) {
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if ((char === "'" || char === '"') && (quote === null || quote === char)) {
      quote = quote === char ? null : char;
      continue;
    }

    if (char === "#" && quote === null) {
      const previous = index === 0 ? "" : value[index - 1];
      if (!previous || /\s/u.test(previous)) {
        return {
          comment: value.slice(index),
          value: value.slice(0, index)
        };
      }
    }
  }

  return { comment: "", value };
}

function describeRedactedValue(value: string) {
  return `<redacted length=${value.length}>`;
}

function replacePortInValue(rawValue: string, newPort: number, location: string) {
  const leadingWhitespace = /^\s*/u.exec(rawValue)?.[0] ?? "";
  const trailingWhitespace = /\s*$/u.exec(rawValue)?.[0] ?? "";
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
  if (/^\d+$/u.test(innerValue)) {
    nextInnerValue = String(newPort);
  } else if (innerValue.includes("://")) {
    nextInnerValue = replaceUrlPort(innerValue, newPort, location);
  } else {
    throw new MonkeError(
      `Unsupported env value at ${location}: ${describeRedactedValue(innerValue)}`
    );
  }

  const nextCore = quote ? `${quote}${nextInnerValue}${quote}` : nextInnerValue;
  return `${leadingWhitespace}${nextCore}${trailingWhitespace}`;
}

function replaceUrlPort(value: string, newPort: number, location: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new MonkeError(`Malformed URL or DSN at ${location}: ${describeRedactedValue(value)}`);
  }

  if (!parsed.port) {
    throw new MonkeError(`Expected explicit port at ${location}: ${describeRedactedValue(value)}`);
  }

  const schemeIndex = value.indexOf("://");
  const authorityStart = schemeIndex + 3;
  const authorityEndCandidates = [
    value.indexOf("/", authorityStart),
    value.indexOf("?", authorityStart),
    value.indexOf("#", authorityStart)
  ].filter((index) => index >= 0);
  const authorityEnd =
    authorityEndCandidates.length > 0 ? Math.min(...authorityEndCandidates) : value.length;
  const authority = value.slice(authorityStart, authorityEnd);
  const lastAt = authority.lastIndexOf("@");
  const hostPort = lastAt === -1 ? authority : authority.slice(lastAt + 1);

  let portStartInHostPort = -1;
  let currentPort = "";
  if (hostPort.startsWith("[")) {
    const bracketIndex = hostPort.indexOf("]");
    if (bracketIndex === -1 || hostPort[bracketIndex + 1] !== ":") {
      throw new MonkeError(
        `Expected explicit port at ${location}: ${describeRedactedValue(value)}`
      );
    }
    portStartInHostPort = bracketIndex + 2;
  } else {
    const colonIndex = hostPort.lastIndexOf(":");
    if (colonIndex === -1) {
      throw new MonkeError(
        `Expected explicit port at ${location}: ${describeRedactedValue(value)}`
      );
    }
    portStartInHostPort = colonIndex + 1;
  }
  currentPort = hostPort.slice(portStartInHostPort);

  if (!/^\d+$/u.test(currentPort)) {
    throw new MonkeError(`Malformed explicit port at ${location}: ${describeRedactedValue(value)}`);
  }

  const absolutePortStart = authorityStart + (lastAt === -1 ? 0 : lastAt + 1) + portStartInHostPort;
  const absolutePortEnd = absolutePortStart + currentPort.length;
  return `${value.slice(0, absolutePortStart)}${newPort}${value.slice(absolutePortEnd)}`;
}

function extractPort(rawValue: string, location: string) {
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
  if (/^\d+$/u.test(unwrapped)) {
    return Number(unwrapped);
  }

  if (!unwrapped.includes("://")) {
    throw new MonkeError(
      `Unsupported env value at ${location}: ${describeRedactedValue(unwrapped)}`
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(unwrapped);
  } catch {
    throw new MonkeError(
      `Malformed URL or DSN at ${location}: ${describeRedactedValue(unwrapped)}`
    );
  }

  if (!parsed.port) {
    throw new MonkeError(
      `Expected explicit port at ${location}: ${describeRedactedValue(unwrapped)}`
    );
  }

  return Number(parsed.port);
}

function requireAssignedPort(assignments: Map<string, number>, key: string, appLabel: string) {
  const value = assignments.get(key);
  if (value === undefined) {
    throw new MonkeError(`Missing assigned local port ${key} for ${appLabel}`);
  }
  return value;
}
