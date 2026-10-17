import { existsSync, globSync, readFileSync } from "node:fs";
import path from "node:path";

import type { DummyRuleMap, OxlintConfig, OxlintOverride } from "oxlint";
import { selectJsPlugins } from "ultracite/oxlint/js-plugins";
import react from "ultracite/oxlint/react";
import shadcn from "ultracite/oxlint/shadcn";
import tanstack from "ultracite/oxlint/tanstack";
import tanstackReactDoctor from "ultracite/oxlint/tanstack/js-plugins";
import { parse } from "yaml";
import * as z from "zod";

const frameworkNames = ["react", "react-doctor", "shadcn", "tanstack"] as const;

export type Framework = (typeof frameworkNames)[number];

/**
 * Directories each framework preset lints, relative to the config's directory. `"."` covers the
 * whole repository, and `false` declines a framework that a dependency would otherwise require.
 */
export type FrameworkScopes = Partial<Record<Framework, false | readonly string[]>>;

interface FrameworkConfig {
  extends: OxlintConfig[];
  overrides: OxlintOverride[];
  settings: NonNullable<OxlintConfig["settings"]>;
}

interface PlacedPreset {
  directories: string[];
  preset: OxlintConfig;
}

interface FrameworkPresets {
  /** Rule namespaces registered by the presets' JavaScript plugins. */
  jsPluginNamespaces: readonly string[];
  presets: (directories: string[], scopes: FrameworkScopes) => PlacedPreset[];
}

const frameworkPresets: Record<Framework, FrameworkPresets> = {
  react: { jsPluginNamespaces: [], presets: (directories) => [{ directories, preset: react }] },
  "react-doctor": {
    jsPluginNamespaces: ["react-doctor"],
    presets: (directories, scopes) => [
      { directories, preset: selectJsPlugins(["react-doctor"]) },
      // React Doctor's TanStack rules belong where both frameworks apply.
      {
        directories: overlap(directories, normalizeDirectories(scopes.tanstack)),
        preset: tanstackReactDoctor
      }
    ]
  },
  shadcn: {
    jsPluginNamespaces: ["shadcn"],
    presets: (directories) => [{ directories, preset: shadcn }]
  },
  tanstack: {
    jsPluginNamespaces: [],
    presets: (directories) => [{ directories, preset: tanstack }]
  }
};

// A framework package must be covered where it is used. Plugin packages are often installed beside
// the root config rather than in the package they lint, so they only require the framework to be set.
const frameworkDependencies = new Map<string, { coversPackage: boolean; framework: Framework }>([
  ["@shadcn/lint", { coversPackage: false, framework: "shadcn" }],
  ["@tanstack/react-router", { coversPackage: true, framework: "tanstack" }],
  ["@tanstack/react-start", { coversPackage: true, framework: "tanstack" }],
  ["oxlint-plugin-react-doctor", { coversPackage: false, framework: "react-doctor" }],
  ["react", { coversPackage: true, framework: "react" }]
]);

const manifestSchema = z.object({
  dependencies: z.record(z.string(), z.unknown()).optional(),
  devDependencies: z.record(z.string(), z.unknown()).optional(),
  peerDependencies: z.record(z.string(), z.unknown()).optional(),
  workspaces: z
    .union([z.array(z.string()), z.object({ packages: z.array(z.string()).optional() })])
    .optional()
});

type Manifest = z.infer<typeof manifestSchema>;

const pnpmWorkspaceSchema = z.object({ packages: z.array(z.string()).optional() }).nullable();

/**
 * Returns the nearest directory at or above `start` that contains `.git`, or `start` when none
 * does. Vite+ evaluates the config with the invoking directory, which can be a subdirectory of the
 * repository, as the working directory.
 */
export function findRepositoryRoot(start = process.cwd()): string {
  for (let directory = start; ; directory = path.dirname(directory)) {
    if (existsSync(path.join(directory, ".git"))) {
      return directory;
    }

    if (path.dirname(directory) === directory) {
      return start;
    }
  }
}

/** Throws when a package depends on a framework that `scopes` neither covers nor declines. */
export function checkFrameworkCoverage(root: string, scopes: FrameworkScopes) {
  const rootManifest = readManifest(root);

  if (!rootManifest) {
    return;
  }

  const problems = [".", ...workspaceDirectories(root, rootManifest)].flatMap((directory) => {
    const manifestPath = directory === "." ? "package.json" : `${directory}/package.json`;
    const location = directory === "." ? "the repository root" : directory;

    return dependencyNames(readManifest(path.join(root, directory))).flatMap((dependency) => {
      const signal = frameworkDependencies.get(dependency);
      const scope = signal && scopes[signal.framework];

      if (!signal || scope === false) {
        return [];
      }

      if (!signal.coversPackage) {
        return normalizeDirectories(scope).length === 0
          ? [
              `${manifestPath} depends on ${dependency}, but frameworks["${signal.framework}"] lists no directories.`
            ]
          : [];
      }

      return covers(scope ?? [], directory)
        ? []
        : [
            `${manifestPath} depends on ${dependency}, but frameworks["${signal.framework}"] does not cover ${location}.`
          ];
    });
  });

  if (problems.length > 0) {
    throw new Error(
      [
        "Framework presets do not cover these dependencies:",
        ...problems.map((problem) => `- ${problem}`),
        'Set each framework to the directories it lints ("." for the whole repository), or to false to decline it.'
      ].join("\n")
    );
  }
}

