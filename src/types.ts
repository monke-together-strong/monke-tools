export interface Runtime {
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
  exec(command: string, args?: string[], options?: ExecOptions): ExecResult;
  writeStdout(text: string): void;
  writeStderr(text: string): void;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  allowFailure?: boolean;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RepoContext {
  cwd: string;
  worktreeRoot: string;
  sourceRoot: string;
  gitCommonDir: string;
  currentBranch: string;
  isSourceCheckout: boolean;
  sessionName: string | null;
}

export interface LocalMapping {
  targetApp: string;
  targetEnv: string;
  portKey: string;
}

export interface ExternalMapping {
  dependencyLabel: string;
  dependencyRoot: string;
  portKey: string;
  targetApp: string;
  targetEnv: string;
}

export interface AppConfig {
  label: string;
  relativePath: string;
  relativeEnvFile: string;
  absoluteAppPath: string;
  localMappings: LocalMapping[];
}

export interface ExternalRepoConfig {
  label: string;
  relativePath: string;
  pathEnv: string;
  absoluteRepoRoot: string;
  mappings: ExternalMapping[];
}

/** A deterministic Resource value declared by one repo in monke.yml. */
export interface ResourceValueConfig {
  /** Uppercase environment variable name written to the session root .env. */
  env: string;
  /** Literal value template supporting ${session} and ${user}. */
  literal: string;
}

/** A resolved Resource value remembered in Session state. */
export interface ResourceValueState {
  /** Uppercase environment variable name for the resource. */
  env: string;
  /** Resolved non-empty value for the current session. */
  value: string;
}

export interface RepoConfig {
  sourceRoot: string;
  configPath: string;
  bootstrapCommand?: string;
  /** Repo-owned command run during Cleanup for dead session worktrees. */
  cleanupCommand?: string;
  seedPaths: string[];
  /** Deterministic Resource values declared by this repo, in YAML order. */
  resourceValuesInOrder: ResourceValueConfig[];
  appsInOrder: AppConfig[];
  appsByLabel: Map<string, AppConfig>;
  externalInOrder: ExternalRepoConfig[];
  localPortOrder: string[];
  localMappingsByPort: Map<string, LocalMapping[]>;
  externalMappingsInOrder: ExternalMapping[];
  externalTargetApps: Set<string>;
}

export interface ResolvedGraph {
  rootSourceRoot: string;
  reposInMaterializationOrder: RepoConfig[];
  reposByRoot: Map<string, RepoConfig>;
}

export interface RepoReservation {
  version: 1;
  sourceRoot: string;
  blockStart: number;
  size: number;
}

export interface AssignedPort {
  key: string;
  value: number;
}

export interface SessionRepoState {
  sourceRoot: string;
  worktreePath: string;
  assignedPorts: AssignedPort[];
  /** Deterministic Resource values remembered for this repo and session. */
  resourceValues?: ResourceValueState[];
}

export interface SessionState {
  version: 1;
  rootSourceRoot: string;
  session: string;
  repos: SessionRepoState[];
}

export interface RepoMaterializationResult {
  state: SessionRepoState;
  localAssignments: Map<string, number>;
}
