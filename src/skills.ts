import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import * as z from "zod";

import { errorMessage, MonkeError } from "./errors.ts";
import { loadGlobalMonkeConfig, saveGlobalMonkeConfig } from "./global-config.ts";
import { createLogger } from "./logger.ts";
import { getHomeDirectory, getMonkeHome } from "./runtime.ts";
import { parseBoundaryValue } from "./validation.ts";
import type {
  BuiltInSkillInstallTargetKind,
  SkillInstallPreference,
  SkillInstallTargetKind,
  SkillInstallTargetPreference,
} from "./global-config.ts";
import type { Runtime } from "./types.ts";

/** Directory name monke-tools owns inside each selected Agent skill root. */
const SKILL_NAMESPACE = "monke-tools";
const FLAT_SKILL_MANIFEST = ".monke-tools-flat-skills.json";

const BUILT_IN_TARGET_ROOTS: Record<BuiltInSkillInstallTargetKind, string> = {
  claude: path.join(".claude", "skills"),
  codex: path.join(".codex", "skills"),
  cursor: path.join(".cursor", "skills"),
};
type SkillInstallLayout = "namespace" | "flat";
// Flip Claude back to "namespace" to restore the original symlink layout.
const CLAUDE_SKILL_INSTALL_LAYOUT: SkillInstallLayout = "flat";
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
            homeDirectory: options.homeDirectory,
            input: target.path,
          })
        : path.join(options.homeDirectory, BUILT_IN_TARGET_ROOTS[target.kind]);

    return {
      agentSkillRoot,
      kind: target.kind,
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
    homeDirectory,
    nextPreference,
    previousPreference,
    sourceCheckout,
    writeMessage(message) {
      runtime.writeStderr(message);
    },
  });
  createLogger(runtime).success("Configured monke-tools skills");
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
    homeDirectory,
    nextPreference: config.skillInstallPreference,
    previousPreference: config.skillInstallPreference,
    sourceCheckout: installedSourceCheckout,
    writeMessage(message) {
      runtime.writeStderr(message);
    },
  });
  createLogger(runtime).success("Refreshed monke-tools skills");
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
          homeDirectory: options.homeDirectory,
          preference: options.previousPreference,
        });
  const nextTargets = resolveSkillInstallTargets({
    homeDirectory: options.homeDirectory,
    preference: options.nextPreference,
  });
  const nextKeys = new Set(nextTargets.map(targetKey));
  const failures: string[] = [];

  for (const previousTarget of previousTargets) {
    if (nextKeys.has(targetKey(previousTarget))) {
      continue;
    }

    try {
      removeManagedTarget(previousTarget);
    } catch (error) {
      const message = errorMessage(error);
      failures.push(`${previousTarget.agentSkillRoot}: ${message}`);
    }
  }

  for (const target of nextTargets) {
    try {
      reconcileOneTarget(target, skillSourceTree);
      options.writeMessage(`Linked ${SKILL_NAMESPACE} skills at ${managedLocation(target)}\n`);
    } catch (error) {
      const message = errorMessage(error);
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
function normalizeCustomSkillRoot(options: { input: string; homeDirectory: string }): string {
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
        homeDirectory,
        previousPath: previousCustomPath,
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
    homeDirectory: options.homeDirectory,
    input: options.answer,
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
    .split(/[\s,]+/u)
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
  if (skillInstallLayoutForTarget(target) === "flat") {
    reconcileFlatTarget(target, skillSourceTree);
    return;
  }

  reconcileNamespaceTarget(target, skillSourceTree);
}

function reconcileNamespaceTarget(
  target: ResolvedSkillInstallTarget,
  skillSourceTree: string,
): void {
  mkdirSync(target.agentSkillRoot, { recursive: true });
  if (target.kind === "claude") {
    removeFlatManagedLinks(target);
  }

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

function reconcileFlatTarget(target: ResolvedSkillInstallTarget, skillSourceTree: string): void {
  mkdirSync(target.agentSkillRoot, { recursive: true });
  removeManagedNamespace(target.namespacePath);

  const links = discoverFlatSkillLinks(skillSourceTree);
  const supportingLinks = discoverFlatSupportingLinks(target, skillSourceTree);
  const previousManifest = readFlatManifest(target);
  assertFlatLinksCanBeManaged(target, links, previousManifest);
  assertFlatSupportingLinksCanBeManaged(supportingLinks, previousManifest);

  removeFlatManagedLinks(target);

  const createdLinks: FlatSkillLink[] = [];
  const createdSupportingLinks: FlatSupportingLink[] = [];
  try {
    for (const link of supportingLinks) {
      mkdirSync(path.dirname(link.targetPath), { recursive: true });
      if (lstatIfExists(link.targetPath)) {
        rmSync(link.targetPath);
      }
      symlinkSync(link.sourcePath, link.targetPath, "dir");
      createdSupportingLinks.push(link);
    }
    for (const link of links) {
      const linkPath = path.join(target.agentSkillRoot, link.name);
      if (lstatIfExists(linkPath)) {
        rmSync(linkPath);
      }
      symlinkSync(link.sourcePath, linkPath, "dir");
      createdLinks.push(link);
    }
  } catch (error) {
    writeFlatManifest(target, createdLinks, createdSupportingLinks);
    throw error;
  }

  writeFlatManifest(target, links, supportingLinks);
}

function removeManagedTarget(target: ResolvedSkillInstallTarget): void {
  if (target.kind === "claude") {
    removeFlatManagedLinks(target);
  }
  removeManagedNamespace(target.namespacePath);
}

function removeManagedNamespace(namespacePath: string): void {
  const namespaceStat = lstatIfExists(namespacePath);
  if (!namespaceStat?.isSymbolicLink()) {
    return;
  }

  rmSync(namespacePath);
}

const FlatSkillLinkSchema = z.strictObject({
  name: z.string().min(1),
  sourcePath: z.string().min(1),
});
const FlatSkillManifestSchema = z.strictObject({
  links: z.array(FlatSkillLinkSchema),
  managedBy: z.literal("monke-tools"),
  supportingLinks: z
    .array(
      z.strictObject({
        sourcePath: z.string().min(1),
        targetPath: z.string().min(1),
      }),
    )
    .optional(),
  version: z.literal(1),
});

type FlatSkillLink = z.output<typeof FlatSkillLinkSchema>;
type FlatSupportingLink = NonNullable<
  z.output<typeof FlatSkillManifestSchema>["supportingLinks"]
>[number];
type FlatSkillManifest = z.output<typeof FlatSkillManifestSchema>;

function discoverFlatSkillLinks(skillSourceTree: string): FlatSkillLink[] {
  const links = new Map<string, FlatSkillLink>();

  for (const categoryName of ["internal", "imported"]) {
    const categoryPath = path.join(skillSourceTree, categoryName);
    if (!existsSync(categoryPath)) {
      continue;
    }

    for (const entry of readdirSync(categoryPath, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) {
        continue;
      }

      const sourcePath = path.join(categoryPath, entry.name);
      if (!existsSync(path.join(sourcePath, "SKILL.md"))) {
        continue;
      }
      if (links.has(entry.name)) {
        throw new MonkeError(
          `Cannot flatten duplicate Skill name ${entry.name} from ${skillSourceTree}`,
        );
      }

      links.set(entry.name, { name: entry.name, sourcePath });
    }
  }

  return [...links.values()].toSorted((left, right) => left.name.localeCompare(right.name));
}

function discoverFlatSupportingLinks(
  target: ResolvedSkillInstallTarget,
  skillSourceTree: string,
): FlatSupportingLink[] {
  const referenceSourceTree = path.join(skillSourceTree, "references");
  if (!existsSync(referenceSourceTree)) {
    return [];
  }

  return [
    {
      sourcePath: referenceSourceTree,
      targetPath: path.resolve(target.agentSkillRoot, "..", "references"),
    },
  ];
}

function assertFlatLinksCanBeManaged(
  target: ResolvedSkillInstallTarget,
  links: FlatSkillLink[],
  previousManifest: FlatSkillManifest | null,
): void {
  const previousLinks = new Map(
    previousManifest?.links.map((link) => [link.name, link.sourcePath]) ?? [],
  );

  for (const link of links) {
    const linkPath = path.join(target.agentSkillRoot, link.name);
    const linkStat = lstatIfExists(linkPath);
    if (!linkStat) {
      continue;
    }
    if (!linkStat.isSymbolicLink()) {
      throw new MonkeError(`Refusing to overwrite non-managed Skill at ${linkPath}`);
    }

    const currentTarget = readlinkSync(linkPath);
    if (currentTarget !== link.sourcePath && currentTarget !== previousLinks.get(link.name)) {
      throw new MonkeError(`Refusing to overwrite non-managed Skill at ${linkPath}`);
    }
  }
}

function assertFlatSupportingLinksCanBeManaged(
  links: FlatSupportingLink[],
  previousManifest: FlatSkillManifest | null,
): void {
  const previousLinks = new Map(
    previousManifest?.supportingLinks?.map((link) => [link.targetPath, link.sourcePath]) ?? [],
  );

  for (const link of links) {
    const linkStat = lstatIfExists(link.targetPath);
    if (!linkStat) {
      continue;
    }
    if (!linkStat.isSymbolicLink()) {
      throw new MonkeError(
        `Refusing to overwrite non-managed Reference source tree link at ${link.targetPath}`,
      );
    }

    const currentTarget = readlinkSync(link.targetPath);
    if (currentTarget !== link.sourcePath && currentTarget !== previousLinks.get(link.targetPath)) {
      throw new MonkeError(
        `Refusing to overwrite non-managed Reference source tree link at ${link.targetPath}`,
      );
    }
  }
}

function removeFlatManagedLinks(target: ResolvedSkillInstallTarget): void {
  const manifest = readFlatManifest(target);
  if (!manifest) {
    return;
  }

  for (const link of manifest.links) {
    const linkPath = path.join(target.agentSkillRoot, link.name);
    const linkStat = lstatIfExists(linkPath);
    if (!linkStat?.isSymbolicLink()) {
      continue;
    }
    if (readlinkSync(linkPath) === link.sourcePath) {
      rmSync(linkPath);
    }
  }
  for (const link of manifest.supportingLinks ?? []) {
    const linkStat = lstatIfExists(link.targetPath);
    if (linkStat?.isSymbolicLink() && readlinkSync(link.targetPath) === link.sourcePath) {
      rmSync(link.targetPath);
    }
  }

  rmSync(flatManifestPath(target), { force: true });
}

function readFlatManifest(target: ResolvedSkillInstallTarget): FlatSkillManifest | null {
  const manifestPath = flatManifestPath(target);
  if (!existsSync(manifestPath)) {
    return null;
  }

  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch {
    throw new MonkeError(`Invalid monke-tools flat Skill manifest at ${manifestPath}`);
  }

  return parseBoundaryValue(
    FlatSkillManifestSchema,
    rawManifest,
    `monke-tools flat Skill manifest at ${manifestPath}`,
  );
}

function writeFlatManifest(
  target: ResolvedSkillInstallTarget,
  links: FlatSkillLink[],
  supportingLinks: FlatSupportingLink[],
): void {
  const manifest: FlatSkillManifest = {
    links,
    managedBy: "monke-tools",
    version: 1,
    ...(supportingLinks.length > 0 ? { supportingLinks } : {}),
  };
  const manifestPath = flatManifestPath(target);
  const parsed = FlatSkillManifestSchema.parse(manifest);

  writeFileSync(`${manifestPath}.tmp`, `${JSON.stringify(parsed, null, 2)}\n`);
  renameSync(`${manifestPath}.tmp`, manifestPath);
}

function flatManifestPath(target: ResolvedSkillInstallTarget): string {
  return path.join(target.agentSkillRoot, FLAT_SKILL_MANIFEST);
}

function skillInstallLayoutForTarget(target: ResolvedSkillInstallTarget): SkillInstallLayout {
  if (target.kind === "claude") {
    return CLAUDE_SKILL_INSTALL_LAYOUT;
  }

  return "namespace";
}

function managedLocation(target: ResolvedSkillInstallTarget): string {
  if (skillInstallLayoutForTarget(target) === "flat") {
    return target.agentSkillRoot;
  }

  return target.namespacePath;
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
