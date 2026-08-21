import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

import * as z from "zod";

import { errorMessage, MonkeError } from "./errors.ts";
import { loadGlobalMonkeConfig, saveGlobalMonkeConfig } from "./global-config.ts";
import type {
  BuiltInSkillInstallTargetKind,
  GlobalMonkeConfig,
  SkillInstallPreference,
  SkillInstallTargetKind,
  SkillInstallTargetPreference
} from "./global-config.ts";
import { reconcileGlobalInstructions, removeGlobalInstructions } from "./global-instructions.ts";
import { loadActiveLocalInstall, loadLocalInstall } from "./install-manifest.ts";
import { createLogger } from "./logger.ts";
import { getHomeDirectory, getMonkeHome, withInstallationLockAsync } from "./runtime.ts";
import type { Runtime } from "./types.ts";
import { parseBoundaryValue } from "./validation.ts";

/** Directory name monke-tools owns inside each selected Agent skill root. */
const SKILL_NAMESPACE = "monke-tools";
const FLAT_SKILL_MANIFEST = ".monke-tools-flat-skills.json";
const SHARED_SKILL_SOURCE_FOLDERS = ["internal", "imported"] as const;
const SHARED_NAMESPACE_SOURCE_FOLDERS = ["imported", "internal", "references"] as const;
const CODEX_NAMESPACE_SOURCE_FOLDERS = ["codex", ...SHARED_NAMESPACE_SOURCE_FOLDERS] as const;

const BUILT_IN_TARGET_ROOTS = {
  claude: path.join(".claude", "skills"),
  codex: path.join(".codex", "skills"),
  cursor: path.join(".cursor", "skills")
} satisfies Record<BuiltInSkillInstallTargetKind, string>;
type SkillInstallLayout = "namespace" | "flat";
// Flip Claude back to "namespace" to restore the original symlink layout.
const CLAUDE_SKILL_INSTALL_LAYOUT: SkillInstallLayout = "flat";
const SkillInstallTargetKindSchema = z.enum(["codex", "claude", "cursor", "custom"]);
const TARGET_OPTIONS: { kind: SkillInstallTargetKind; label: string }[] = [
  { kind: "codex", label: "Codex" },
  { kind: "claude", label: "Claude" },
  { kind: "cursor", label: "Cursor" },
  { kind: "custom", label: "Custom" }
];

/** A Skill install target resolved to an Agent skill root on disk. */
export interface ResolvedSkillInstallTarget {
  /** Concrete Agent skill root directory on disk. */
  agentSkillRoot: string;
  /** Configured target kind that produced this resolved root. */
  kind: SkillInstallTargetKind;
  /** Managed monke-tools namespace path inside the Agent skill root. */
  namespacePath: string;
}

/** Resolve stored Skill install target preferences into concrete Agent skill root paths. */
export function resolveSkillInstallTargets(options: {
  homeDirectory: string;
  preference: SkillInstallPreference;
}) {
  return options.preference.targets.map((target) => {
    const agentSkillRoot =
      target.kind === "custom"
        ? normalizeCustomSkillRoot({
            homeDirectory: options.homeDirectory,
            input: target.path
          })
        : path.join(options.homeDirectory, BUILT_IN_TARGET_ROOTS[target.kind]);

    return {
      agentSkillRoot,
      kind: target.kind,
      namespacePath: path.join(agentSkillRoot, SKILL_NAMESPACE)
    };
  });
}

/** Prompt for a Skill install preference, save it, and reconcile selected Agent skill roots. */
export function runSkillsConfigure(runtime: Runtime) {
  const monkeHome = getMonkeHome(runtime);
  return withInstallationLockAsync(monkeHome, () => runSkillsConfigureLocked(runtime));
}

