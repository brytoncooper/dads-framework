import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { WorkbenchDevelopmentError } from "./development-error.js";

const hex = (length: number) =>
  z
    .string()
    .length(length)
    .regex(/^[a-f0-9]+$/u);
const storedCredentials = {
  id: hex(32),
  password: hex(64),
  token: hex(64),
  initialized: z.boolean().default(false),
};
const stateV1Schema = z.strictObject({
  version: z.literal(1),
  ...storedCredentials,
});
const stateV2Schema = z.strictObject({
  version: z.literal(2),
  adapter: z.enum(["postgres", "spicedb"]),
  ...storedCredentials,
});

export type DevelopmentAdapter = "postgres" | "spicedb";

export type DevelopmentState = {
  readonly version: 2;
  readonly adapter: DevelopmentAdapter;
  readonly id: string;
  readonly password: string;
  readonly token: string;
  readonly initialized: boolean;
};

export type DevelopmentArguments = {
  readonly action: "up" | "stop" | "help";
  readonly instance: string;
  readonly port: number;
  /** Undefined means use the backend already recorded for an instance. */
  readonly adapter?: DevelopmentAdapter;
};

type DevelopmentAction = "up" | "stop";

/** The values the optional flags carry, before they are joined to an action. */
type DevelopmentFlagValues = {
  readonly instance: string;
  readonly port: number;
  readonly adapter?: DevelopmentAdapter;
};

/** Parse only the app's two lifecycle commands; no implicit resets or path overrides. */
export function parseDevelopmentArguments(args: readonly string[]): DevelopmentArguments {
  if (args.length === 1 && args[0] === "--help") return helpArguments();
  const action = args[0];
  if (action !== "up" && action !== "stop") throw invalidArguments();
  if (args.length === 2 && args[1] === "--help") return helpArguments();
  const flags = readDevelopmentFlags(args, action);
  return {
    action,
    instance: flags.instance,
    port: flags.port,
    ...(flags.adapter ? { adapter: flags.adapter } : {}),
  };
}

function helpArguments(): DevelopmentArguments {
  return { action: "help", instance: "default", port: 4317 };
}

/** Flags arrive as `--name value` pairs; each name is optional and may appear once. */
function readDevelopmentFlags(args: readonly string[], action: DevelopmentAction): DevelopmentFlagValues {
  let flags: DevelopmentFlagValues = { instance: "default", port: 4317 };
  const seen = new Set<string>();
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag || value === undefined || seen.has(flag)) throw invalidArguments();
    seen.add(flag);
    flags = applyDevelopmentFlag(flags, action, flag, value);
  }
  return flags;
}

/** One recognized flag applied to the values so far; anything else is refused. */
function applyDevelopmentFlag(
  flags: DevelopmentFlagValues,
  action: DevelopmentAction,
  flag: string,
  value: string,
): DevelopmentFlagValues {
  if (flag === "--instance") {
    requireInstance(value);
    return { ...flags, instance: value };
  }
  if (flag === "--port" && action === "up") return { ...flags, port: readPort(value) };
  if (flag === "--adapter" && action === "up") return { ...flags, adapter: readAdapter(value) };
  throw invalidArguments();
}

function readPort(value: string): number {
  if (!/^(0|[1-9][0-9]{0,4})$/.test(value) || Number(value) > 65_535) throw invalidArguments();
  return Number(value);
}

function readAdapter(value: string): DevelopmentAdapter {
  if (value !== "postgres" && value !== "spicedb") throw invalidArguments();
  return value;
}

