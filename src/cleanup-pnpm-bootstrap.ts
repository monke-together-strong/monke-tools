import { parseDocument } from "yaml";
import * as z from "zod";

// pnpm 12.1.0's JS launcher removes these native-launcher entries from its
// bootstrap document even for --version. Never execute a package manager here.
const blocks = [
  "      '@pnpm/exe':\n        specifier: 12.1.0\n        version: 12.1.0\n",
  "  '@pnpm/exe@12.1.0':\n    resolution: {integrity: sha512-7oghYElCSMURxcBNik6rvOXViwzI8xUsr5VFYlr9xAupSKY9F0L89P+LvlLo4bMSkVo7a4OmpuK9pzYTwYlYCg==}\n    engines: {node: '>=18.*'}\n    hasBin: true\n\n",
  "  '@pnpm/exe@12.1.0':\n    optionalDependencies:\n      '@pnpm/exe.darwin-arm64': 12.1.0\n      '@pnpm/exe.darwin-x64': 12.1.0\n      '@pnpm/exe.linux-arm64': 12.1.0\n      '@pnpm/exe.linux-arm64-musl': 12.1.0\n      '@pnpm/exe.linux-x64': 12.1.0\n      '@pnpm/exe.linux-x64-musl': 12.1.0\n      '@pnpm/exe.win32-arm64': 12.1.0\n      '@pnpm/exe.win32-x64': 12.1.0\n\n"
];

const version = z.literal("12.1.0");
const dependency = z.strictObject({ specifier: version, version });
const bootstrapSchema = z.strictObject({
  importers: z.strictObject({
    ".": z.strictObject({
      configDependencies: z.strictObject({}),
      packageManagerDependencies: z.strictObject({ "@pnpm/exe": dependency, pnpm: dependency })
    })
  }),
  lockfileVersion: z.literal("9.0"),
  packages: z.record(z.string(), z.record(z.string(), z.unknown())),
  snapshots: z.record(z.string(), z.record(z.string(), z.unknown()))
});

export const pnpmBootstrapManifestSchema = z.object({ packageManager: z.string() });
type PnpmBootstrapManifest = z.infer<typeof pnpmBootstrapManifestSchema>;

/** Recognize only the reproduced directional bootstrap edit; preserve every application byte. */
export function isPnpmBootstrapDeletion(
  before: string,
  after: string,
  manifest: PnpmBootstrapManifest
) {
  if (
    !/^pnpm@12\.1\.0(?:\+sha512\.[\da-f]+)?$/u.test(manifest.packageManager) ||
    !before.startsWith("---\nlockfileVersion: '9.0'\n")
  ) {
    return false;
  }
  const boundary = before.indexOf("\n---\n", 4);
  if (boundary === -1) {
    return false;
  }
  let bootstrap = before.slice(0, boundary);
  try {
    const document = parseDocument(bootstrap);
    if (document.errors.length > 0 || document.warnings.length > 0) {
      return false;
    }
    const parsed = bootstrapSchema.safeParse(document.toJS({ maxAliasCount: 0 }));
    if (
      !parsed.success ||
      !parsed.data.packages["@pnpm/exe@12.1.0"] ||
      !parsed.data.snapshots["@pnpm/exe@12.1.0"]
    ) {
      return false;
    }
  } catch {
    return false;
  }
  const sections = ["\nimporters:\n", "\npackages:\n", "\nsnapshots:\n"];
  for (const [index, block] of blocks.entries()) {
    const start = bootstrap.indexOf(sections[index] ?? "");
    const end = index < 2 ? bootstrap.indexOf(sections[index + 1] ?? "") : bootstrap.length;
    const position = bootstrap.indexOf(block);
    if (
      start === -1 ||
      position <= start ||
      position >= end ||
      bootstrap.includes(block, position + 1)
    ) {
      return false;
    }
    bootstrap = bootstrap.slice(0, position) + bootstrap.slice(position + block.length);
  }
  return bootstrap + before.slice(boundary) === after;
}
