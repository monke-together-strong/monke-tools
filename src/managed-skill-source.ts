import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync
} from "node:fs";
import path from "node:path";

import { stringify } from "yaml";

import { relativeMarkdownLinks } from "../scripts/check-skill-links.ts";
import { importedGuidancePath } from "../scripts/import-guidance.ts";
import { readImportRecipeStore, writeImportRecipeStore } from "../scripts/skill-import-recipes.ts";
import type { SkillImportRecipeStore } from "../scripts/skill-import-recipes.ts";
import { MonkeError } from "./errors.ts";
import { loadGlobalMonkeConfig } from "./global-config.ts";
import { discoverSourceSkillCopies, resolveSkillSourceFolder } from "./local-skill-source.ts";
import { containsPath } from "./path-identity.ts";
import { getHomeDirectory, getMonkeHome } from "./runtime.ts";
import { withSkillPublicationTransaction } from "./skill-publication-transaction.ts";
import { resolveSkillInstallTargets, skillPublicationPaths } from "./skills.ts";
import type { Runtime } from "./types.ts";

type ManagedSkillRequest =
  | { action: "create"; description?: string; name: string }
  | { action: "adopt"; name?: string; skills?: string[]; source: string };

interface AdoptionPlan {
  adoptedPaths: string[];
  copies: string[];
  destination: string;
  original: string;
  registered: boolean;
  slug: string;
}

/** Compare the guidance digest contract plus empty-directory structure, without dereferencing links. */
function skillInventory(root: string) {
  const entries = new Map<string, string>();
  function visit(directory: string) {
    for (const name of readdirSync(directory).toSorted()) {
      const file = path.join(directory, name);
      const relative = path.relative(root, file);
      const stat = lstatSync(file);
      if (stat.isDirectory()) {
        entries.set(relative, "directory");
        visit(file);
      } else if (stat.isFile()) {
        const digest = new Bun.CryptoHasher("sha256").update(readFileSync(file)).digest("hex");
        // oxlint-disable-next-line no-bitwise -- Executable permissions are part of delivered behavior.
        entries.set(relative, `file:${Boolean(stat.mode & 0o111)}:${digest}`);
      } else if (stat.isSymbolicLink()) {
        entries.set(relative, `symlink:${readlinkSync(file)}`);
      } else {
        throw new MonkeError(`Unsupported Skill entry: ${file}`);
      }
    }
  }
  visit(root);
  return entries;
}

/**
 * Detect literal packaged dependencies; dynamic script and plain-text references are outside this
 * check.
 */
function relocationFailures(original: string, destination: string) {
  const root = realpathSync.native(original);
  const failures: string[] = [];
  function visit(directory: string) {
    for (const name of readdirSync(directory)) {
      const file = path.join(directory, name);
      const stat = lstatSync(file);
      if (stat.isDirectory()) {
        visit(file);
      }
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(file);
        const resolved = path.resolve(path.dirname(file), target);
        if (
          path.isAbsolute(target) ||
          !containsPath(root, resolved) ||
          !existsSync(file) ||
          !containsPath(root, realpathSync.native(file))
        ) {
          failures.push(
            `${file} -> ${target}: symlink would not remain self-contained at ${destination}`
          );
        }
      } else if (stat.isFile() && file.endsWith(".md")) {
        for (const link of relativeMarkdownLinks(readFileSync(file, "utf-8"))) {
          const resolved = path.resolve(path.dirname(file), link.destination);
          if (
            !containsPath(root, resolved) ||
            !existsSync(resolved) ||
            !containsPath(root, realpathSync.native(resolved))
          ) {
            failures.push(
              `${file}:${link.line}: ${link.raw} resolves outside the Skill or is missing; relocation to ${destination} cannot preserve it`
            );
          }
        }
      }
    }
  }
  visit(root);
  return failures;
}

function inspectCopies(options: {
  candidates: string[];
  destination: string;
  original: string;
  owner: string | undefined;
  slug: string;
}) {
  const failures: string[] = [];
  const expected = skillInventory(realpathSync.native(options.owner ?? options.original));
  for (const copy of options.candidates) {
    const physical = realpathSync.native(copy);
    const actual = skillInventory(physical);
    const differences = [...new Set([...expected.keys(), ...actual.keys()])].filter(
      (file) => expected.get(file) !== actual.get(file)
    );
    if (differences.length > 0) {
      failures.push(
        `${options.slug}: differing copies ${options.original}${options.owner ? ` (registered owner ${options.owner})` : ""} and ${copy}; differences: ${differences.join(", ")}`
      );
    }
    if (physical !== options.destination) {
      failures.push(
        ...relocationFailures(copy, options.destination).map(
          (failure) => `${options.slug}: ${failure}`
        )
      );
    }
  }
  return failures;
}

interface AdoptionOptions {
  directory: string;
  guidanceRoot: string;
  registryRoot: string;
  runtime: Runtime;
  store: SkillImportRecipeStore;
}

