import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

import * as z from "zod";

import { readImportRecipeStore } from "../scripts/skill-import-recipes.ts";
import type { SkillImportRecipeStore } from "../scripts/skill-import-recipes.ts";
import { errorMessage, MonkeError, ThrownValueSchema } from "./errors.ts";
import {
  BUILT_IN_SKILL_INSTALL_TARGET_KINDS,
  loadGlobalMonkeConfig,
  SkillInstallPreferenceSchema
} from "./global-config.ts";
import type {
  BuiltInSkillInstallTargetKind,
  SkillInstallPreference,
  SkillInstallTargetKind,
  SkillInstallTargetPreference
} from "./global-config.ts";
import {
  preflightGlobalInstructions,
  globalInstructionsPath,
  preflightRemoveGlobalInstructions,
  reconcileGlobalInstructions,
  removeGlobalInstructions
} from "./global-instructions.ts";
import { loadToolInstall } from "./install-manifest.ts";
import { assertDirectoryMutationAccess } from "./path-boundary.ts";
import { containsPath } from "./path-identity.ts";
import { getHomeDirectory, getMonkeHome } from "./runtime.ts";
import { resolveSkillPath } from "./skill-path.ts";
import type { Runtime } from "./types.ts";
import { unwrapBoundaryResult } from "./validation.ts";

const SKILL_NAMESPACE = "monke-tools";
const FLAT_SKILL_MANIFEST = ".monke-tools-flat-skills.json";
const NAMESPACE_MANIFEST = ".monke-tools-namespace.json";
const SHARED_SKILL_SOURCE_FOLDERS = ["internal", "imported"] as const;
const SHARED_NAMESPACE_SOURCE_FOLDERS = ["imported", "internal", "references"] as const;
const CODEX_NAMESPACE_SOURCE_FOLDERS = ["codex", ...SHARED_NAMESPACE_SOURCE_FOLDERS] as const;

const BUILT_IN_TARGET_ROOTS = {
  claude: path.join(".claude", "skills"),
  codex: path.join(".codex", "skills"),
  cursor: path.join(".cursor", "skills"),
  // Antigravity scans its global customization root `~/.gemini/config/skills` one level deep.
  antigravity: path.join(".gemini", "config", "skills")
} satisfies Record<BuiltInSkillInstallTargetKind, string>;

const SkillInstallTargetKindSchema = z.enum(["codex", "claude", "cursor", "antigravity", "custom"]);

const TARGET_OPTIONS: { kind: SkillInstallTargetKind; label: string }[] = [
  { kind: "codex", label: "Codex" },
  { kind: "claude", label: "Claude" },
  { kind: "cursor", label: "Cursor" },
  { kind: "antigravity", label: "Antigravity" },
  { kind: "custom", label: "Custom" }
];

export function skillTargetLabel(kind: SkillInstallTargetKind) {
  return TARGET_OPTIONS.find((option) => option.kind === kind)?.label ?? kind;
}

/** Agents that discover skills only one level below their Agent skill root get flat links. */
export function usesFlatSkillLayout(kind: SkillInstallTargetKind) {
  return kind === "claude" || kind === "antigravity";
}

export interface ResolvedSkillInstallTarget {
  agentSkillRoot: string;
  kind: SkillInstallTargetKind;
  namespacePath: string;
}

export interface SkillPublicationScope {
  homeDirectory: string;
  preference: SkillInstallPreference;
}

/** Noninteractive Skill targets supplied by install automation. */
export interface ExplicitSkillTargetSelection {
  builtInTargetKinds?: BuiltInSkillInstallTargetKind[];
  customTargetPath?: string;
}

export function resolveSkillInstallTargets(options: {
  homeDirectory: string;
  preference: SkillInstallPreference;
  project?: boolean;
}) {
  return options.preference.targets.map((target) => {
    const agentSkillRoot =
      target.kind === "custom"
        ? normalizeCustomSkillRoot({
            homeDirectory: options.homeDirectory,
            input: target.path
          })
        : path.join(
            options.homeDirectory,
            target.kind === "codex" && options.project
              ? path.join(".agents", "skills")
              : BUILT_IN_TARGET_ROOTS[target.kind]
          );

    return {
      agentSkillRoot,
      kind: target.kind,
      namespacePath: path.join(agentSkillRoot, SKILL_NAMESPACE)
    };
  });
}

interface SkillTargetFootprint {
  referencesLinkPath?: string;
  rootLinkPath: string;
  rootPaths: ReadonlySet<string>;
  rootResolved: string;
  target: ResolvedSkillInstallTarget;
}

const canonicalLinkPath = (entry: string) =>
  path.join(resolveSkillPath(path.dirname(entry)).resolved, path.basename(entry));

const inspectTargetFootprint = (target: ResolvedSkillInstallTarget): SkillTargetFootprint => {
  const rootResolution = resolveSkillPath(target.agentSkillRoot);

  return {
    referencesLinkPath: usesFlatSkillLayout(target.kind)
      ? canonicalLinkPath(flatSupportingLinkPath(target))
      : undefined,
    rootLinkPath: canonicalLinkPath(target.agentSkillRoot),
    rootPaths: rootResolution.paths,
    rootResolved: rootResolution.resolved,
    target
  };
};