/** Private instance-local files, never an arbitrary user-supplied directory. */
export function prepareDevelopmentDirectory(root: string, instance: string): string {
  requireInstance(instance);
  let directory = root;
  for (const segment of [".dads", "workbench", instance]) {
    directory = join(directory, segment);
    if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
    const metadata = lstatSync(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw invalidState();
    if (segment === instance && (metadata.mode & 0o077) !== 0) throw invalidState();
  }
  return directory;
}

/** Creates credentials once. Invalid existing state is never replaced automatically. */
export function readOrCreateDevelopmentState(
  directory: string,
  adapter: DevelopmentAdapter = "postgres",
): DevelopmentState {
  const path = join(directory, "state.json");
  if (!existsSync(path)) {
    if (existsSync(join(directory, "workbench.sqlite"))) throw invalidState();
    const state: DevelopmentState = {
      version: 2,
      adapter,
      id: randomBytes(16).toString("hex"),
      password: randomBytes(32).toString("hex"),
      token: randomBytes(32).toString("hex"),
      initialized: false,
    };
    writeFileSync(path, `${JSON.stringify(state)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  }
  const parsed = readPrivateJson(path, parseDevelopmentState);
  if (parsed.legacy) writeDevelopmentState(path, parsed.state);
  return parsed.state;
}

/** A state file fixes one backend for the lifetime of its retained data. */
export function resolveDevelopmentAdapter(
  state: DevelopmentState,
  requested: DevelopmentAdapter | undefined,
): DevelopmentAdapter {
  if (requested !== undefined && requested !== state.adapter)
    throw new WorkbenchDevelopmentError(
      "INVALID_STATE",
      `This workbench instance uses ${state.adapter}. Use --instance with a new name for ${requested}.`,
    );
  return state.adapter;
}

/** Missing initialized stores and symlinked SQLite files must never become an implicit reset. */
export function prepareWorkbenchDatabase(directory: string, initialized: boolean): string {
  const path = join(directory, "workbench.sqlite");
  if (!existsSync(path) && initialized) throw invalidState();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const candidate = `${path}${suffix}`;
    if (!existsSync(candidate)) continue;
    const metadata = lstatSync(candidate);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) throw invalidState();
  }
  if (!existsSync(path)) closeSync(openSync(path, "wx", 0o600));
  return path;
}

export function markDevelopmentInitialized(directory: string): void {
  const state = readOrCreateDevelopmentState(directory);
  if (state.initialized) return;
  const temporary = join(directory, `state-${randomBytes(8).toString("hex")}.tmp`);
  writeFileSync(temporary, JSON.stringify({ ...state, initialized: true }), {
    flag: "wx",
    mode: 0o600,
  });
  renameSync(temporary, join(directory, "state.json"));
}

function parseDevelopmentState(value: unknown): {
  readonly state: DevelopmentState;
  readonly legacy: boolean;
} {
  const v2 = stateV2Schema.safeParse(value);
  if (v2.success)
    return {
      state: {
        id: v2.data.id,
        password: v2.data.password,
        token: v2.data.token,
        initialized: v2.data.initialized,
        version: 2,
        adapter: v2.data.adapter,
      },
      legacy: false,
    };
  const v1 = stateV1Schema.safeParse(value);
  if (!v1.success) throw invalidState();
  // SpiceDB was the only supported v1 backend. Do not reinterpret its retained
  // SQLite state or authorization volume as a new same-store instance.
  const state: DevelopmentState = {
    id: v1.data.id,
    password: v1.data.password,
    token: v1.data.token,
    initialized: v1.data.initialized,
    version: 2,
    adapter: "spicedb",
  };
  return {
    state,
    legacy: true,
  };
}

function writeDevelopmentState(path: string, state: DevelopmentState): void {
  const temporary = `${path}-${randomBytes(8).toString("hex")}.tmp`;
  writeFileSync(temporary, JSON.stringify(state), { flag: "wx", mode: 0o600 });
  renameSync(temporary, path);
}

/** SQLite releases this OS-backed lock even after a process crash; no stale PID guessing. */
export function acquireDevelopmentLease(directory: string) {
  const path = join(directory, "lease.sqlite");
  if (existsSync(path) && !lstatSync(path).isFile()) throw invalidState();
  const database = new DatabaseSync(path);
  try {
    database.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    database.close();
    if (error instanceof Error && "errcode" in error && error.errcode === 5)
      throw new WorkbenchDevelopmentError(
        "ALREADY_RUNNING",
        "This workbench instance is running. Stop it first, or use another --instance.",
      );
    throw error;
  }
  let closed = false;
  return {
    close() {
      if (closed) return;
      closed = true;
      database.close();
    },
  };
}

export function readPrivateJson<Value>(path: string, parse: (value: unknown) => Value): Value {
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) throw invalidState();
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parse(value);
  } catch {
    throw invalidState();
  }
}

function requireInstance(value: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(value)) throw invalidArguments();
}

function invalidArguments() {
  return new WorkbenchDevelopmentError(
    "INVALID_ARGUMENT",
    "Use up [--instance name] [--port 0..65535] [--adapter postgres|spicedb], or stop [--instance name].",
  );
}

function invalidState() {
  return new WorkbenchDevelopmentError(
    "INVALID_STATE",
    "Workbench local state is invalid or is not private. It has not been replaced.",
  );
}
