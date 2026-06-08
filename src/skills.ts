import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";

import { MonkeError } from "./errors.ts";
import { loadGlobalMonkeConfig, saveGlobalMonkeConfig } from "./global-config.ts";
import { getHomeDirectory, getMonkeHome } from "./runtime.ts";
import type {
  BuiltInSkillInstallTargetKind,
  SkillInstallPreference,
  SkillInstallTargetKind,
  SkillInstallTargetPreference,
} from "./global-config.ts";
import type { Runtime } from "./types.ts";

/** Directory name monke-tools owns inside each selected Agent skill root. */
export const SKILL_NAMESPACE = "monke-tools";

const BUILT_IN_TARGET_ROOTS: Record<BuiltInSkillInstallTargetKind, string> = {
  codex: path.join(".codex", "skills"),
  claude: path.join(".claude", "skills"),
  cursor: path.join(".cursor", "skills"),
};
const TARGET_OPTIONS: { kind: SkillInstallTargetKind; label: string; selector: string }[] = [
  { kind: "codex", label: "Codex", selector: "1" },
  { kind: "claude", label: "Claude", selector: "2" },
  { kind: "cursor", label: "Cursor", selector: "3" },
  { kind: "custom", label: "Custom", selector: "4" },
];

/** A Skill install target resolved to an Agent skill root on disk. */
export interface ResolvedSkillInstallTarget {
  /** Configured target kind that produced this resolved root. */
  kind: SkillInstallTargetKind;
  /** Concrete Agent skill root directory on disk. */
  agentSkillRoot: string;
  /** Managed monke-tools namespace path inside the Agent skill root. */
  namespacePath: string;
}

/** Resolve stored Skill install target preferences into concrete Agent skill root paths. */
export function resolveSkillInstallTargets(options: {
  preference: SkillInstallPreference;
  homeDirectory: string;
}): ResolvedSkillInstallTarget[] {
  return options.preference.targets.map((target) => {
    const agentSkillRoot =
      target.kind === "custom"
        ? normalizeCustomSkillRoot({
            input: target.path,
            homeDirectory: options.homeDirectory,
          })
        : path.join(options.homeDirectory, BUILT_IN_TARGET_ROOTS[target.kind]);

    return {
      kind: target.kind,
      agentSkillRoot,
      namespacePath: path.join(agentSkillRoot, SKILL_NAMESPACE),
    };
  });
}

/** Prompt for a Skill install preference, save it, and reconcile selected Agent skill roots. */
export function runSkillsConfigure(runtime: Runtime): void {
  const monkeHome = getMonkeHome(runtime);
  const homeDirectory = getHomeDirectory(runtime);
  const config = loadGlobalMonkeConfig(monkeHome);
  const sourceCheckout = config.installedSourceCheckout;
  if (!sourceCheckout) {
    throw new MonkeError(
      "Installed source checkout is not configured; run bun run install:local from the monke-tools checkout first",
    );
  }
  resolveSkillSourceTree(sourceCheckout);

  const previousPreference = config.skillInstallPreference ?? null;
  const nextPreference = promptForSkillInstallPreference(
    runtime,
    previousPreference,
    homeDirectory,
  );
  saveGlobalMonkeConfig(monkeHome, {
    ...config,
    skillInstallPreference: nextPreference,
  });

  reconcileSkillNamespaces({
    sourceCheckout,
    previousPreference,
    nextPreference,
    homeDirectory,
    writeMessage(message) {
      runtime.writeStdout(message);
    },
  });
  runtime.writeStdout("Configured monke-tools skills\n");
}