const inspectUnselectedBuiltInFootprint = (
  target: ResolvedSkillInstallTarget
): SkillTargetFootprint => {
  try {
    return inspectTargetFootprint(target);
  } catch {
    // Ignore cyclic symlinks in an unused harness. Selected targets are still resolved strictly.
    const normalizedRoot = path.resolve(target.agentSkillRoot);

    return {
      referencesLinkPath: usesFlatSkillLayout(target.kind)
        ? flatSupportingLinkPath(target)
        : undefined,
      rootLinkPath: normalizedRoot,
      rootPaths: new Set([normalizedRoot]),
      rootResolved: normalizedRoot,
      target
    };
  }
};

const pathsTouchRegion = (paths: ReadonlySet<string>, region: string) => {
  for (const entry of paths) {
    if (containsPath(region, entry)) {
      return true;
    }
  }

  return false;
};

const footprintOverlapsOther = (left: SkillTargetFootprint, right: SkillTargetFootprint) => {
  if (
    containsPath(left.rootResolved, right.rootResolved) ||
    containsPath(left.rootLinkPath, right.rootLinkPath) ||
    pathsTouchRegion(right.rootPaths, left.rootResolved) ||
    pathsTouchRegion(right.rootPaths, left.rootLinkPath)
  ) {
    return true;
  }

  if (left.referencesLinkPath !== undefined) {
    if (
      containsPath(left.referencesLinkPath, right.rootResolved) ||
      containsPath(right.rootResolved, left.referencesLinkPath) ||
      pathsTouchRegion(right.rootPaths, left.referencesLinkPath)
    ) {
      return true;
    }

    if (
      right.referencesLinkPath !== undefined &&
      (containsPath(left.referencesLinkPath, right.referencesLinkPath) ||
        containsPath(right.referencesLinkPath, left.referencesLinkPath))
    ) {
      return true;
    }
  }

  return false;
};

const targetFootprintsOverlap = (left: SkillTargetFootprint, right: SkillTargetFootprint) =>
  footprintOverlapsOther(left, right) || footprintOverlapsOther(right, left);

const formatOverlappingTargetsError = (
  left: ResolvedSkillInstallTarget,
  right: ResolvedSkillInstallTarget,
  project: boolean
) => {
  if (left.kind === "custom" || right.kind === "custom") {
    const custom = left.kind === "custom" ? left : right;
    const builtIn = left.kind === "custom" ? right : left;

    return new MonkeError(
      `Custom Agent skill root ${custom.agentSkillRoot} overlaps ${skillTargetLabel(builtIn.kind)} at ${builtIn.agentSkillRoot}. Select ${skillTargetLabel(builtIn.kind)} or configure a Custom Agent skill root outside built-in destinations with mt skills configure.`
    );
  }

  const recovery = project
    ? "Separate the aliased directories in this checkout."
    : "Separate the aliased directories or select distinct targets with mt skills configure.";

  return new MonkeError(
    `${skillTargetLabel(left.kind)} at ${left.agentSkillRoot} and ${skillTargetLabel(right.kind)} at ${right.agentSkillRoot} overlap as Agent skill roots. ${recovery}`
  );
};

/** Reject overlapping selected destinations and Custom targets inside built-in destinations. */
export const assertDistinctSkillInstallTargets = (
  targets: readonly ResolvedSkillInstallTarget[],
  options: { homeDirectory: string; project?: boolean }
) => {
  const footprints = targets.map(inspectTargetFootprint);

  for (const [index, left] of footprints.entries()) {
    for (const right of footprints.slice(index + 1)) {
      if (targetFootprintsOverlap(left, right)) {
        throw formatOverlappingTargetsError(left.target, right.target, options.project === true);
      }
    }
  }

  if (options.project) {
    return;
  }

  const customFootprint = footprints.find((footprint) => footprint.target.kind === "custom");

  if (!customFootprint) {
    return;
  }

  const selectedBuiltInKinds = new Set(
    targets.filter((target) => target.kind !== "custom").map((target) => target.kind)
  );

  const unselectedKinds = BUILT_IN_SKILL_INSTALL_TARGET_KINDS.filter(
    (kind) => !selectedBuiltInKinds.has(kind)
  );

  if (unselectedKinds.length === 0) {
    return;
  }

  const unselectedBuiltIns = resolveSkillInstallTargets({
    homeDirectory: options.homeDirectory,
    preference: { targets: unselectedKinds.map((kind) => ({ kind })) }
  });

  for (const builtIn of unselectedBuiltIns) {
    if (targetFootprintsOverlap(customFootprint, inspectUnselectedBuiltInFootprint(builtIn))) {
      throw formatOverlappingTargetsError(builtIn, customFootprint.target, false);
    }
  }
};

export function explicitSkillInstallPreference(
  homeDirectory: string,
  explicitTargets: ExplicitSkillTargetSelection | undefined
) {
  if (explicitTargets === undefined) {
    return;
  }

  const targets: SkillInstallTargetPreference[] =
    explicitTargets.builtInTargetKinds?.map((kind) => ({ kind })) ?? [];

  if (explicitTargets.customTargetPath !== undefined) {
    targets.push({
      kind: "custom",
      path: normalizeCustomSkillRoot({
        homeDirectory,
        input: explicitTargets.customTargetPath
      })
    });
  }

  const preference = unwrapBoundaryResult(
    SkillInstallPreferenceSchema.safeParse({ targets }),
    "explicit Skill install target selection"
  );

  assertDistinctSkillInstallTargets(resolveSkillInstallTargets({ homeDirectory, preference }), {
    homeDirectory
  });

  return preference;
}