function adoptionTargets(runtime: Runtime) {
  const homeDirectory = getHomeDirectory(runtime);
  const configured = resolveSkillInstallTargets({
    homeDirectory,
    preference: loadGlobalMonkeConfig(getMonkeHome(runtime)).skillInstallPreference ?? {
      targets: []
    }
  });
  const targets = resolveSkillInstallTargets({
    homeDirectory,
    preference: { targets: [{ kind: "claude" }, { kind: "codex" }, { kind: "cursor" }] }
  });
  for (const target of configured) {
    if (!targets.some((item) => item.agentSkillRoot === target.agentSkillRoot)) {
      targets.push(target);
    }
  }
  return { configured, targets };
}

function existingOwner(options: AdoptionOptions, slug: string) {
  const recipe = options.store.recipes.find((item) =>
    item.skills.some((skill) => skill.slug === slug)
  );
  const skill = recipe?.skills.find((item) => item.slug === slug);
  const builtin = ["internal", "codex"]
    .map((category) => path.join(options.guidanceRoot, "skills", category, slug))
    .find((candidate) => existsSync(path.join(candidate, "SKILL.md")));
  return {
    builtin,
    owner: skill ? importedGuidancePath(options.registryRoot, skill) : builtin,
    skill
  };
}

function adoptionProjectionFailures(options: {
  destination: string;
  owner: string | undefined;
  paths: string[];
  slug: string;
}) {
  if (!options.owner) {
    return [];
  }
  return options.paths
    .filter(
      (projection) =>
        existsSync(projection) &&
        realpathSync.native(projection) === options.destination &&
        !lstatSync(projection).isSymbolicLink()
    )
    .map(
      (projection) =>
        `${options.slug}: registered owner occupies ${projection}, which is also the requested incidental projection; preserve the existing source recipe and reconcile that harness layout separately`
    );
}

function planAdoption(options: AdoptionOptions, source: string, selection?: string[]) {
  const root = existsSync(path.join(source, "SKILL.md"))
    ? source
    : resolveSkillSourceFolder(source, true);
  const supplied = discoverSourceSkillCopies(root);
  const selected = [...new Set(selection ?? supplied.map((copy) => path.basename(copy)))];
  if (selected.length === 0) {
    throw new MonkeError(`No skills found in ${root}`);
  }
  const { configured, targets } = adoptionTargets(options.runtime);
  const copies = [...supplied];
  for (const target of targets) {
    if (existsSync(target.agentSkillRoot)) {
      copies.push(...discoverSourceSkillCopies(target.agentSkillRoot));
    }
  }
  const failures: string[] = [];
  const plans: AdoptionPlan[] = [];
  for (const slug of selected) {
    const original = supplied.find((copy) => path.basename(copy) === slug);
    if (!original) {
      failures.push(`${slug}: selected Skill is missing from ${root}`);
      continue;
    }
    if (!/^[a-z\d][a-z\d_-]*$/u.test(slug)) {
      failures.push(`${slug}: invalid folder slug at ${original}`);
      continue;
    }
    const { builtin, owner, skill } = existingOwner(options, slug);
    if (skill?.kind === "reference") {
      failures.push(
        `${slug}: existing registered reference owner ${owner}; keep its recipe and reconcile separately`
      );
      continue;
    }
    const destination = owner ? realpathSync.native(owner) : path.join(options.directory, slug);
    const candidates = [...new Set(copies.filter((copy) => path.basename(copy) === slug))];
    if (owner) {
      candidates.push(owner);
    }
    failures.push(...inspectCopies({ candidates, destination, original, owner, slug }));
    const disposable = candidates.filter((copy) => {
      const physical = realpathSync.native(copy);
      if (
        containsPath(getMonkeHome(options.runtime), copy) ||
        containsPath(path.join(options.guidanceRoot, "skills"), copy)
      ) {
        if (!owner) {
          failures.push(
            `${slug}: unregistered Skill inside managed storage at ${copy}; register it with mt skills add <path> --link, or move it to an external source before adoption`
          );
        }
        return false;
      }
      const target = targets.find((item) => containsPath(item.agentSkillRoot, copy));
      if (owner && physical === destination) {
        if (!lstatSync(copy).isSymbolicLink()) {
          return false;
        }
        if (!target) {
          return false;
        }
        if (containsPath(target.namespacePath, copy)) {
          return false;
        }
        if (
          copy === path.join(target.agentSkillRoot, slug) &&
          lstatSync(copy).isSymbolicLink() &&
          readlinkSync(copy) === owner &&
          (target.kind === "claude" ||
            !configured.some((item) => item.agentSkillRoot === target.agentSkillRoot))
        ) {
          return false;
        }
      }
      // A symlinked collection parent belongs to its external owner. Report instead of deleting through it.
      if (realpathSync.native(path.dirname(copy)) !== path.dirname(copy)) {
        failures.push(
          `${slug}: ${copy} is inside an aliased collection; use an individual Skill alias or linked import to preserve its external source`
        );
        return false;
      }
      return true;
    });
    const adoptedPaths = targets
      .filter(
        (target) =>
          !configured.some((item) => item.agentSkillRoot === target.agentSkillRoot) &&
          candidates.some((copy) => containsPath(target.agentSkillRoot, copy))
      )
      .map((target) => path.join(target.agentSkillRoot, slug));
    failures.push(...adoptionProjectionFailures({ destination, owner, paths: adoptedPaths, slug }));
    if (builtin && !skill && adoptedPaths.length > 0) {
      failures.push(
        `${slug}: bundled Skill owner ${builtin} cannot acquire additional projections; configure that harness explicitly`
      );
    }
    const recorded = skill?.adoptedPaths ?? [];
    plans.push({
      adoptedPaths: adoptedPaths.filter((item) => !recorded.includes(item)),
      copies: disposable,
      destination,
      original,
      registered: Boolean(owner),
      slug
    });
  }
  if (failures.length > 0) {
    throw new MonkeError(
      `Skill adoption preflight failed:\n${failures.join("\n")}\nReconcile these paths outside adoption, then rerun. Use mt skills add <source> --link to keep external dependencies. Checks cover Markdown links and symlinks, not dynamic script dependencies or plain-text references.`
    );
  }
  return plans;
}

