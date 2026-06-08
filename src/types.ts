export interface Runtime {
  /** Current working directory used by monke-tools operations. */
  readonly cwd: string;
  /** Process environment used by monke-tools operations. */
  readonly env: Record<string, string | undefined>;
  /** Run a command with the runtime environment. */
  exec(command: string, args?: string[], options?: ExecOptions): ExecResult;
  /** Read one interactive input line after writing a prompt. */
  readLine(prompt: string): string;
  /** Write CLI output to stdout. */
  writeStdout(text: string): void;
  /** Write CLI output to stderr. */
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

export interface RepoConfig {
  sourceRoot: string;
  configPath: string;
  bootstrapCommand?: string;
  seedPaths: string[];
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