async function runSkillsConfigureLocked(runtime: Runtime, sourceCheckoutOverride?: string) {
  const monkeHome = getMonkeHome(runtime);
  const homeDirectory = getHomeDirectory(runtime);
  const config = loadGlobalMonkeConfig(monkeHome);
  const runningInstall = loadRunningLocalInstall(runtime, monkeHome);
  const sourceCheckout = sourceCheckoutOverride ?? runningInstall?.manifest.sourceCheckout;
  if (!sourceCheckout) {
    throw new MonkeError(
      "Installed source checkout is not configured; run bun run install:local from the monke-tools checkout first"
    );
  }
  resolveSkillSourceTree(sourceCheckout);

  const previousPreference = config.skillInstallPreference ?? null;
  const nextPreference = await promptForSkillInstallPreference(
    runtime,
    previousPreference,
    homeDirectory
  );
  saveGlobalMonkeConfig(monkeHome, {
    skillInstallPreference: nextPreference,
    version: 1
  });

  reconcileSkillNamespaces({
    cwd: runtime.cwd,
    environment: runtime.env,
    homeDirectory,
    nextPreference,
    previousPreference,
    sourceCheckout,
    writeMessage(message) {
      runtime.writeStderr(message);
    }
  });
  createLogger(runtime).success("Configured monke-tools skills");
}

function loadRunningLocalInstall(runtime: Runtime, monkeHome: string) {
  const toolInstallRoot = path.resolve(runtime.toolInstallRoot);
  if (path.dirname(toolInstallRoot) === path.join(path.resolve(monkeHome), "installs")) {
    return loadLocalInstall(toolInstallRoot);
  }
  return loadActiveLocalInstall(monkeHome);
}

/** Record the Installed source checkout and refresh or configure Distributed skill targets. */
export function runLocalInstallSkills(
  runtime: Runtime,
  sourceCheckout: string,
  targetKinds?: BuiltInSkillInstallTargetKind[]
) {
  const monkeHome = getMonkeHome(runtime);
  return withInstallationLockAsync(monkeHome, () =>
    runLocalInstallSkillsLocked(runtime, sourceCheckout, targetKinds)
  );
}

/** Reconcile source-backed Local-mode guidance while the installation lock is already held. */
export async function runLocalInstallSkillsLocked(
  runtime: Runtime,
  sourceCheckout: string,
  targetKinds?: BuiltInSkillInstallTargetKind[]
) {
  const monkeHome = getMonkeHome(runtime);
  const homeDirectory = getHomeDirectory(runtime);
  const config = loadGlobalMonkeConfig(monkeHome);
  const installedSourceCheckout = path.resolve(sourceCheckout);
  const explicitPreference: SkillInstallPreference | undefined = targetKinds
    ? { targets: targetKinds.map((kind) => ({ kind })) }
    : undefined;
  const nextPreference = explicitPreference ?? config.skillInstallPreference;
  const nextConfig: GlobalMonkeConfig = { version: 1 };
  if (nextPreference) {
    nextConfig.skillInstallPreference = nextPreference;
  }

  saveGlobalMonkeConfig(monkeHome, nextConfig);

  if (!nextPreference) {
    await runSkillsConfigureLocked(runtime, installedSourceCheckout);
    return;
  }

  reconcileSkillNamespaces({
    cwd: runtime.cwd,
    environment: runtime.env,
    homeDirectory,
    nextPreference,
    previousPreference: config.skillInstallPreference ?? null,
    sourceCheckout: installedSourceCheckout,
    writeMessage(message) {
      runtime.writeStderr(message);
    }
  });
  createLogger(runtime).success(
    explicitPreference ? "Configured monke-tools skills" : "Refreshed monke-tools skills"
  );
}