/** Record the Installed source checkout and refresh or configure Distributed skill targets. */
export function runLocalInstallSkills(runtime: Runtime, sourceCheckout: string): void {
  const monkeHome = getMonkeHome(runtime);
  const homeDirectory = getHomeDirectory(runtime);
  const config = loadGlobalMonkeConfig(monkeHome);
  const installedSourceCheckout = path.resolve(sourceCheckout);
  const nextConfig = {
    ...config,
    installedSourceCheckout,
  };

  saveGlobalMonkeConfig(monkeHome, nextConfig);

  if (!config.skillInstallPreference) {
    runSkillsConfigure(runtime);
    return;
  }

  reconcileSkillNamespaces({
    sourceCheckout: installedSourceCheckout,
    previousPreference: config.skillInstallPreference,
    nextPreference: config.skillInstallPreference,
    homeDirectory,
    writeMessage(message) {
      runtime.writeStdout(message);
    },
  });
  runtime.writeStdout("Refreshed monke-tools skills\n");
}

/** Reconcile selected Agent skill roots with the monke-tools Skill source tree. */
export function reconcileSkillNamespaces(options: {
  sourceCheckout: string;
  previousPreference: SkillInstallPreference | null;
  nextPreference: SkillInstallPreference;
  homeDirectory: string;
  writeMessage: (message: string) => void;
}): void {
  const skillSourceTree = resolveSkillSourceTree(options.sourceCheckout);
  const previousTargets =
    options.previousPreference === null
      ? []
      : resolveSkillInstallTargets({
          preference: options.previousPreference,
          homeDirectory: options.homeDirectory,
        });
  const nextTargets = resolveSkillInstallTargets({
    preference: options.nextPreference,
    homeDirectory: options.homeDirectory,
  });
  const nextKeys = new Set(nextTargets.map(targetKey));

  for (const previousTarget of previousTargets) {
    if (nextKeys.has(targetKey(previousTarget))) {
      continue;
    }

    removeManagedNamespace(previousTarget.namespacePath);
  }

  const failures: string[] = [];
  for (const target of nextTargets) {
    try {
      reconcileOneTarget(target, skillSourceTree);
      options.writeMessage(`Linked ${SKILL_NAMESPACE} skills at ${target.namespacePath}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${target.agentSkillRoot}: ${message}`);
    }
  }

  if (failures.length > 0) {
    throw new MonkeError(
      `Failed to reconcile ${failures.length} Skill install target(s):\n${failures.join("\n")}`,
    );
  }
}

/** Normalize one custom Agent skill root path for storage in Global monke config. */
export function normalizeCustomSkillRoot(options: {
  input: string;
  homeDirectory: string;
}): string {
  const trimmed = options.input.trim();
  if (!trimmed) {
    throw new MonkeError("Custom Skill install target path must be a non-empty absolute path");
  }

  const expanded = expandHomeDirectory(trimmed, options.homeDirectory);
  if (!path.isAbsolute(expanded)) {
    throw new MonkeError("Custom Skill install target path must be an absolute path");
  }

  const normalized = path.resolve(expanded);
  if (path.basename(normalized) === SKILL_NAMESPACE) {
    throw new MonkeError(
      `Custom Skill install target must be an Agent skill root, not the ${SKILL_NAMESPACE} namespace path`,
    );
  }

  return normalized;
}

function promptForSkillInstallPreference(
  runtime: Runtime,
  previousPreference: SkillInstallPreference | null,
  homeDirectory: string,
): SkillInstallPreference {
  runtime.writeStdout(formatTargetPrompt(previousPreference));
  const targetAnswer = runtime.readLine("Select skill targets: ");
  const selectedKinds = parseSelectedTargetKinds(targetAnswer, previousPreference);
  const targets: SkillInstallTargetPreference[] = [];
  const previousCustom = previousPreference?.targets.find((target) => target.kind === "custom");

  for (const kind of selectedKinds) {
    if (kind !== "custom") {
      targets.push({ kind });
      continue;
    }

    const previousCustomPath = previousCustom?.path;
    const customAnswer = runtime.readLine(
      previousCustomPath
        ? `Custom Agent skill root [${previousCustomPath}]: `
        : "Custom Agent skill root: ",
    );
    targets.push({
      kind: "custom",
      path: resolveCustomSkillRootAnswer({
        answer: customAnswer,
        previousPath: previousCustomPath,
        homeDirectory,
      }),
    });
  }

  return { targets };
}