/**
 * Applies framework presets. Repository-wide presets extend the config. Directory-scoped presets
 * become overrides, followed by a copy of the root `rules` for their plugins, because Oxlint
 * applies overrides after root rules.
 */
export function resolveFrameworks(scopes: FrameworkScopes, rules: DummyRuleMap): FrameworkConfig {
  const resolved: FrameworkConfig = { extends: [], overrides: [], settings: {} };

  for (const framework of frameworkNames) {
    const directories = normalizeDirectories(scopes[framework]);

    if (directories.length === 0) {
      continue;
    }

    const { jsPluginNamespaces, presets } = frameworkPresets[framework];
    const placed = presets(directories, scopes).filter((entry) => entry.directories.length > 0);

    for (const { directories: presetDirectories, preset } of placed) {
      resolved.settings = { ...resolved.settings, ...preset.settings };

      if (presetDirectories.includes(".")) {
        resolved.extends.push(preset);
      } else {
        resolved.overrides.push(...scopePreset(preset, presetDirectories));
      }
    }

    const scoped = [
      ...new Set(
        placed.flatMap((entry) => (entry.directories.includes(".") ? [] : entry.directories))
      )
    ];

    const plugins = placed.flatMap(({ preset }) => preset.plugins ?? []);
    const namespaces = new Set<string>([...plugins, ...jsPluginNamespaces]);

    const tuning = Object.entries(rules).filter(([rule]) =>
      namespaces.has(rule.split("/")[0] ?? "")
    );

    if (scoped.length > 0 && tuning.length > 0) {
      // A scoped override must list its built-in plugins again for Oxlint to apply their rule changes.
      resolved.overrides.push({
        files: within(scoped, ["**"]),
        plugins,
        rules: Object.fromEntries(tuning)
      });
    }
  }

  return resolved;
}

function scopePreset(preset: OxlintConfig, directories: readonly string[]): OxlintOverride[] {
  const scoped: OxlintOverride = { files: within(directories, ["**"]) };

  if (preset.plugins) {
    scoped.plugins = preset.plugins;
  }

  if (preset.jsPlugins) {
    scoped.jsPlugins = preset.jsPlugins;
  }

  if (preset.rules) {
    scoped.rules = preset.rules;
  }

  return [
    scoped,
    ...(preset.overrides ?? []).map((override) => {
      const nested: OxlintOverride = { ...override, files: within(directories, override.files) };

      if (override.excludeFiles) {
        nested.excludeFiles = within(directories, override.excludeFiles);
      }

      return nested;
    })
  ];
}

function within(directories: readonly string[], globs: readonly string[]): string[] {
  return directories.flatMap((directory) => globs.map((glob) => `${directory}/${glob}`));
}

function normalizeDirectories(scope: FrameworkScopes[Framework]): string[] {
  return (scope === false ? [] : (scope ?? [])).map((directory) =>
    path.posix.normalize(directory).replace(/\/$/u, "")
  );
}

function covers(scope: readonly string[], directory: string): boolean {
  return normalizeDirectories(scope).some(
    (scoped) => scoped === "." || directory === scoped || directory.startsWith(`${scoped}/`)
  );
}

/** Returns the directories covered by both scopes, keeping the narrower directory of each pair. */
function overlap(left: readonly string[], right: readonly string[]): string[] {
  return [
    ...new Set(
      left.flatMap((outer) =>
        right.flatMap((inner) => {
          if (covers([outer], inner)) {
            return [inner];
          }

          return covers([inner], outer) ? [outer] : [];
        })
      )
    )
  ];
}

function readManifest(directory: string): Manifest | undefined {
  const file = path.join(directory, "package.json");

  return existsSync(file)
    ? manifestSchema.parse(JSON.parse(readFileSync(file, "utf-8")))
    : undefined;
}

function dependencyNames(manifest: Manifest | undefined): string[] {
  return Object.keys({
    ...manifest?.dependencies,
    ...manifest?.devDependencies,
    ...manifest?.peerDependencies
  });
}

function workspaceDirectories(root: string, manifest: Manifest): string[] {
  const pnpmWorkspace = path.join(root, "pnpm-workspace.yaml");

  const patterns = [
    ...(Array.isArray(manifest.workspaces)
      ? manifest.workspaces
      : (manifest.workspaces?.packages ?? [])),
    ...(existsSync(pnpmWorkspace)
      ? (pnpmWorkspaceSchema.parse(parse(readFileSync(pnpmWorkspace, "utf-8")))?.packages ?? [])
      : [])
  ];

  const expand = (globs: string[]) =>
    new Set(
      globs
        .flatMap((glob) => globSync(glob, { cwd: root }))
        .map((match) => path.posix.normalize(match.split(path.sep).join("/")))
    );

  const excluded = expand(
    patterns.filter((pattern) => pattern.startsWith("!")).map((pattern) => pattern.slice(1))
  );

  return [...expand(patterns.filter((pattern) => !pattern.startsWith("!")))].filter(
    (directory) =>
      directory !== "." &&
      !excluded.has(directory) &&
      existsSync(path.join(root, directory, "package.json"))
  );
}