/** Reconcile selected Agent skill roots with the monke-tools Skill source tree. */
export function reconcileSkillNamespaces(options: {
  cwd: string;
  environment?: Record<string, string | undefined>;
  homeDirectory: string;
  nextPreference: SkillInstallPreference;
  previousPreference: SkillInstallPreference | null;
  sourceCheckout: string;
  writeMessage: (message: string) => void;
}) {
  const skillSourceTree = resolveSkillSourceTree(options.sourceCheckout);
  const previousTargets =
    options.previousPreference === null
      ? []
      : resolveSkillInstallTargets({
          homeDirectory: options.homeDirectory,
          preference: options.previousPreference
        });
  const nextTargets = resolveSkillInstallTargets({
    homeDirectory: options.homeDirectory,
    preference: options.nextPreference
  });
  const nextKeys = new Set(nextTargets.map(targetKey));
  const failures: string[] = [];

  for (const previousTarget of previousTargets) {
    if (nextKeys.has(targetKey(previousTarget))) {
      continue;
    }

    try {
      removeManagedTarget(previousTarget, options);
    } catch (error) {
      const message = errorMessage(error);
      failures.push(`${previousTarget.agentSkillRoot}: ${message}`);
    }
  }

  for (const target of nextTargets) {
    try {
      reconcileOneTarget(target, skillSourceTree);
      reconcileGlobalInstructions(target, options);
      options.writeMessage(`Linked ${SKILL_NAMESPACE} skills at ${managedLocation(target)}\n`);
    } catch (error) {
      const message = errorMessage(error);
      failures.push(`${target.agentSkillRoot}: ${message}`);
    }
  }

  if (failures.length > 0) {
    throw new MonkeError(
      `Failed to reconcile ${failures.length} Skill install target(s):\n${failures.join("\n")}`
    );
  }
}

/** Normalize one custom Agent skill root path for storage in Global monke config. */
function normalizeCustomSkillRoot(options: { homeDirectory: string; input: string }) {
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
      `Custom Skill install target must be an Agent skill root, not the ${SKILL_NAMESPACE} namespace path`
    );
  }

  return normalized;
}

async function promptForSkillInstallPreference(
  runtime: Runtime,
  previousPreference: SkillInstallPreference | null,
  homeDirectory: string
) {
  const selectedKinds = parseBoundaryValue(
    z.array(SkillInstallTargetKindSchema),
    await runtime.multiSelect({
      initialValues: previousPreference?.targets.map((target) => target.kind) ?? [],
      message: "Skill install targets",
      options: TARGET_OPTIONS.map((option) => ({
        label: option.label,
        value: option.kind
      })),
      required: true
    }),
    "Skill install target selection"
  );
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
        : "Custom Agent skill root: "
    );
    targets.push({
      kind: "custom",
      path: resolveCustomSkillRootAnswer({
        answer: customAnswer,
        homeDirectory,
        previousPath: previousCustomPath
      })
    });
  }

  return { targets };
}

function resolveCustomSkillRootAnswer(options: {
  answer: string;
  homeDirectory: string;
  previousPath: string | undefined;
}) {
  if (options.answer.trim() === "" && options.previousPath) {
    return options.previousPath;
  }

  return normalizeCustomSkillRoot({
    homeDirectory: options.homeDirectory,
    input: options.answer
  });
}