/**
 * Publish editable sources using existing linked recipes, preserving recovery through target
 * reconciliation.
 */
export async function acquireManagedSkillSource(options: {
  guidanceRoot: string;
  publish: (directory: string, name: string) => Promise<void>;
  reconcile: () => void;
  registryRoot: string;
  request: ManagedSkillRequest;
  runtime: Runtime;
  store: SkillImportRecipeStore;
}) {
  const { request, runtime, store } = options;
  const source =
    request.action === "adopt"
      ? request.source.startsWith("~/")
        ? path.join(getHomeDirectory(runtime), request.source.slice(2))
        : path.resolve(runtime.cwd, request.source)
      : request.name;
  const name = request.name ?? path.basename(source);
  if (!/^[a-z\d][a-z\d_-]*$/u.test(name)) {
    throw new MonkeError(
      "Use a lowercase Skill source name containing letters, digits, hyphens, or underscores"
    );
  }
  const directory = path.join(getMonkeHome(runtime), "skill-sources", name);
  const plans =
    request.action === "adopt"
      ? planAdoption({ ...options, directory }, source, request.skills)
      : [];
  const newSkills = plans.filter((plan) => !plan.registered);
  const createsSource = request.action === "create" || newSkills.length > 0;
  if (createsSource) {
    if (store.recipes.some((recipe) => recipe.name === name || recipe.source === name)) {
      throw new MonkeError(`Skill source ${name} is already registered`);
    }
    if (lstatSync(directory, { throwIfNoEntry: false })) {
      throw new MonkeError(`Managed Skill source is occupied: ${directory}`);
    }
  }
  if (
    request.action === "adopt" &&
    plans.every(
      (plan) => plan.registered && plan.copies.length === 0 && plan.adoptedPaths.length === 0
    )
  ) {
    runtime.writeStdout(`Unchanged: ${plans.map((plan) => plan.slug).join(", ")}\n`);
    return name;
  }
  const slugs = request.action === "create" ? [name] : plans.map((plan) => plan.slug);
  await withSkillPublicationTransaction(
    getMonkeHome(runtime),
    [
      realpathSync.native(options.registryRoot),
      ...(createsSource ? [directory] : []),
      ...skillPublicationPaths(runtime, options.registryRoot, slugs),
      ...plans.flatMap((plan) => [...plan.copies, ...plan.adoptedPaths])
    ],
    async () => {
      if (request.action === "create") {
        const skill = path.join(directory, name);
        mkdirSync(skill, { recursive: true });
        await Bun.write(
          path.join(skill, "SKILL.md"),
          `---\n${stringify({ description: request.description ?? "TODO: Describe when to use this skill.", name })}---\n\n# ${name}\n\nTODO: Write the skill instructions.\n`
        );
      } else {
        // Stage every physical source before deleting any alias or physical source entry.
        for (const plan of newSkills) {
          mkdirSync(directory, { recursive: true });
          cpSync(realpathSync.native(plan.original), plan.destination, {
            recursive: true,
            verbatimSymlinks: true
          });
        }
        for (const plan of plans) {
          for (const copy of plan.copies) {
            rmSync(copy, { force: true, recursive: true });
          }
        }
      }
      if (createsSource) {
        await options.publish(directory, name);
      }
      const next = readImportRecipeStore(options.registryRoot);
      for (const recipe of next.recipes) {
        for (const skill of recipe.skills) {
          const plan = plans.find((item) => item.slug === skill.slug);
          if (plan && plan.adoptedPaths.length > 0) {
            skill.adoptedPaths = [
              ...new Set([...(skill.adoptedPaths ?? []), ...plan.adoptedPaths])
            ];
          }
        }
      }
      writeImportRecipeStore(options.registryRoot, next);
      options.reconcile();
    }
  );
  runtime.writeStdout(
    `${request.action === "create" ? path.join(directory, name, "SKILL.md") : createsSource ? directory : `Consolidated: ${slugs.join(", ")}`}\n`
  );
  return name;
}