const NamespaceSourceFolderSchema = z.enum(CODEX_NAMESPACE_SOURCE_FOLDERS);

type NamespaceSourceFolder = z.output<typeof NamespaceSourceFolderSchema>;

const NamespaceLinkSchema = z.strictObject({
  name: NamespaceSourceFolderSchema,
  sourcePath: z.string().min(1)
});

const NamespaceManifestSchema = z.strictObject({
  links: z.array(NamespaceLinkSchema).superRefine((links, context) => {
    const seen = new Set<NamespaceSourceFolder>();

    for (const [index, link] of links.entries()) {
      if (seen.has(link.name)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate Skill namespace folder ${link.name}`,
          path: [index, "name"]
        });
      }

      seen.add(link.name);
    }
  }),
  managedBy: z.literal("monke-tools"),
  version: z.literal(1)
});

type NamespaceLink = z.output<typeof NamespaceLinkSchema>;

type NamespaceManifest = z.output<typeof NamespaceManifestSchema>;

interface LegacyNamespaceContext {
  monkeHome?: string;
  project?: boolean;
  skillSourceTree?: string;
}

const isUserSkillDirectory = (directory: string) =>
  lstatSync(path.join(directory, "SKILL.md"), { throwIfNoEntry: false }) !== undefined;

const namespaceManifestPath = (target: ResolvedSkillInstallTarget) =>
  path.join(target.namespacePath, NAMESPACE_MANIFEST);

const readNamespaceManifest = (target: ResolvedSkillInstallTarget) => {
  const manifestPath = namespaceManifestPath(target);
  const manifestStat = lstatSync(manifestPath, { throwIfNoEntry: false });

  if (!manifestStat) {
    return null;
  }

  if (!manifestStat.isFile()) {
    throw new MonkeError(`Invalid monke-tools Skill namespace manifest at ${manifestPath}`);
  }

  let rawManifest: unknown;

  try {
    rawManifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch {
    throw new MonkeError(`Invalid monke-tools Skill namespace manifest at ${manifestPath}`);
  }

  return unwrapBoundaryResult(
    NamespaceManifestSchema.safeParse(rawManifest),
    `monke-tools Skill namespace manifest at ${manifestPath}`
  );
};

const writeNamespaceManifest = (
  target: ResolvedSkillInstallTarget,
  links: readonly NamespaceLink[]
) => {
  const manifest: NamespaceManifest = {
    links: [...links].toSorted((left, right) => left.name.localeCompare(right.name)),
    managedBy: "monke-tools",
    version: 1
  };

  const manifestPath = namespaceManifestPath(target);
  const parsed = NamespaceManifestSchema.parse(manifest);

  writeFileSync(`${manifestPath}.tmp`, `${JSON.stringify(parsed, null, 2)}\n`);
  renameSync(`${manifestPath}.tmp`, manifestPath);
};

const knownLocalSourceCheckouts = (monkeHome: string) => {
  const installsRoot = path.join(monkeHome, "installs");

  if (!existsSync(installsRoot)) {
    return [];
  }

  const checkouts: string[] = [];

  for (const entry of readdirSync(installsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      continue;
    }

    try {
      const { manifest } = loadToolInstall(path.join(installsRoot, entry.name));

      if (manifest.installKind === "local") {
        checkouts.push(manifest.sourceCheckout);
      }
    } catch {
      // Ignore incomplete or unrelated install directories when checking legacy link ownership.
    }
  }

  return checkouts;
};

const isLegacyManagedNamespaceLink = (
  currentTarget: string,
  name: NamespaceSourceFolder,
  context: LegacyNamespaceContext
) => {
  if (!path.isAbsolute(currentTarget)) {
    return false;
  }

  const normalizedTarget = path.resolve(currentTarget);

  if (
    context.skillSourceTree !== undefined &&
    normalizedTarget === path.join(path.resolve(context.skillSourceTree), name)
  ) {
    return true;
  }

  if (context.project || !context.monkeHome) {
    return false;
  }

  const resolvedMonkeHome = path.resolve(context.monkeHome);

  const monkeHomes = [
    resolvedMonkeHome,
    ...(existsSync(resolvedMonkeHome) ? [realpathSync.native(resolvedMonkeHome)] : [])
  ];

  for (const home of new Set(monkeHomes)) {
    if (normalizedTarget === path.join(home, "skill-registry", "skills", name)) {
      return true;
    }

    const relativeToInstalls = path.relative(path.join(home, "installs"), normalizedTarget);
    const segments = relativeToInstalls.split(path.sep);

    if (
      !path.isAbsolute(relativeToInstalls) &&
      segments.length === 3 &&
      segments[0] &&
      segments[0] !== "." &&
      segments[0] !== ".." &&
      segments[1] === "skills" &&
      segments[2] === name
    ) {
      return true;
    }

    for (const checkout of knownLocalSourceCheckouts(home)) {
      if (normalizedTarget === path.join(path.resolve(checkout), "skills", name)) {
        return true;
      }
    }
  }

  return false;
};

const hasLegacyManagedNamespaceLinks = (
  target: ResolvedSkillInstallTarget,
  legacyContext: LegacyNamespaceContext
) => {
  if (isUserSkillDirectory(target.namespacePath)) {
    return false;
  }

  return CODEX_NAMESPACE_SOURCE_FOLDERS.some((name) => {
    const linkPath = path.join(target.namespacePath, name);
    const linkStat = lstatSync(linkPath, { throwIfNoEntry: false });

    return (
      linkStat?.isSymbolicLink() === true &&
      isLegacyManagedNamespaceLink(readlinkSync(linkPath), name, legacyContext)
    );
  });
};

const discoverNamespaceLinks = (
  skillSourceTree: string,
  sourceFolders: readonly NamespaceSourceFolder[]
): NamespaceLink[] =>
  sourceFolders
    .map((name) => ({ name, sourcePath: path.join(skillSourceTree, name) }))
    .filter((link) => existsSync(link.sourcePath));

const assertNamespaceCanBeManaged = (
  target: ResolvedSkillInstallTarget,
  links: readonly NamespaceLink[],
  previousManifest: NamespaceManifest | null,
  legacyContext: LegacyNamespaceContext
) => {
  if (previousManifest === null && isUserSkillDirectory(target.namespacePath)) {
    throw new MonkeError(`Refusing to overwrite Skill namespace at ${target.namespacePath}`);
  }

  const previousLinks = new Map(
    previousManifest?.links.map((link) => [link.name, link.sourcePath])
  );

  for (const link of links) {
    const linkPath = path.join(target.namespacePath, link.name);
    const linkStat = lstatSync(linkPath, { throwIfNoEntry: false });

    if (!linkStat) {
      continue;
    }

    if (!linkStat.isSymbolicLink()) {
      throw new MonkeError(`Refusing to overwrite non-managed Skill folder at ${linkPath}`);
    }

    const currentTarget = readlinkSync(linkPath);

    const isOwned =
      currentTarget === link.sourcePath ||
      currentTarget === previousLinks.get(link.name) ||
      (previousManifest === null &&
        isLegacyManagedNamespaceLink(currentTarget, link.name, legacyContext));

    if (!isOwned) {
      throw new MonkeError(`Refusing to overwrite non-managed Skill folder at ${linkPath}`);
    }
  }
};

/** Preflight known guidance destinations before Local or Release core activation. */
export function preflightInstallGuidance(
  runtime: Runtime,
  guidanceSourceRoot: string,
  explicitTargets?: ExplicitSkillTargetSelection,
  adoptedLinks: ReadonlyMap<string, string> = new Map(),
  scope?: SkillPublicationScope
) {
  const monkeHome = getMonkeHome(runtime);

  const previousPreference =
    scope?.preference ?? loadGlobalMonkeConfig(monkeHome).skillInstallPreference;

  const homeDirectory = scope?.homeDirectory ?? getHomeDirectory(runtime);

  const nextPreference =
    explicitSkillInstallPreference(homeDirectory, explicitTargets) ?? previousPreference;

  if (!nextPreference && !previousPreference) {
    return;
  }

  const project = scope !== undefined;
  const previousTargets = resolveTargetsByKey(homeDirectory, previousPreference, project);
  const nextTargets = resolveTargetsByKey(homeDirectory, nextPreference, project);

  if (nextTargets.size > 0) {
    try {
      assertDistinctSkillInstallTargets([...nextTargets.values()], { homeDirectory, project });
    } catch (cause) {
      throw new MonkeError(
        `Install guidance destination preflight failed:\n${errorMessage(ThrownValueSchema.parse(cause))}`,
        { cause }
      );
    }
  }

  const candidateSkillSourceTree = path.join(path.resolve(guidanceSourceRoot), "skills");

  const removalLegacyContext: LegacyNamespaceContext = {
    monkeHome,
    project,
    skillSourceTree: existsSync(candidateSkillSourceTree) ? candidateSkillSourceTree : undefined
  };

  const failures: string[] = [];

  for (const [key, target] of previousTargets) {
    if (nextTargets.has(key)) {
      continue;
    }

    try {
      preflightSkillTargetRemoval(target, removalLegacyContext);

      if (!scope) {
        preflightRemoveGlobalInstructions(target, {
          cwd: runtime.cwd,
          environment: runtime.env,
          homeDirectory
        });
      }
    } catch (cause) {
      failures.push(`${target.agentSkillRoot}: ${errorMessage(ThrownValueSchema.parse(cause))}`);
    }
  }

  for (const target of nextTargets.values()) {
    try {
      preflightOneSkillTarget(target, guidanceSourceRoot, adoptedLinks, { monkeHome, project });

      if (!scope) {
        preflightGlobalInstructions(target, {
          cwd: runtime.cwd,
          environment: runtime.env,
          guidanceSourceRoot,
          homeDirectory
        });
      }
    } catch (cause) {
      failures.push(`${target.agentSkillRoot}: ${errorMessage(ThrownValueSchema.parse(cause))}`);
    }
  }

  if (failures.length > 0) {
    throw new MonkeError(`Install guidance destination preflight failed:\n${failures.join("\n")}`);
  }
}

function preflightOneSkillTarget(
  target: ResolvedSkillInstallTarget,
  guidanceSourceRoot: string,
  adoptedLinks: ReadonlyMap<string, string>,
  legacyContext: Omit<LegacyNamespaceContext, "skillSourceTree">
) {
  const skillSourceTree = resolveSkillSourceTree(guidanceSourceRoot);
  prepareSkillTargetPlan(target, skillSourceTree, adoptedLinks, {
    ...legacyContext,
    skillSourceTree
  }).preflight();
}

function preflightNamespaceTarget(
  target: ResolvedSkillInstallTarget,
  links: readonly NamespaceLink[],
  legacyContext: LegacyNamespaceContext
) {
  assertDirectoryMutationAccess(target.agentSkillRoot, "Skill namespace destination");
  const namespaceStat = lstatSync(target.namespacePath, { throwIfNoEntry: false });

  if (!namespaceStat) {
    return;
  }

  if (!namespaceStat.isDirectory()) {
    throw new MonkeError(`Refusing to overwrite Skill namespace at ${target.namespacePath}`);
  }

  assertDirectoryMutationAccess(target.namespacePath, "Skill namespace destination");
  const previousManifest = readNamespaceManifest(target);
  assertNamespaceCanBeManaged(target, links, previousManifest, legacyContext);
}

function preflightFlatTarget(
  target: ResolvedSkillInstallTarget,
  links: FlatSkillLink[],
  supportingLinks: FlatSupportingLink[],
  adoptedLinks: ReadonlyMap<string, string>
) {
  const previousManifest = readFlatManifest(target);
  assertDirectoryMutationAccess(target.agentSkillRoot, "Agent Skill root");

  for (const link of supportingLinks) {
    assertDirectoryMutationAccess(path.dirname(link.targetPath), "Reference link parent");
  }

  assertFlatLinksCanBeManaged(target, links, previousManifest, adoptedLinks);
  assertFlatSupportingLinksCanBeManaged(supportingLinks, previousManifest);
}

function preflightSkillTargetRemoval(
  target: ResolvedSkillInstallTarget,
  legacyContext: LegacyNamespaceContext
) {
  if (usesFlatSkillLayout(target.kind)) {
    const manifest = readFlatManifest(target);

    if (!manifest) {
      return;
    }

    assertDirectoryMutationAccess(target.agentSkillRoot, "Agent Skill root");

    for (const link of manifest.supportingLinks ?? []) {
      assertDirectoryMutationAccess(path.dirname(link.targetPath), "Reference link parent");
    }

    return;
  }

  const namespaceStat = lstatSync(target.namespacePath, { throwIfNoEntry: false });

  if (!namespaceStat?.isDirectory()) {
    return;
  }

  const manifest = readNamespaceManifest(target);

  if (manifest === null && !hasLegacyManagedNamespaceLinks(target, legacyContext)) {
    return;
  }

  assertDirectoryMutationAccess(target.agentSkillRoot, "Agent Skill root");
  assertDirectoryMutationAccess(target.namespacePath, "Skill namespace");
}

function resolveTargetsByKey(
  homeDirectory: string,
  preference: SkillInstallPreference | undefined,
  project = false
) {
  if (!preference) {
    return new Map<string, ResolvedSkillInstallTarget>();
  }

  return new Map(
    resolveSkillInstallTargets({ homeDirectory, preference, project }).map((target) => [
      targetKey(target),
      target
    ])
  );
}

export function reconcileSkillNamespaces(options: {
  cwd: string;
  environment?: Record<string, string | undefined>;
  guidanceSourceRoot: string;
  homeDirectory: string;
  includeGlobalInstructions?: boolean;
  monkeHome?: string;
  nextPreference: SkillInstallPreference;
  previousPreference: SkillInstallPreference | null;
  project?: boolean;
  writeMessage: (message: string) => void;
}) {
  const skillSourceTree = resolveSkillSourceTree(options.guidanceSourceRoot);

  const monkeHome =
    options.monkeHome ??
    (options.environment?.MONKE_HOME !== undefined
      ? path.resolve(options.cwd, options.environment.MONKE_HOME)
      : undefined);

  const legacyContext: LegacyNamespaceContext = {
    monkeHome,
    project: options.project,
    skillSourceTree
  };

  const previousTargets =
    options.previousPreference === null
      ? []
      : resolveSkillInstallTargets({
          homeDirectory: options.homeDirectory,
          preference: options.previousPreference,
          project: options.project
        });

  const nextTargets = resolveSkillInstallTargets({
    homeDirectory: options.homeDirectory,
    preference: options.nextPreference,
    project: options.project
  });

  assertDistinctSkillInstallTargets(nextTargets, {
    homeDirectory: options.homeDirectory,
    project: options.project
  });

  const nextKeys = new Set(nextTargets.map(targetKey));
  const failures: string[] = [];
  preflightAdoptedSkillLinks(options.guidanceSourceRoot);

  for (const previousTarget of previousTargets) {
    if (nextKeys.has(targetKey(previousTarget))) {
      continue;
    }

    try {
      removeManagedTarget(previousTarget, options, legacyContext);
    } catch (cause) {
      const message = errorMessage(ThrownValueSchema.parse(cause));
      failures.push(`${previousTarget.agentSkillRoot}: ${message}`);
    }
  }

  reconcileAdoptedSkillLinks(options.guidanceSourceRoot, nextTargets);

  for (const target of nextTargets) {
    try {
      prepareSkillTargetPlan(target, skillSourceTree, undefined, legacyContext).reconcile();

      if (options.includeGlobalInstructions !== false) {
        reconcileGlobalInstructions(target, options);
      }

      options.writeMessage(
        `Linked ${SKILL_NAMESPACE} skills at ${skillTargetPolicy(target).managedLocation}\n`
      );
    } catch (cause) {
      const message = errorMessage(ThrownValueSchema.parse(cause));
      failures.push(`${target.agentSkillRoot}: ${message}`);
    }
  }

  if (failures.length > 0) {
    throw new MonkeError(
      `Failed to reconcile ${failures.length} Skill install target(s):\n${failures.join("\n")}`
    );
  }
}

/**
 * Refuse adopted projection paths that exist but do not link to their imported skill. Returns each
 * adopted projection path mapped to its imported skill so target preflight accepts those links.
 */
export function preflightAdoptedSkillLinks(root: string) {
  const links = new Map<string, string>();

  for (const recipe of readImportRecipeStore(root, false).recipes) {
    for (const skill of recipe.skills) {
      const source = path.join(root, "skills", "imported", skill.slug);

      for (const destination of skill.adoptedPaths ?? []) {
        const stat = lstatSync(destination, { throwIfNoEntry: false });

        if (stat && (!stat.isSymbolicLink() || readlinkSync(destination) !== source)) {
          throw new MonkeError(`Refusing to overwrite adopted Skill projection at ${destination}`);
        }

        links.set(destination, source);
      }
    }
  }

  return links;
}

function reconcileAdoptedSkillLinks(root: string, targets: ResolvedSkillInstallTarget[]) {
  for (const recipe of readImportRecipeStore(root, false).recipes) {
    for (const skill of recipe.skills) {
      const source = path.join(root, "skills", "imported", skill.slug);

      for (const destination of skill.adoptedPaths ?? []) {
        const configured = targets.find(
          (target) => path.dirname(destination) === target.agentSkillRoot
        );

        const stat = lstatSync(destination, { throwIfNoEntry: false });

        if (configured) {
          if (!usesFlatSkillLayout(configured.kind) && stat) {
            rmSync(destination);
          }

          continue;
        }

        mkdirSync(path.dirname(destination), { recursive: true });

        if (!stat) {
          symlinkSync(source, destination, "dir");
        }
      }
    }
  }
}

/** Retire only projections still pointing at their recorded registry owner. */
export function retireAdoptedSkillLinks(root: string, previous: SkillImportRecipeStore) {
  const retained = new Set(
    readImportRecipeStore(root, false).recipes.flatMap((recipe) =>
      recipe.skills.flatMap((skill) => skill.adoptedPaths ?? [])
    )
  );

  for (const recipe of previous.recipes) {
    for (const skill of recipe.skills) {
      const source = path.join(root, "skills", "imported", skill.slug);

      for (const destination of skill.adoptedPaths ?? []) {
        if (
          !retained.has(destination) &&
          lstatSync(destination, { throwIfNoEntry: false })?.isSymbolicLink() &&
          readlinkSync(destination) === source
        ) {
          rmSync(destination);
        }
      }
    }
  }
}

/** Include destinations that project publication can introduce after snapshots are captured. */
export function projectSkillProjectionRecoveryPaths(scope: SkillPublicationScope) {
  return resolveSkillInstallTargets({ ...scope, project: true }).flatMap((target) => {
    const paths = [target.agentSkillRoot];

    if (existsSync(target.agentSkillRoot)) {
      paths.push(realpathSync.native(target.agentSkillRoot));
    }

    if (skillTargetPolicy(target).layout === "flat") {
      const references = flatSupportingLinkPath(target);
      const entry = lstatSync(references, { throwIfNoEntry: false });

      // Publication replaces this entry, never its referent or an unrelated real directory.
      if (!entry || entry.isSymbolicLink()) {
        paths.push(references);
      }
    }

    return paths;
  });
}

/** Paths target reconciliation can mutate; adoption retains them until publication completes. */
export function skillPublicationPaths(
  runtime: Runtime,
  root: string,
  slugs: string[],
  scope?: SkillPublicationScope
) {
  const preference =
    scope?.preference ?? loadGlobalMonkeConfig(getMonkeHome(runtime)).skillInstallPreference;

  const homeDirectory = scope?.homeDirectory ?? getHomeDirectory(runtime);

  const targets = resolveSkillInstallTargets({
    homeDirectory,
    preference: preference ?? { targets: [] },
    project: scope !== undefined
  });

  const paths = readImportRecipeStore(root, false).recipes.flatMap((recipe) =>
    recipe.skills.flatMap((skill) => skill.adoptedPaths ?? [])
  );

  for (const target of targets) {
    if (usesFlatSkillLayout(target.kind)) {
      const manifest = readFlatManifest(target);
      const links = discoverFlatSkillLinks(resolveSkillSourceTree(root));
      paths.push(
        flatManifestPath(target),
        ...[
          ...slugs,
          ...links.map((link) => link.name),
          ...(manifest?.links.map((link) => link.name) ?? [])
        ].map((slug) => path.join(target.agentSkillRoot, slug)),
        ...discoverFlatSupportingLinks(target, resolveSkillSourceTree(root)).map(
          (link) => link.targetPath
        ),
        ...(manifest?.supportingLinks?.map((link) => link.targetPath) ?? [])
      );
    } else {
      paths.push(target.namespacePath);
    }

    const instructions = scope
      ? null
      : globalInstructionsPath(target, {
          cwd: runtime.cwd,
          environment: runtime.env,
          homeDirectory
        });

    if (instructions) {
      paths.push(existsSync(instructions) ? realpathSync.native(instructions) : instructions);
    }
  }

  return paths;
}

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

export async function promptForSkillInstallPreference(
  runtime: Runtime,
  previousPreference: SkillInstallPreference | null,
  homeDirectory: string
) {
  const selectedKinds = unwrapBoundaryResult(
    z.array(SkillInstallTargetKindSchema).safeParse(
      await runtime.multiSelect({
        initialValues: previousPreference?.targets.map((target) => target.kind) ?? [],
        message: "Skill install targets",
        options: TARGET_OPTIONS.map((option) => ({
          label: option.label,
          value: option.kind
        })),
        required: true
      })
    ),
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

  const preference = { targets };

  assertDistinctSkillInstallTargets(resolveSkillInstallTargets({ homeDirectory, preference }), {
    homeDirectory
  });

  return preference;
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

export function resolveSkillSourceTree(guidanceSourceRoot: string) {
  const resolvedGuidanceSourceRoot = path.resolve(guidanceSourceRoot);

  if (!existsSync(resolvedGuidanceSourceRoot)) {
    throw new MonkeError(`Guidance source root is missing: ${resolvedGuidanceSourceRoot}`);
  }

  const skillSourceTree = path.join(resolvedGuidanceSourceRoot, "skills");

  if (!existsSync(skillSourceTree)) {
    throw new MonkeError(`Skill source tree is missing: ${skillSourceTree}`);
  }

  return skillSourceTree;
}

function reconcileNamespaceTarget(
  target: ResolvedSkillInstallTarget,
  links: readonly NamespaceLink[],
  legacyContext: LegacyNamespaceContext
) {
  mkdirSync(target.agentSkillRoot, { recursive: true });

  const namespaceStat = lstatSync(target.namespacePath, { throwIfNoEntry: false });

  if (namespaceStat && !namespaceStat.isDirectory()) {
    throw new MonkeError(`Refusing to overwrite Skill namespace at ${target.namespacePath}`);
  }

  const previousManifest = namespaceStat ? readNamespaceManifest(target) : null;

  if (namespaceStat) {
    assertNamespaceCanBeManaged(target, links, previousManifest, legacyContext);
  } else {
    mkdirSync(target.namespacePath);
  }

  const activeLinks = new Map<NamespaceSourceFolder, string>();

  if (previousManifest !== null) {
    for (const link of previousManifest.links) {
      const linkPath = path.join(target.namespacePath, link.name);
      const linkStat = lstatSync(linkPath, { throwIfNoEntry: false });

      if (linkStat?.isSymbolicLink() === true && readlinkSync(linkPath) === link.sourcePath) {
        activeLinks.set(link.name, link.sourcePath);
      }
    }
  } else if (namespaceStat) {
    for (const name of CODEX_NAMESPACE_SOURCE_FOLDERS) {
      const linkPath = path.join(target.namespacePath, name);
      const linkStat = lstatSync(linkPath, { throwIfNoEntry: false });

      if (linkStat?.isSymbolicLink() === true) {
        const currentTarget = readlinkSync(linkPath);

        if (isLegacyManagedNamespaceLink(currentTarget, name, legacyContext)) {
          activeLinks.set(name, currentTarget);
        }
      }
    }
  }

  const nextLinkNames = new Set(links.map((link) => link.name));

  try {
    for (const name of activeLinks.keys()) {
      if (!nextLinkNames.has(name)) {
        rmSync(path.join(target.namespacePath, name));
        activeLinks.delete(name);
      }
    }

    for (const link of links) {
      const linkPath = path.join(target.namespacePath, link.name);

      if (lstatSync(linkPath, { throwIfNoEntry: false })) {
        rmSync(linkPath);
        activeLinks.delete(link.name);
      }

      symlinkSync(link.sourcePath, linkPath, "dir");
      activeLinks.set(link.name, link.sourcePath);
    }
  } catch (cause) {
    writeNamespaceManifest(
      target,
      [...activeLinks.entries()].map(([name, sourcePath]) => ({ name, sourcePath }))
    );
    throw cause;
  }

  writeNamespaceManifest(target, links);
}

function reconcileFlatTarget(
  target: ResolvedSkillInstallTarget,
  links: FlatSkillLink[],
  supportingLinks: FlatSupportingLink[]
) {
  mkdirSync(target.agentSkillRoot, { recursive: true });

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
  } catch (cause) {
    writeFlatManifest(target, createdLinks, createdSupportingLinks);
    throw cause;
  }

  writeFlatManifest(target, links, supportingLinks);
}

function removeManagedTarget(
  target: ResolvedSkillInstallTarget,
  options: {
    cwd: string;
    environment?: Record<string, string | undefined>;
    homeDirectory: string;
    includeGlobalInstructions?: boolean;
  },
  legacyContext: LegacyNamespaceContext
) {
  if (usesFlatSkillLayout(target.kind)) {
    removeFlatManagedLinks(target);
  } else {
    removeManagedNamespace(target, legacyContext);
  }

  if (options.includeGlobalInstructions !== false) {
    removeGlobalInstructions(target, options);
  }
}

function removeManagedNamespace(
  target: ResolvedSkillInstallTarget,
  legacyContext: LegacyNamespaceContext
) {
  const namespaceStat = lstatSync(target.namespacePath, { throwIfNoEntry: false });

  if (!namespaceStat?.isDirectory()) {
    return;
  }

  const manifest = readNamespaceManifest(target);

  if (manifest !== null) {
    for (const link of manifest.links) {
      const linkPath = path.join(target.namespacePath, link.name);
      const linkStat = lstatSync(linkPath, { throwIfNoEntry: false });

      if (linkStat?.isSymbolicLink() === true && readlinkSync(linkPath) === link.sourcePath) {
        rmSync(linkPath);
      }
    }

    rmSync(namespaceManifestPath(target), { force: true });

    if (readdirSync(target.namespacePath).length === 0) {
      rmdirSync(target.namespacePath);
    }

    return;
  }

  if (isUserSkillDirectory(target.namespacePath)) {
    return;
  }

  let removedManagedLink = false;

  for (const name of CODEX_NAMESPACE_SOURCE_FOLDERS) {
    const linkPath = path.join(target.namespacePath, name);
    const linkStat = lstatSync(linkPath, { throwIfNoEntry: false });

    if (
      linkStat?.isSymbolicLink() === true &&
      isLegacyManagedNamespaceLink(readlinkSync(linkPath), name, legacyContext)
    ) {
      rmSync(linkPath);
      removedManagedLink = true;
    }
  }

  if (removedManagedLink && readdirSync(target.namespacePath).length === 0) {
    rmdirSync(target.namespacePath);
  }
}

const FlatSkillLinkSchema = z.strictObject({
  name: z
    .string()
    .min(1)
    .refine(
      (name) =>
        name !== "." && name !== ".." && !name.includes("\0") && path.basename(name) === name,
      "A Skill slug must be a single directory name"
    ),
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

function flatSupportingLinkPath(target: ResolvedSkillInstallTarget) {
  return path.resolve(target.agentSkillRoot, "..", "references");
}

function discoverFlatSupportingLinks(target: ResolvedSkillInstallTarget, skillSourceTree: string) {
  const referenceSourceTree = path.join(skillSourceTree, "references");

  if (!existsSync(referenceSourceTree)) {
    return [];
  }

  return [
    {
      sourcePath: referenceSourceTree,
      targetPath: flatSupportingLinkPath(target)
    }
  ];
}

function assertFlatLinksCanBeManaged(
  target: ResolvedSkillInstallTarget,
  links: FlatSkillLink[],
  previousManifest: FlatSkillManifest | null,
  adoptedLinks: ReadonlyMap<string, string> = new Map()
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

    if (
      currentTarget !== link.sourcePath &&
      currentTarget !== previousLinks.get(link.name) &&
      currentTarget !== adoptedLinks.get(linkPath)
    ) {
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

  return unwrapBoundaryResult(
    FlatSkillManifestSchema.refine(
      (manifest) =>
        (manifest.supportingLinks ?? []).every(
          (link) => link.targetPath === flatSupportingLinkPath(target)
        ),
      "Supporting links must target the Agent skill root's sibling references directory"
    ).safeParse(rawManifest),
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

function prepareSkillTargetPlan(
  target: ResolvedSkillInstallTarget,
  skillSourceTree: string,
  adoptedLinks: ReadonlyMap<string, string> = new Map(),
  legacyContext?: LegacyNamespaceContext
) {
  const policy = skillTargetPolicy(target);

  if (policy.layout === "flat") {
    const links = discoverFlatSkillLinks(skillSourceTree);
    const supportingLinks = discoverFlatSupportingLinks(target, skillSourceTree);

    return {
      preflight() {
        preflightFlatTarget(target, links, supportingLinks, adoptedLinks);
      },
      reconcile() {
        reconcileFlatTarget(target, links, supportingLinks);
      }
    };
  }

  const sourceFolders =
    target.kind === "codex" ? CODEX_NAMESPACE_SOURCE_FOLDERS : SHARED_NAMESPACE_SOURCE_FOLDERS;

  const links = discoverNamespaceLinks(skillSourceTree, sourceFolders);
  const resolvedLegacyContext = legacyContext ?? { skillSourceTree };

  return {
    preflight() {
      preflightNamespaceTarget(target, links, resolvedLegacyContext);
    },
    reconcile() {
      reconcileNamespaceTarget(target, links, resolvedLegacyContext);
    }
  };
}

function skillTargetPolicy(target: ResolvedSkillInstallTarget) {
  const layout = usesFlatSkillLayout(target.kind) ? "flat" : "namespace";

  return {
    layout,
    managedLocation: layout === "flat" ? target.agentSkillRoot : target.namespacePath
  };
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
