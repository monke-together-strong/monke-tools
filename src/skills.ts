import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  statSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

import { parse as parseYaml } from "yaml";
import * as z from "zod";

import { errorMessage, MonkeError } from "./errors.ts";
import { loadGlobalMonkeConfig, saveGlobalMonkeConfig } from "./global-config.ts";
import type {
  BuiltInSkillInstallTargetKind,
  SkillInstallPreference,
  SkillInstallTargetKind,
  SkillInstallTargetPreference
} from "./global-config.ts";
import { createLogger } from "./logger.ts";
import { getHomeDirectory, getMonkeHome } from "./runtime.ts";
import type { Runtime } from "./types.ts";
import { parseBoundaryValue } from "./validation.ts";

/** Directory name monke-tools owns inside each selected Agent skill root. */
const SKILL_NAMESPACE = "monke-tools";
const FLAT_SKILL_MANIFEST = ".monke-tools-flat-skills.json";
const NAMESPACE_SKILL_MANIFEST = ".monke-tools-namespace-skills.json";
const SHARED_SKILL_SOURCE_FOLDERS = ["internal", "imported"] as const;
const CODEX_SKILL_SOURCE_FOLDER = "codex";
const NAMESPACE_SOURCE_FOLDERS = ["codex", "imported", "internal", "references"] as const;
const MAX_SYMLINK_RESOLUTION_COUNT = 40;
const SKILL_FRONTMATTER_PATTERN = /^---\r?\n(?<frontmatter>[\s\S]*?)\r?\n---(?:\r?\n|$)/u;
const ASCII_LETTER_PATTERN = /[A-Za-z]/u;
const MacOSFilesystemNameSchema = z.string().trim().min(1);