function resolveSkillSourceTree(sourceCheckout: string) {
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

function reconcileOneTarget(target: ResolvedSkillInstallTarget, skillSourceTree: string) {
  if (skillInstallLayoutForTarget(target) === "flat") {
    reconcileFlatTarget(target, skillSourceTree);
    return;
  }

  reconcileNamespaceTarget(target, skillSourceTree);
}

function reconcileNamespaceTarget(target: ResolvedSkillInstallTarget, skillSourceTree: string) {
  mkdirSync(target.agentSkillRoot, { recursive: true });
  if (target.kind === "claude") {
    removeFlatManagedLinks(target);
  }

  const namespaceStat = lstatSync(target.namespacePath, { throwIfNoEntry: false });
  if (namespaceStat?.isSymbolicLink()) {
    rmSync(target.namespacePath);
    mkdirSync(target.namespacePath);
  } else if (namespaceStat && !namespaceStat.isDirectory()) {
    throw new MonkeError(`Refusing to overwrite Skill namespace at ${target.namespacePath}`);
  } else if (!namespaceStat) {
    mkdirSync(target.namespacePath);
  }

  const sourceFolders =
    target.kind === "codex" ? CODEX_NAMESPACE_SOURCE_FOLDERS : SHARED_NAMESPACE_SOURCE_FOLDERS;
  for (const name of sourceFolders) {
    const linkPath = path.join(target.namespacePath, name);
    const linkStat = lstatSync(linkPath, { throwIfNoEntry: false });
    if (linkStat && !linkStat.isSymbolicLink()) {
      throw new MonkeError(`Refusing to overwrite non-managed Skill folder at ${linkPath}`);
    }
  }

  for (const name of sourceFolders) {
    const sourcePath = path.join(skillSourceTree, name);
    const linkPath = path.join(target.namespacePath, name);
    if (lstatSync(linkPath, { throwIfNoEntry: false })) {
      rmSync(linkPath);
    }
    if (existsSync(sourcePath)) {
      symlinkSync(sourcePath, linkPath, "dir");
    }
  }
}

function reconcileFlatTarget(target: ResolvedSkillInstallTarget, skillSourceTree: string) {
  mkdirSync(target.agentSkillRoot, { recursive: true });
  removeManagedNamespace(target);

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
      if (lstatSync(link.targetPath, { throwIfNoEntry: false })) {
        rmSync(link.targetPath);
      }
      symlinkSync(link.sourcePath, link.targetPath, "dir");
      createdSupportingLinks.push(link);
    }
    for (const link of links) {
      const linkPath = path.join(target.agentSkillRoot, link.name);
      if (lstatSync(linkPath, { throwIfNoEntry: false })) {
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

function removeManagedTarget(
  target: ResolvedSkillInstallTarget,
  options: {
    cwd: string;
    environment?: Record<string, string | undefined>;
    homeDirectory: string;
  }
) {
  if (target.kind === "claude") {
    removeFlatManagedLinks(target);
  }
  removeManagedNamespace(target);
  removeGlobalInstructions(target, options);
}

function removeManagedNamespace(target: ResolvedSkillInstallTarget) {
  const namespaceStat = lstatSync(target.namespacePath, { throwIfNoEntry: false });
  if (!namespaceStat) {
    return;
  }
  if (namespaceStat.isSymbolicLink()) {
    rmSync(target.namespacePath);
    return;
  }
  if (!namespaceStat.isDirectory()) {
    return;
  }

  for (const name of CODEX_NAMESPACE_SOURCE_FOLDERS) {
    const linkPath = path.join(target.namespacePath, name);
    if (lstatSync(linkPath, { throwIfNoEntry: false })?.isSymbolicLink()) {
      rmSync(linkPath);
    }
  }
  if (readdirSync(target.namespacePath).length === 0) {
    rmdirSync(target.namespacePath);
  }
}

const FlatSkillLinkSchema = z.strictObject({
  name: z.string().min(1),
  sourcePath: z.string().min(1)
});
const FlatSkillManifestSchema = z.strictObject({
  links: z.array(FlatSkillLinkSchema),
  managedBy: z.literal("monke-tools"),
  supportingLinks: z
    .array(
      z.strictObject({
        sourcePath: z.string().min(1),
        targetPath: z.string().min(1)
      })
    )
    .optional(),
  version: z.literal(1)
});

type FlatSkillLink = z.output<typeof FlatSkillLinkSchema>;
type FlatSupportingLink = NonNullable<
  z.output<typeof FlatSkillManifestSchema>["supportingLinks"]
>[number];
type FlatSkillManifest = z.output<typeof FlatSkillManifestSchema>;

function discoverFlatSkillLinks(skillSourceTree: string) {
  const links = new Map<string, FlatSkillLink>();

  for (const categoryName of SHARED_SKILL_SOURCE_FOLDERS) {
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
          `Cannot flatten duplicate Skill name ${entry.name} from ${skillSourceTree}`
        );
      }

      links.set(entry.name, { name: entry.name, sourcePath });
    }
  }

  return [...links.values()].toSorted((left, right) => left.name.localeCompare(right.name));
}

function discoverFlatSupportingLinks(target: ResolvedSkillInstallTarget, skillSourceTree: string) {
  const referenceSourceTree = path.join(skillSourceTree, "references");
  if (!existsSync(referenceSourceTree)) {
    return [];
  }

  return [
    {
      sourcePath: referenceSourceTree,
      targetPath: path.resolve(target.agentSkillRoot, "..", "references")
    }
  ];
}

