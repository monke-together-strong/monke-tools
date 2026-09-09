import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";

import { isPnpmBootstrapDeletion, pnpmBootstrapManifestSchema } from "./cleanup-pnpm-bootstrap.ts";
import type { Runtime } from "./types.ts";

interface Entry {
  mode: string;
  oid: string;
}
interface PendingPath {
  disk: Entry | null;
  head: Entry | null;
  index: Entry | null;
  path: string;
}
export interface PendingWork {
  fingerprint: string;
  paths: PendingPath[];
}
export interface PendingWorkProof {
  fingerprint: string;
  kind: "forward-bundle" | "pnpm-bootstrap";
  paths: string[];
  witness: string | null;
}
const oid = /^[\da-f]{40}$/u;
const MAX_PENDING_FILE_BYTES = 32 * 1024 * 1024;
const MAX_PENDING_PATHS = 1000;

function gitBlobOid(bytes: Uint8Array) {
  return new Bun.CryptoHasher("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

function git(runtime: Runtime, cwd: string, args: string[]) {
  const result = runtime.exec("git", ["-c", "core.fileMode=true", ...args], { cwd }).stdout;
  // Runtime decodes UTF-8: reject replacement characters rather than conflate path bytes.
  if (result.includes("\uFFFD")) {
    throw new Error("Unsupported Git path encoding");
  }
  return result;
}
function tree(runtime: Runtime, cwd: string, ref: string, paths: string[] = []) {
  const entries = new Map<string, Entry>();
  for (const line of git(runtime, cwd, [
    "--literal-pathspecs",
    "ls-tree",
    "-r",
    "-z",
    ref,
    "--",
    ...paths
  ]).split("\0")) {
    if (!line) {
      continue;
    }
    const tab = line.indexOf("\t");
    const [mode, , object] = line.slice(0, tab).split(" ");
    if (!mode || !object || !oid.test(object) || tab === -1) {
      throw new Error("Invalid tree");
    }
    entries.set(line.slice(tab + 1), { mode, oid: object });
  }
  return entries;
}
function diskEntry(root: string, name: string): Entry | null {
  const resolvedRoot = path.resolve(root);
  if (
    path.isAbsolute(name) ||
    name.split("/").some((p) => !p || p === "." || p === ".." || p.toLowerCase() === ".git")
  ) {
    throw new Error("Unsafe path");
  }
  const full = path.join(resolvedRoot, name);
  let parent = path.dirname(full);
  while (parent !== resolvedRoot) {
    try {
      if (!lstatSync(parent).isDirectory()) {
        throw new Error("Non-directory parent");
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
    parent = path.dirname(parent);
  }
  let stat;
  try {
    stat = lstatSync(full);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  if ((!stat.isFile() && !stat.isSymbolicLink()) || stat.size > MAX_PENDING_FILE_BYTES) {
    throw new Error("Unsupported pending file");
  }
  const bytes = stat.isSymbolicLink()
    ? readlinkSync(full, { encoding: "buffer" })
    : readFileSync(full);
  return {
    // Git records executable permissions as a mode bit.
    // oxlint-disable-next-line eslint/no-bitwise
    mode: stat.isSymbolicLink() ? "120000" : (stat.mode & 0o111) !== 0 ? "100755" : "100644",
    oid: gitBlobOid(bytes)
  };
}
function equal(a: Entry | null, b: Entry | null) {
  return a?.mode === b?.mode && a?.oid === b?.oid;
}

function parseIndex(rawIndex: string): Map<string, Entry> | null {
  const index = new Map<string, Entry>();
  for (const line of rawIndex.split("\0")) {
    if (!line) {
      continue;
    }
    const tab = line.indexOf("\t");
    const [mode, object, stage] = line.slice(0, tab).split(" ");
    if (
      tab === -1 ||
      !mode ||
      !object ||
      !oid.test(object) ||
      /^0+$/u.test(object) ||
      stage !== "0"
    ) {
      return null;
    }
    index.set(line.slice(tab + 1), { mode, oid: object });
  }
  return index;
}

/** Complete dirty set, every index entry and raw pending disk bytes; unsupported states fail closed. */
export function inspectPendingWork(
  runtime: Runtime,
  root: string,
  head: string
): PendingWork | null {
  if (!oid.test(head)) {
    return null;
  }
  try {
    const status = git(runtime, root, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=none"
    ]);
    const rawIndex = git(runtime, root, ["ls-files", "--stage", "-z"]);
    const flags = git(runtime, root, ["ls-files", "-v", "-z"]);
    if (flags.split("\0").some((line) => line.length > 0 && !line.startsWith("H"))) {
      return null;
    }
    const index = parseIndex(rawIndex);
    if (!index) {
      return null;
    }
    const names = new Set<string>();
    const tokens = status.split("\0");
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (!token) {
        continue;
      }
      const code = token.slice(0, 2);
      if (code === " A" || !/^[ MADRC?]{2}$/u.test(code) || token[2] !== " ") {
        return null;
      }
      names.add(token.slice(3));
      if (/[RC]/u.test(code)) {
        i += 1;
        const from = tokens[i];
        if (!from) {
          return null;
        }
        names.add(from);
      }
    }
    if (names.size > MAX_PENDING_PATHS) {
      return null;
    }
    const committed = tree(runtime, root, head);
    const paths = [...names].toSorted().map((name) => ({
      disk: diskEntry(root, name),
      head: committed.get(name) ?? null,
      index: index.get(name) ?? null,
      path: name
    }));
    if (
      paths.some(
        (p) =>
          p.head?.mode === "160000" ||
          p.index?.mode === "160000" ||
          (!equal(p.index, p.head) && !equal(p.index, p.disk))
      )
    ) {
      return null;
    }
    return {
      fingerprint: new Bun.CryptoHasher("sha256")
        .update(JSON.stringify([head, status, rawIndex, flags, paths]))
        .digest("hex"),
      paths
    };
  } catch {
    return null;
  }
}

/** No package-manager invocation, fetch, or Git object writes. */
export function provePendingWork(
  runtime: Runtime,
  source: string,
  root: string,
  head: string,
  defaultHead: string,
  pending: PendingWork
): PendingWorkProof | false | null {
  if (!oid.test(head) || !oid.test(defaultHead)) {
    return null;
  }
  try {
    const [only] = pending.paths;
    if (
      pending.paths.length === 1 &&
      only?.path === "pnpm-lock.yaml" &&
      only.head?.mode === "100644" &&
      only.disk?.mode === "100644"
    ) {
      const before = git(runtime, source, ["show", `${head}:pnpm-lock.yaml`]);
      const bytes = readFileSync(path.join(root, "pnpm-lock.yaml"));
      const digest = gitBlobOid(bytes);
      if (digest !== only.disk.oid) {
        return null;
      }
      const after = bytes.toString("utf-8");
      const manifest = pnpmBootstrapManifestSchema.safeParse(
        JSON.parse(git(runtime, source, ["show", `${head}:package.json`]))
      );
      if (manifest.success && isPnpmBootstrapDeletion(before, after, manifest.data)) {
        return {
          fingerprint: pending.fingerprint,
          kind: "pnpm-bootstrap",
          paths: pending.paths.map((p) => p.path),
          witness: null
        };
      }
    }
    if (git(runtime, source, ["rev-parse", "--is-shallow-repository"]).trim() !== "false") {
      return null;
    }
    const ancestry = runtime.exec("git", ["merge-base", "--is-ancestor", head, defaultHead], {
      allowFailure: true,
      cwd: source
    });
    if (ancestry.exitCode !== 0) {
      return ancestry.exitCode === 1 ? false : null;
    }
    const witnesses = git(runtime, source, [
      "rev-list",
      "--ancestry-path",
      `${head}..${defaultHead}`
    ])
      .trim()
      .split("\n")
      .filter(Boolean);
    const pendingPaths = pending.paths.map((entry) => entry.path);
    for (const witness of witnesses) {
      const entries = tree(runtime, source, witness, pendingPaths);
      if (
        pending.paths.length > 0 &&
        pending.paths.every((p) => equal(p.disk, entries.get(p.path) ?? null))
      ) {
        return {
          fingerprint: pending.fingerprint,
          kind: "forward-bundle",
          paths: pending.paths.map((p) => p.path),
          witness
        };
      }
    }
    return false;
  } catch {
    return null;
  }
}

/**
 * Match the complete tree against reachable default history, never a loose blob or normalized
 * patch.
 */
export function inspectDefaultTree(
  runtime: Runtime,
  source: string,
  head: string,
  defaultHead: string
): { tree: string; witness: string } | false | null {
  if (!oid.test(head) || !oid.test(defaultHead)) {
    return null;
  }
  try {
    if (git(runtime, source, ["rev-parse", "--is-shallow-repository"]).trim() !== "false") {
      return null;
    }
    const target = git(runtime, source, ["rev-parse", `${head}^{tree}`]).trim();
    if (!oid.test(target)) {
      return null;
    }
    for (const line of git(runtime, source, ["log", "--format=%H %T", defaultHead]).split("\n")) {
      const [commit, treeId] = line.split(" ");
      if (treeId === target && commit && oid.test(commit)) {
        return { tree: target, witness: commit };
      }
    }
    return false;
  } catch {
    return null;
  }
}