function formatTargetPrompt(previousPreference: SkillInstallPreference | null): string {
  const selectedKinds = new Set(previousPreference?.targets.map((target) => target.kind) ?? []);
  const lines = ["Skill install targets:"];

  for (const option of TARGET_OPTIONS) {
    const selected = selectedKinds.has(option.kind) ? " [selected]" : "";
    lines.push(`  ${option.selector}. ${option.label}${selected}`);
  }

  lines.push(
    previousPreference
      ? "Enter comma-separated numbers or names. Leave blank to keep selected targets."
      : "Enter comma-separated numbers or names. Select at least one target.",
  );
  return `${lines.join("\n")}\n`;
}

function resolveCustomSkillRootAnswer(options: {
  answer: string;
  previousPath: string | undefined;
  homeDirectory: string;
}): string {
  if (options.answer.trim() === "" && options.previousPath) {
    return options.previousPath;
  }

  return normalizeCustomSkillRoot({
    input: options.answer,
    homeDirectory: options.homeDirectory,
  });
}

function parseSelectedTargetKinds(
  answer: string,
  previousPreference: SkillInstallPreference | null,
): SkillInstallTargetKind[] {
  if (answer.trim() === "") {
    if (!previousPreference) {
      throw new MonkeError("Select at least one Skill install target");
    }
    return previousPreference.targets.map((target) => target.kind);
  }

  const selectedKinds: SkillInstallTargetKind[] = [];
  const selectedSet = new Set<SkillInstallTargetKind>();
  const tokens = answer
    .toLowerCase()
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter(Boolean);

  for (const token of tokens) {
    const option = TARGET_OPTIONS.find(
      (candidate) =>
        candidate.selector === token ||
        candidate.kind === token ||
        candidate.label.toLowerCase() === token,
    );
    if (!option) {
      throw new MonkeError(`Unknown Skill install target: ${token}`);
    }
    if (selectedSet.has(option.kind)) {
      continue;
    }

    selectedSet.add(option.kind);
    selectedKinds.push(option.kind);
  }

  if (selectedKinds.length === 0) {
    throw new MonkeError("Select at least one Skill install target");
  }

  return selectedKinds;
}

function resolveSkillSourceTree(sourceCheckout: string): string {
  const resolvedCheckout = path.resolve(sourceCheckout);
  if (!existsSync(resolvedCheckout)) {
    throw new MonkeError(`Installed source checkout is missing: ${resolvedCheckout}`);
  }

  const skillSourceTree = path.join(resolvedCheckout, "skills");
  if (!existsSync(skillSourceTree)) {
    throw new MonkeError(`Skill source tree is missing: ${skillSourceTree}`);
  }

  return skillSourceTree;
}

function reconcileOneTarget(target: ResolvedSkillInstallTarget, skillSourceTree: string): void {
  mkdirSync(target.agentSkillRoot, { recursive: true });

  const namespaceStat = lstatIfExists(target.namespacePath);
  if (namespaceStat && !namespaceStat.isSymbolicLink()) {
    throw new MonkeError(
      `Refusing to overwrite non-managed Skill namespace at ${target.namespacePath}`,
    );
  }

  if (namespaceStat) {
    rmSync(target.namespacePath);
  }

  symlinkSync(skillSourceTree, target.namespacePath, "dir");
}

function removeManagedNamespace(namespacePath: string): void {
  const namespaceStat = lstatIfExists(namespacePath);
  if (!namespaceStat?.isSymbolicLink()) {
    return;
  }

  rmSync(namespacePath);
}

function lstatIfExists(targetPath: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(targetPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

function targetKey(target: ResolvedSkillInstallTarget): string {
  return `${target.kind}:${target.agentSkillRoot}`;
}

function expandHomeDirectory(input: string, homeDirectory: string): string {
  if (input === "~") {
    return homeDirectory;
  }

  if (input.startsWith("~/")) {
    return path.join(homeDirectory, input.slice(2));
  }

  return input;
}