function assertFlatLinksCanBeManaged(
  target: ResolvedSkillInstallTarget,
  links: FlatSkillLink[],
  previousManifest: FlatSkillManifest | null
) {
  const previousLinks = new Map(
    previousManifest?.links.map((link) => [link.name, link.sourcePath])
  );

  for (const link of links) {
    const linkPath = path.join(target.agentSkillRoot, link.name);
    const linkStat = lstatSync(linkPath, { throwIfNoEntry: false });
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
  previousManifest: FlatSkillManifest | null
) {
  const previousLinks = new Map(
    previousManifest?.supportingLinks?.map((link) => [link.targetPath, link.sourcePath])
  );

  for (const link of links) {
    const linkStat = lstatSync(link.targetPath, { throwIfNoEntry: false });
    if (!linkStat) {
      continue;
    }
    if (!linkStat.isSymbolicLink()) {
      throw new MonkeError(
        `Refusing to overwrite non-managed Reference source tree link at ${link.targetPath}`
      );
    }

    const currentTarget = readlinkSync(link.targetPath);
    if (currentTarget !== link.sourcePath && currentTarget !== previousLinks.get(link.targetPath)) {
      throw new MonkeError(
        `Refusing to overwrite non-managed Reference source tree link at ${link.targetPath}`
      );
    }
  }
}

function removeFlatManagedLinks(target: ResolvedSkillInstallTarget) {
  const manifest = readFlatManifest(target);
  if (manifest === null) {
    return;
  }

  for (const link of manifest.links) {
    const linkPath = path.join(target.agentSkillRoot, link.name);
    const linkStat = lstatSync(linkPath, { throwIfNoEntry: false });
    if (linkStat?.isSymbolicLink() !== true) {
      continue;
    }
    if (readlinkSync(linkPath) === link.sourcePath) {
      rmSync(linkPath);
    }
  }
  for (const link of manifest.supportingLinks ?? []) {
    const linkStat = lstatSync(link.targetPath, { throwIfNoEntry: false });
    if (linkStat?.isSymbolicLink() === true && readlinkSync(link.targetPath) === link.sourcePath) {
      rmSync(link.targetPath);
    }
  }

  rmSync(flatManifestPath(target), { force: true });
}

function readFlatManifest(target: ResolvedSkillInstallTarget) {
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
    `monke-tools flat Skill manifest at ${manifestPath}`
  );
}

function writeFlatManifest(
  target: ResolvedSkillInstallTarget,
  links: FlatSkillLink[],
  supportingLinks: FlatSupportingLink[]
) {
  const manifest: FlatSkillManifest = {
    links,
    managedBy: "monke-tools",
    version: 1
  };
  if (supportingLinks.length > 0) {
    manifest.supportingLinks = supportingLinks;
  }
  const manifestPath = flatManifestPath(target);
  const parsed = FlatSkillManifestSchema.parse(manifest);

  writeFileSync(`${manifestPath}.tmp`, `${JSON.stringify(parsed, null, 2)}\n`);
  renameSync(`${manifestPath}.tmp`, manifestPath);
}

function flatManifestPath(target: ResolvedSkillInstallTarget) {
  return path.join(target.agentSkillRoot, FLAT_SKILL_MANIFEST);
}

function skillInstallLayoutForTarget(target: ResolvedSkillInstallTarget) {
  if (target.kind === "claude") {
    return CLAUDE_SKILL_INSTALL_LAYOUT;
  }

  return "namespace";
}

function managedLocation(target: ResolvedSkillInstallTarget) {
  if (skillInstallLayoutForTarget(target) === "flat") {
    return target.agentSkillRoot;
  }

  return target.namespacePath;
}

function targetKey(target: ResolvedSkillInstallTarget) {
  return `${target.kind}:${target.agentSkillRoot}`;
}

function expandHomeDirectory(input: string, homeDirectory: string) {
  if (input === "~") {
    return homeDirectory;
  }

  if (input.startsWith("~/")) {
    return path.join(homeDirectory, input.slice(2));
  }

  return input;
}