const BUILT_IN_TARGET_ROOTS: Record<BuiltInSkillInstallTargetKind, string> = {
  claude: path.join(".claude", "skills"),
  codex: path.join(".codex", "skills"),
  cursor: path.join(".cursor", "skills")
};
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
}): ResolvedSkillInstallTarget[] {
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
export async function runSkillsConfigure(runtime: Runtime): Promise<void> {
  const monkeHome = getMonkeHome(runtime);
  const homeDirectory = getHomeDirectory(runtime);
  const config = loadGlobalMonkeConfig(monkeHome);
  const sourceCheckout = config.installedSourceCheckout;
  if (!sourceCheckout) {
    throw new MonkeError(
      "Installed source checkout is not configured; run bun run install:local from the monke-tools checkout first"
    );
  }
  const skillSourceTree = resolveSkillSourceTree(sourceCheckout);

  const previousPreference = config.skillInstallPreference ?? null;
  const nextPreference = await promptForSkillInstallPreference(
    runtime,
    previousPreference,
    homeDirectory
  );
  assertTargetRootsCanBeReconciled(
    resolveSkillInstallTargets({
      homeDirectory,
      preference: nextPreference
    }),
    skillSourceTree
  );
  saveGlobalMonkeConfig(monkeHome, {
    ...config,
    skillInstallPreference: nextPreference
  });

  reconcileSkillNamespaces({
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

/** Record the Installed source checkout and refresh or configure Distributed skill targets. */
export async function runLocalInstallSkills(
  runtime: Runtime,
  sourceCheckout: string
): Promise<void> {
  const monkeHome = getMonkeHome(runtime);
  const homeDirectory = getHomeDirectory(runtime);
  const config = loadGlobalMonkeConfig(monkeHome);
  const installedSourceCheckout = path.resolve(sourceCheckout);
  const nextConfig = {
    ...config,
    installedSourceCheckout
  };

  saveGlobalMonkeConfig(monkeHome, nextConfig);

  if (!config.skillInstallPreference) {
    await runSkillsConfigure(runtime);
    return;
  }

  reconcileSkillNamespaces({
    homeDirectory,
    nextPreference: config.skillInstallPreference,
    previousPreference: config.skillInstallPreference,
    sourceCheckout: installedSourceCheckout,
    writeMessage(message) {
      runtime.writeStderr(message);
    }
  });
  createLogger(runtime).success("Refreshed monke-tools skills");
}

/** Reconcile selected Agent skill roots with the monke-tools Skill source tree. */
export function reconcileSkillNamespaces(options: {
  homeDirectory: string;
  nextPreference: SkillInstallPreference;
  previousPreference: SkillInstallPreference | null;
  sourceCheckout: string;
  writeMessage: (message: string) => void;
}): void {
  const skillSourceTree = resolveSkillSourceTree(options.sourceCheckout);
  assertUniqueSkillIdentities(skillSourceTree);
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
  assertTargetRootsCanBeReconciled(nextTargets, skillSourceTree);
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
      `Failed to reconcile ${failures.length} Skill install target(s):\n${failures.join("\n")}`
    );
  }
}

/** Normalize one custom Agent skill root path for storage in Global monke config. */
function normalizeCustomSkillRoot(options: { homeDirectory: string; input: string }): string {
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
): Promise<SkillInstallPreference> {
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
}): string {
  if (options.answer.trim() === "" && options.previousPath) {
    return options.previousPath;
  }

  return normalizeCustomSkillRoot({
    homeDirectory: options.homeDirectory,
    input: options.answer
  });
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
  skillSourceTree: string
): void {
  mkdirSync(target.agentSkillRoot, { recursive: true });
  if (target.kind === "claude") {
    removeFlatManagedLinks(target);
  }

  const namespaceStat = lstatIfExists(target.namespacePath);
  if (namespaceStat?.isSymbolicLink()) {
    rmSync(target.namespacePath);
  } else if (namespaceStat) {
    const previousManifest = readNamespaceManifest(target);
    if (previousManifest === null) {
      throw new MonkeError(
        `Refusing to overwrite non-managed Skill namespace at ${target.namespacePath}`
      );
    }
    removeNamespaceProjection(target, previousManifest);
  }

  mkdirSync(target.namespacePath);
  const links = discoverNamespaceLinks(target, skillSourceTree);
  const createdLinks: NamespaceSkillLink[] = [];
  try {
    for (const link of links) {
      symlinkSync(link.sourcePath, path.join(target.namespacePath, link.name), "dir");
      createdLinks.push(link);
    }
  } catch (error) {
    writeNamespaceManifest(target, createdLinks);
    throw error;
  }
  writeNamespaceManifest(target, links);
}

function reconcileFlatTarget(target: ResolvedSkillInstallTarget, skillSourceTree: string): void {
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
  removeManagedNamespace(target);
}

function removeManagedNamespace(target: ResolvedSkillInstallTarget): void {
  const namespaceStat = lstatIfExists(target.namespacePath);
  if (!namespaceStat) {
    return;
  }
  if (namespaceStat.isSymbolicLink()) {
    rmSync(target.namespacePath);
    return;
  }

  const manifest = readNamespaceManifest(target);
  if (manifest) {
    removeNamespaceProjection(target, manifest);
  }
}

const NamespaceSkillLinkSchema = z.strictObject({
  name: z.enum(NAMESPACE_SOURCE_FOLDERS),
  sourcePath: z.string().min(1)
});
const NamespaceSkillManifestSchema = z.strictObject({
  links: z.array(NamespaceSkillLinkSchema),
  managedBy: z.literal("monke-tools"),
  version: z.literal(1)
});

type NamespaceSkillLink = z.output<typeof NamespaceSkillLinkSchema>;
type NamespaceSkillManifest = z.output<typeof NamespaceSkillManifestSchema>;

function discoverNamespaceLinks(target: ResolvedSkillInstallTarget, skillSourceTree: string) {
  const sourceFolders: NamespaceSkillLink["name"][] = [
    ...SHARED_SKILL_SOURCE_FOLDERS,
    "references"
  ];
  if (target.kind === "codex") {
    sourceFolders.push(CODEX_SKILL_SOURCE_FOLDER);
  }

  return sourceFolders.flatMap((name) => {
    const sourcePath = path.join(skillSourceTree, name);
    return existsSync(sourcePath) ? [{ name, sourcePath }] : [];
  });
}

const SkillFrontmatterSchema = z.looseObject({
  name: z.string().trim().min(1)
});

function assertUniqueSkillIdentities(skillSourceTree: string) {
  const pathsByAgentSkillName = new Map<string, string>();
  const pathsBySlug = new Map<string, string>();

  for (const sourceFolder of [...SHARED_SKILL_SOURCE_FOLDERS, CODEX_SKILL_SOURCE_FOLDER]) {
    const sourceFolderPath = path.join(skillSourceTree, sourceFolder);
    if (!existsSync(sourceFolderPath)) {
      continue;
    }

    for (const entry of readdirSync(sourceFolderPath, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) {
        continue;
      }
      const skillPath = path.join(sourceFolderPath, entry.name);
      if (!existsSync(path.join(skillPath, "SKILL.md"))) {
        continue;
      }

      const previousPath = pathsBySlug.get(entry.name);
      if (previousPath) {
        throw new MonkeError(
          `Cannot install duplicate Skill slug ${entry.name} from ${previousPath} and ${skillPath}`
        );
      }
      pathsBySlug.set(entry.name, skillPath);

      const agentSkillName = readAgentSkillName(skillPath);
      const previousAgentSkillPath = pathsByAgentSkillName.get(agentSkillName);
      if (previousAgentSkillPath) {
        throw new MonkeError(
          `Cannot install duplicate Agent skill name ${agentSkillName} from ${previousAgentSkillPath} and ${skillPath}`
        );
      }
      pathsByAgentSkillName.set(agentSkillName, skillPath);
    }
  }
}

function readAgentSkillName(skillPath: string) {
  const skillEntryPath = path.join(skillPath, "SKILL.md");
  const skillMarkdown = readFileSync(skillEntryPath, "utf-8");
  const frontmatterMatch = SKILL_FRONTMATTER_PATTERN.exec(skillMarkdown);
  if (!frontmatterMatch) {
    throw new MonkeError(`Expected leading YAML frontmatter at ${skillEntryPath}`);
  }

  let rawFrontmatter: unknown;
  try {
    rawFrontmatter = parseYaml(frontmatterMatch.groups?.frontmatter ?? "");
  } catch {
    throw new MonkeError(`Invalid Skill frontmatter at ${skillEntryPath}`);
  }
  return parseBoundaryValue(
    SkillFrontmatterSchema,
    rawFrontmatter,
    `Skill frontmatter at ${skillEntryPath}`
  ).name;
}

function readNamespaceManifest(target: ResolvedSkillInstallTarget) {
  const manifestPath = namespaceManifestPath(target);
  if (!existsSync(manifestPath)) {
    return null;
  }

  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch {
    throw new MonkeError(`Invalid monke-tools Skill namespace manifest at ${manifestPath}`);
  }

  return parseBoundaryValue(
    NamespaceSkillManifestSchema,
    rawManifest,
    `monke-tools Skill namespace manifest at ${manifestPath}`
  );
}

function removeNamespaceProjection(
  target: ResolvedSkillInstallTarget,
  manifest: NamespaceSkillManifest
) {
  const managedNames = new Set<string>(manifest.links.map((link) => link.name));
  const unexpectedEntries = readdirSync(target.namespacePath).filter(
    (entry) => entry !== NAMESPACE_SKILL_MANIFEST && !managedNames.has(entry)
  );
  if (unexpectedEntries.length > 0) {
    throw new MonkeError(
      `Refusing to remove Skill namespace with non-managed entries at ${target.namespacePath}`
    );
  }

  for (const link of manifest.links) {
    const linkPath = path.join(target.namespacePath, link.name);
    const linkStat = lstatIfExists(linkPath);
    if (!linkStat) {
      continue;
    }
    if (!linkStat.isSymbolicLink() || readlinkSync(linkPath) !== link.sourcePath) {
      throw new MonkeError(`Refusing to remove non-managed Skill namespace link at ${linkPath}`);
    }
  }

  for (const link of manifest.links) {
    rmSync(path.join(target.namespacePath, link.name), { force: true });
  }
  rmSync(namespaceManifestPath(target));
  rmdirSync(target.namespacePath);
}

function writeNamespaceManifest(target: ResolvedSkillInstallTarget, links: NamespaceSkillLink[]) {
  const manifest = NamespaceSkillManifestSchema.parse({
    links,
    managedBy: "monke-tools",
    version: 1
  });
  const manifestPath = namespaceManifestPath(target);

  writeFileSync(`${manifestPath}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(`${manifestPath}.tmp`, manifestPath);
}

function namespaceManifestPath(target: ResolvedSkillInstallTarget) {
  return path.join(target.namespacePath, NAMESPACE_SKILL_MANIFEST);
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

function discoverFlatSkillLinks(skillSourceTree: string): FlatSkillLink[] {
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

function discoverFlatSupportingLinks(
  target: ResolvedSkillInstallTarget,
  skillSourceTree: string
): FlatSupportingLink[] {
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
): void {
  const previousLinks = new Map(
    previousManifest?.links.map((link) => [link.name, link.sourcePath])
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
  previousManifest: FlatSkillManifest | null
): void {
  const previousLinks = new Map(
    previousManifest?.supportingLinks?.map((link) => [link.targetPath, link.sourcePath])
  );

  for (const link of links) {
    const linkStat = lstatIfExists(link.targetPath);
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

function removeFlatManagedLinks(target: ResolvedSkillInstallTarget): void {
  const manifest = readFlatManifest(target);
  if (manifest === null) {
    return;
  }

  for (const link of manifest.links) {
    const linkPath = path.join(target.agentSkillRoot, link.name);
    const linkStat = lstatIfExists(linkPath);
    if (linkStat?.isSymbolicLink() !== true) {
      continue;
    }
    if (readlinkSync(linkPath) === link.sourcePath) {
      rmSync(linkPath);
    }
  }
  for (const link of manifest.supportingLinks ?? []) {
    const linkStat = lstatIfExists(link.targetPath);
    if (linkStat?.isSymbolicLink() === true && readlinkSync(link.targetPath) === link.sourcePath) {
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
    `monke-tools flat Skill manifest at ${manifestPath}`
  );
}

function writeFlatManifest(
  target: ResolvedSkillInstallTarget,
  links: FlatSkillLink[],
  supportingLinks: FlatSupportingLink[]
): void {
  const manifest: FlatSkillManifest = {
    links,
    managedBy: "monke-tools",
    version: 1,
    ...(supportingLinks.length > 0 ? { supportingLinks } : {})
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

function assertUniqueTargetRoots(targets: ResolvedSkillInstallTarget[]) {
  const targetsByRoot = new Map<string, ResolvedSkillInstallTarget>();

  for (const target of targets) {
    const rootIdentity = resolveFilesystemIdentity(target.agentSkillRoot);
    const previousTarget = targetsByRoot.get(rootIdentity);
    if (previousTarget) {
      throw new MonkeError(
        `Skill install targets ${previousTarget.kind} and ${target.kind} resolve to the same Agent skill root: ${target.agentSkillRoot}`
      );
    }
    targetsByRoot.set(rootIdentity, target);
  }
}

function assertTargetRootsCanBeReconciled(
  targets: ResolvedSkillInstallTarget[],
  skillSourceTree: string
) {
  assertUniqueTargetRoots(targets);

  const projections = targets.flatMap((target) => {
    if (skillInstallLayoutForTarget(target) === "namespace") {
      return [{ owner: target, path: target.namespacePath }];
    }

    return [
      { owner: target, path: target.agentSkillRoot },
      ...discoverFlatSupportingLinks(target, skillSourceTree).map((link) => ({
        owner: target,
        path: link.targetPath
      }))
    ];
  });

  for (const projection of projections) {
    if (pathResolutionTraversesEntry(skillSourceTree, projection.path)) {
      throw new MonkeError(
        `Skill source tree falls within the managed Skill projection for ${projection.owner.kind}: ${skillSourceTree}`
      );
    }
  }

  for (const target of targets) {
    if (isProspectivePathWithin(skillSourceTree, target.agentSkillRoot)) {
      throw new MonkeError(
        `Skill install target ${target.kind} falls within the Skill source tree: ${target.agentSkillRoot}`
      );
    }

    for (const projection of projections) {
      const projectionEntryPath = resolveProspectiveFilesystemPath(projection.path, {
        followTerminalSymlink: false
      });
      if (
        projection.owner !== target &&
        isPathContained(
          projectionEntryPath,
          resolveProspectiveFilesystemPath(target.agentSkillRoot)
        )
      ) {
        throw new MonkeError(
          `Skill install target ${target.kind} falls within the managed Skill projection for ${projection.owner.kind}: ${target.agentSkillRoot}`
        );
      }
    }
  }
}

function resolveFilesystemIdentity(targetPath: string) {
  const location = resolveFilesystemLocation(targetPath);
  return filesystemLocationIdentity(location);
}

function resolveFilesystemEntryIdentity(targetPath: string) {
  return filesystemLocationIdentity(
    resolveFilesystemLocation(targetPath, { followTerminalSymlink: false })
  );
}

function filesystemLocationIdentity(location: ReturnType<typeof resolveFilesystemLocation>) {
  if (location.missingSegments.length === 0) {
    return `node:${String(location.ancestorStat.dev)}:${String(location.ancestorStat.ino)}`;
  }

  const missingPath = location.missingSegments.join(path.sep);
  const normalizedMissingPath = isCaseInsensitiveFilesystem(
    location.ancestorPath,
    location.ancestorStat.dev
  )
    ? missingPath.toLowerCase()
    : missingPath;
  return `descendant:${String(location.ancestorStat.dev)}:${String(location.ancestorStat.ino)}:${normalizedMissingPath}`;
}

function resolveProspectiveFilesystemPath(
  targetPath: string,
  options?: { followTerminalSymlink: boolean }
) {
  const location = resolveFilesystemLocation(targetPath, options);
  if (location.missingSegments.length === 0) {
    return location.ancestorPath;
  }

  const missingSegments = isCaseInsensitiveFilesystem(
    location.ancestorPath,
    location.ancestorStat.dev
  )
    ? location.missingSegments.map((segment) => segment.toLowerCase())
    : location.missingSegments;
  return path.join(location.ancestorPath, ...missingSegments);
}

function isProspectivePathWithin(parentPath: string, candidatePath: string) {
  return isPathContained(
    resolveProspectiveFilesystemPath(parentPath),
    resolveProspectiveFilesystemPath(candidatePath)
  );
}

function isPathContained(parentPath: string, candidatePath: string) {
  const relativePath = path.relative(parentPath, candidatePath);
  return (
    relativePath.length === 0 ||
    (!relativePath.startsWith(`..${path.sep}`) &&
      relativePath !== ".." &&
      !path.isAbsolute(relativePath))
  );
}

function pathResolutionTraversesEntry(targetPath: string, entryPath: string) {
  const traversedEntryIdentities = new Set<string>();
  resolveFilesystemLocation(targetPath, { traversedEntryIdentities });
  return traversedEntryIdentities.has(resolveFilesystemEntryIdentity(entryPath));
}

function resolveFilesystemLocation(
  targetPath: string,
  options?: {
    followTerminalSymlink?: boolean;
    traversedEntryIdentities?: Set<string>;
  }
) {
  const absoluteTargetPath = path.resolve(targetPath);
  const targetRoot = path.parse(absoluteTargetPath).root;
  let resolvedPath = targetRoot;
  const pendingSegments = splitPathSegments(absoluteTargetPath.slice(targetRoot.length));
  const missingSegments: string[] = [];
  let symlinkCount = 0;

  while (pendingSegments.length > 0) {
    const segment = pendingSegments.shift();
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (missingSegments.length > 0) {
        missingSegments.pop();
      } else {
        resolvedPath = path.dirname(resolvedPath);
      }
      continue;
    }
    if (missingSegments.length > 0) {
      missingSegments.push(segment);
      continue;
    }

    const candidatePath = path.join(resolvedPath, segment);
    const candidateStat = lstatIfExists(candidatePath);
    if (!candidateStat) {
      missingSegments.push(segment);
      continue;
    }
    const parentStat = statSync(resolvedPath);
    const normalizedSegment = isCaseInsensitiveFilesystem(resolvedPath, parentStat.dev)
      ? segment.toLowerCase()
      : segment;
    options?.traversedEntryIdentities?.add(
      candidateStat.isSymbolicLink()
        ? `descendant:${String(parentStat.dev)}:${String(parentStat.ino)}:${normalizedSegment}`
        : `node:${String(candidateStat.dev)}:${String(candidateStat.ino)}`
    );
    if (
      candidateStat.isSymbolicLink() &&
      pendingSegments.length === 0 &&
      options?.followTerminalSymlink === false
    ) {
      missingSegments.push(segment);
      continue;
    }
    if (candidateStat.isSymbolicLink()) {
      symlinkCount += 1;
      if (symlinkCount > MAX_SYMLINK_RESOLUTION_COUNT) {
        throw new MonkeError(
          `Too many symbolic links while resolving Agent skill root: ${targetPath}`
        );
      }

      const symlinkTarget = readlinkSync(candidatePath);
      const symlinkRoot = path.parse(symlinkTarget).root;
      if (symlinkRoot) {
        resolvedPath = symlinkRoot;
      }
      pendingSegments.unshift(...splitPathSegments(symlinkTarget.slice(symlinkRoot.length)));
      continue;
    }

    resolvedPath = realpathSync.native(candidatePath);
  }

  return {
    ancestorPath: resolvedPath,
    ancestorStat: statSync(resolvedPath),
    missingSegments
  };
}

function splitPathSegments(value: string) {
  return value.split(path.sep).filter(Boolean);
}

function isCaseInsensitiveFilesystem(existingPath: string, device: number) {
  let currentPath = existingPath;

  while (true) {
    const currentStat = statSync(currentPath);
    if (currentStat.dev !== device) {
      return false;
    }

    const caseInsensitive = inferCaseInsensitiveDirectory(currentPath);
    if (caseInsensitive !== null) {
      return caseInsensitive;
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      return inferVolumeIsCaseInsensitive(currentPath) ?? false;
    }
    const parentStat = statSync(parentPath);
    if (parentStat.dev !== device) {
      return inferVolumeIsCaseInsensitive(currentPath) ?? false;
    }
    currentPath = parentPath;
  }
}

function inferCaseInsensitiveDirectory(directoryPath: string) {
  for (const entryName of readdirSync(directoryPath)) {
    const toggledName = toggleFirstLetterCase(entryName);
    if (toggledName === entryName) {
      continue;
    }

    const entryStat = lstatIfExists(path.join(directoryPath, entryName));
    if (!entryStat) {
      continue;
    }
    const aliasStat = lstatIfExists(path.join(directoryPath, toggledName));
    return aliasStat?.dev === entryStat.dev && aliasStat.ino === entryStat.ino;
  }

  return null;
}

function inferVolumeIsCaseInsensitive(mountPath: string) {
  if (process.platform === "win32") {
    return true;
  }
  if (process.platform !== "darwin") {
    return null;
  }

  const diskutilResult = spawnSync("/usr/sbin/diskutil", ["info", "-plist", mountPath], {
    encoding: "utf-8"
  });
  if (diskutilResult.status !== 0) {
    return null;
  }

  const plutilResult = spawnSync("/usr/bin/plutil", ["-extract", "FilesystemName", "raw", "-"], {
    encoding: "utf-8",
    input: diskutilResult.stdout
  });
  if (plutilResult.status !== 0) {
    return null;
  }
  const filesystemName = MacOSFilesystemNameSchema.safeParse(plutilResult.stdout);
  if (!filesystemName.success) {
    return null;
  }

  const normalizedName = filesystemName.data.toLowerCase();
  if (normalizedName.includes("case-sensitive")) {
    return false;
  }
  if (
    normalizedName === "apfs" ||
    normalizedName.includes("hfs+") ||
    normalizedName.includes("fat")
  ) {
    return true;
  }
  return null;
}

function toggleFirstLetterCase(value: string) {
  const letterIndex = value.search(ASCII_LETTER_PATTERN);
  if (letterIndex === -1) {
    return value;
  }

  const letter = value[letterIndex];
  if (!letter) {
    return value;
  }
  const toggledLetter =
    letter === letter.toUpperCase() ? letter.toLowerCase() : letter.toUpperCase();
  return `${value.slice(0, letterIndex)}${toggledLetter}${value.slice(letterIndex + 1)}`;
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
