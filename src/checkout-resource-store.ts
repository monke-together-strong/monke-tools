import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

import * as z from "zod";

import { MonkeError } from "./errors.ts";
import { samePath } from "./path-identity.ts";
import { hashKey } from "./runtime.ts";
import { ResourceCommandStateSchema, ResourceValueStateSchema } from "./state-schema.ts";
import type { ResourceCommandConfig, ResourceValueState, SessionState } from "./types.ts";

export const ResourceOwnerSchema = z.object({
  checkoutPath: z.string().refine(path.isAbsolute),
  id: z.string().min(1),
  session: z.string().optional(),
  sourceRoot: z.string().refine(path.isAbsolute)
});
const CheckoutResourcesSchema = z.strictObject({
  legacyCleanupCommand: z.string().optional(),
  owner: ResourceOwnerSchema,
  releasedLegacyCleanup: z.string().optional(),
  resourceCommandOutputs: z.array(ResourceCommandStateSchema),
  resourceValues: z.array(ResourceValueStateSchema),
  version: z.literal(1)
});
export type ResourceOwner = z.infer<typeof ResourceOwnerSchema>;
export type CheckoutResources = z.infer<typeof CheckoutResourcesSchema>;

export function resourceOwner(
  sourceRoot: string,
  checkoutPath: string,
  session?: string
): ResourceOwner {
  const source = path.normalize(sourceRoot);
  const checkout = path.normalize(checkoutPath);
  return {
    checkoutPath: checkout,
    id: hashKey(JSON.stringify([source, checkout])).slice(0, 32),
    sourceRoot: source,
    ...(session ? { session } : {})
  };
}

/** One authority for source and Session allocations. Empty records also supersede legacy state. */
export class CheckoutResourceStore {
  constructor(
    readonly home: string,
    private readonly legacyStates: SessionState[] = []
  ) {}

  private legacyRecords(): CheckoutResources[] {
    return this.legacyStates.flatMap((state) =>
      state.repos.flatMap((repo) => {
        if (!repo.resourceValues && !repo.resourceCommandOutputs) {
          return [];
        }
        return [
          {
            owner: resourceOwner(repo.sourceRoot, repo.worktreePath, state.session),
            resourceCommandOutputs: repo.resourceCommandOutputs ?? [],
            resourceValues: repo.resourceValues ?? [],
            version: 1 as const,
            ...(repo.cleanupEligible && repo.cleanupCommand
              ? { legacyCleanupCommand: repo.cleanupCommand }
              : {})
          }
        ];
      })
    );
  }

  read(owner: ResourceOwner): CheckoutResources | undefined {
    const file = this.file(owner);
    if (!existsSync(file)) {
      return;
    }
    const record = CheckoutResourcesSchema.parse(JSON.parse(readFileSync(file, "utf-8")));
    if (
      record.owner.id !== owner.id ||
      !samePath(record.owner.sourceRoot, owner.sourceRoot) ||
      !samePath(record.owner.checkoutPath, owner.checkoutPath)
    ) {
      throw new MonkeError(`Resource ownership mismatch at ${file}`);
    }
    return record;
  }

  get(owner: ResourceOwner): CheckoutResources {
    return (
      this.read(owner) ??
      this.legacyRecords().find((record) => record.owner.id === owner.id) ?? {
        owner,
        resourceCommandOutputs: [],
        resourceValues: [],
        version: 1
      }
    );
  }

  save(record: CheckoutResources) {
    const parsed = CheckoutResourcesSchema.parse(record);
    const file = this.file(parsed.owner);
    mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(parsed), { mode: 0o600 });
      renameSync(temporary, file);
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  remove(owner: ResourceOwner) {
    rmSync(this.file(owner), { force: true });
  }

  resourceCommandInput(options: {
    command: ResourceCommandConfig;
    sourceRoot: string;
    worktreePath: string;
  }) {
    const previous = Object.fromEntries(
      options.command.outputs.map((name) => [name, new Set<string>()])
    );
    for (const record of this.list()) {
      if (
        !samePath(record.owner.sourceRoot, options.sourceRoot) ||
        samePath(record.owner.checkoutPath, options.worktreePath)
      ) {
        continue;
      }
      const command = record.resourceCommandOutputs.find(
        (item) => item.name === options.command.name
      );
      for (const output of command?.outputs ?? []) {
        previous[output.env]?.add(output.value);
      }
    }
    return Object.fromEntries(
      Object.entries(previous).map(([name, values]) => [name, [...values].toSorted()])
    );
  }

  resourceValueCollision(options: {
    sourceRoot: string;
    values: ResourceValueState[];
    worktreePath: string;
  }) {
    for (const record of this.list()) {
      if (
        !samePath(record.owner.sourceRoot, options.sourceRoot) ||
        samePath(record.owner.checkoutPath, options.worktreePath)
      ) {
        continue;
      }
      const remembered = new Map(record.resourceValues.map((entry) => [entry.env, entry.value]));
      const collision = options.values.find((value) => remembered.get(value.env) === value.value);
      if (collision) {
        return { ...collision, session: record.owner.session ?? record.owner.checkoutPath };
      }
    }
    return null;
  }

  private list() {
    const directory = path.join(this.home, "resources");
    const records = (existsSync(directory) ? readdirSync(directory) : [])
      .filter((name) => name.endsWith(".json"))
      .map((name) => {
        const record = CheckoutResourcesSchema.parse(
          JSON.parse(readFileSync(path.join(directory, name), "utf-8"))
        );
        if (path.basename(this.file(record.owner)) !== name) {
          throw new MonkeError(`Resource record storage key mismatch: ${name}`);
        }
        return record;
      });
    const ids = new Set(records.map((record) => record.owner.id));
    return [...records, ...this.legacyRecords().filter((record) => !ids.has(record.owner.id))];
  }

  private file(owner: ResourceOwner) {
    return checkoutResourceFile(this.home, owner.sourceRoot, owner.checkoutPath);
  }
}

export function checkoutResourceFile(home: string, sourceRoot: string, checkoutPath: string) {
  return path.join(home, "resources", `${resourceOwner(sourceRoot, checkoutPath).id}.json`);
}
