import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { z } from "zod";

const credential = z.string().regex(/^[a-f0-9]{64}$/u);
const optionsSchema = z.strictObject({
  projectName: z.string().regex(/^dads-workbench-[a-f0-9]{32}$/u),
  password: credential,
  token: credential,
  adapter: z.enum(["postgres", "spicedb"]),
  composeFile: z.string().min(1).max(4096).refine(isAbsolute),
  requireExistingData: z.boolean().default(false),
});

/** Credentials are independent random 64-character hex strings. Initialized instances must set requireExistingData; it defaults to false for first startup. */
export type WorkbenchInfrastructureOptions = Readonly<
  z.input<typeof optionsSchema>
>;

export type DockerCommand = {
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
};

export type DockerCommandRunner = (command: DockerCommand) => Promise<string>;

const messages = {
  INVALID_OPTIONS: "Workbench infrastructure options are invalid.",
  DOCKER_UNAVAILABLE:
    "Docker and Docker Compose 2.20 or newer must be available and running.",
  OWNERSHIP_CONFLICT:
    "Refusing Docker resources with unexpected names or ownership labels.",
  DATA_MISSING:
    "Retained workbench authorization data is missing. Refusing to create a blank authorization database; no implicit reset is performed.",
  COMMAND_FAILED:
    "A bounded workbench Docker command failed. Resources and data have not been automatically purged.",
  INVALID_ENDPOINT:
    "The selected workbench backend must publish exactly one valid loopback port.",
  CANCELLED: "Workbench infrastructure operation was cancelled or timed out.",
};

/** Safe diagnostics intentionally omit Docker output, command causes, and credential values. */
export class WorkbenchInfrastructureError extends Error {
  constructor(readonly code: keyof typeof messages) {
    super(messages[code]);
    this.name = "WorkbenchInfrastructureError";
  }
}

type ResourceKind = "container" | "network" | "volume";
type ExpectedResource = { kind: ResourceKind; name: string; role: string };
type OwnedResource = ExpectedResource & { id: string };
const inspectedText = z.string().max(4096);
const inspectedResource = z.object({
  id: inspectedText,
  name: inspectedText,
  labels: z.record(inspectedText, inspectedText).nullable(),
});
const ownerLabel = "dev.dads.workbench";
const composeProjectLabel = "com.docker.compose.project";

export type WorkbenchInfrastructureConnection =
  | { readonly adapter: "postgres"; readonly connectionString: string }
  | { readonly adapter: "spicedb"; readonly endpoint: string };

/** Workbench-only Compose edge. stop removes validated containers/network IDs, never retained volumes. */
export class WorkbenchInfrastructure {
  private readonly options: z.output<typeof optionsSchema>;
  private readonly resources: readonly ExpectedResource[];
  private readonly environment: Readonly<Record<string, string>>;

  constructor(
    options: WorkbenchInfrastructureOptions,
    private readonly runner: DockerCommandRunner = runDockerCommand,
  ) {
    const parsed = optionsSchema.safeParse(options);
    if (!parsed.success)
      throw new WorkbenchInfrastructureError("INVALID_OPTIONS");
    this.options = parsed.data;
    const postgresContainer: ExpectedResource = {
      kind: "container",
      name: `${options.projectName}-postgres`,
      role: "postgres",
    };
    const workbenchNetwork: ExpectedResource = {
      kind: "network",
      name: `${options.projectName}-network`,
      role: "workbench",
    };
    const postgresData: ExpectedResource = {
      kind: "volume",
      name: `${options.projectName}-postgres-data`,
      role: "postgres_data",
    };
    this.resources =
      options.adapter === "spicedb"
        ? [
            postgresContainer,
            {
              kind: "container",
              name: `${options.projectName}-migrate`,
              role: "migrate",
            },
            {
              kind: "container",
              name: `${options.projectName}-spicedb`,
              role: "spicedb",
            },
            workbenchNetwork,
            postgresData,
          ]
        : [postgresContainer, workbenchNetwork, postgresData];
    this.environment = {
      DADS_WORKBENCH_PROJECT: options.projectName,
      DADS_WORKBENCH_PASSWORD: options.password,
      DADS_WORKBENCH_TOKEN: options.token,
      DADS_WORKBENCH_DATASTORE_URI: `postgres://dads:${options.password}@postgres:5432/dads?sslmode=disable`,
      COMPOSE_DISABLE_ENV_FILE: "1",
      COMPOSE_REMOVE_ORPHANS: "0",
      COMPOSE_IGNORE_ORPHANS: "0",
      COMPOSE_MENU: "false",
    };
  }

  async start(
    signal?: AbortSignal,
  ): Promise<WorkbenchInfrastructureConnection> {
    const bounded = AbortSignal.any([
      AbortSignal.timeout(240_000),
      ...(signal ? [signal] : []),
    ]);
    await this.verifyPrerequisites(bounded);
    const existing = await this.inspectOwnership(bounded);
    if (
      this.options.requireExistingData &&
      !existing.some(
        (resource) =>
          resource.kind === "volume" && resource.role === "postgres_data",
      )
    )
      throw new WorkbenchInfrastructureError("DATA_MISSING");
    await this.command(
      [
        "compose",
        "--project-name",
        this.options.projectName,
        "--file",
        this.options.composeFile,
        ...(this.options.adapter === "spicedb" ? ["--profile", "spicedb"] : []),
        "up",
        "--detach",
        "--pull",
        "missing",
        "--quiet-pull",
        "--wait",
        "--wait-timeout",
        "90",
        "--no-build",
      ],
      bounded,
      120_000,
    );
    const owned = await this.inspectOwnership(bounded);
    if (owned.length !== this.resources.length)
      throw new WorkbenchInfrastructureError("OWNERSHIP_CONFLICT");
    const service = owned.find(
      (entry) =>
        entry.kind === "container" &&
        entry.role ===
          (this.options.adapter === "spicedb" ? "spicedb" : "postgres"),
    );
    if (!service) throw new WorkbenchInfrastructureError("OWNERSHIP_CONFLICT");
    const mapping = await this.command(
      [
        "port",
        service.id,
        this.options.adapter === "spicedb" ? "50051/tcp" : "5432/tcp",
      ],
      bounded,
    );
    const port = loopbackPort(mapping);
    if (this.options.adapter === "spicedb")
      return {
        adapter: "spicedb",
        endpoint: `127.0.0.1:${String(port)}`,
      };
    return {
      adapter: "postgres",
      connectionString: `postgresql://dads:${this.options.password}@127.0.0.1:${String(port)}/dads`,
    };
  }

  async stop(): Promise<void> {
    const signal = AbortSignal.timeout(120_000);
    const owned = await this.inspectOwnership(signal);
    for (const container of owned
      .filter((entry) => entry.kind === "container")
      .reverse()) {
      await this.command(
        ["container", "stop", "--time", "10", container.id],
        signal,
        20_000,
      );
      await this.command(["container", "rm", container.id], signal);
    }
    for (const network of owned.filter((entry) => entry.kind === "network"))
      await this.command(["network", "rm", network.id], signal);
  }

  private async verifyPrerequisites(signal: AbortSignal): Promise<void> {
    await this.command(
      ["info", "--format", "{{.ServerVersion}}"],
      signal,
      10_000,
      "DOCKER_UNAVAILABLE",
    );
    const version = await this.command(
      ["compose", "version", "--short"],
      signal,
      10_000,
      "DOCKER_UNAVAILABLE",
    );
    const match = /^v?(\d+)\.(\d+)\./.exec(version.trim());
    if (
      !match ||
      Number(match[1]) < 2 ||
      (Number(match[1]) === 2 && Number(match[2]) < 20)
    )
      throw new WorkbenchInfrastructureError("DOCKER_UNAVAILABLE");
  }

  private async inspectOwnership(
    signal: AbortSignal,
  ): Promise<OwnedResource[]> {
    const owned: OwnedResource[] = [];
    const kinds: readonly ResourceKind[] = ["container", "network", "volume"];
    for (const kind of kinds) {
      const expected = this.resources.filter((entry) => entry.kind === kind);
      const names = expected.map((entry) => entry.name).join("|");
      const listedNames = new Set<string>();
      for (const filter of [
        `name=^${kind === "container" ? "/" : ""}(${names})$`,
        `label=${composeProjectLabel}=${this.options.projectName}`,
      ]) {
        const output = await this.command(
          [
            kind,
            "ls",
            ...(kind === "container" ? ["--all"] : []),
            "--filter",
            filter,
            "--format",
            kind === "container" ? "{{.Names}}" : "{{.Name}}",
          ],
          signal,
        );
        for (const name of output.trim().split("\n").filter(Boolean))
          listedNames.add(name);
      }
      for (const name of listedNames) {
        const resource = expected.find((entry) => entry.name === name);
        if (!resource)
          throw new WorkbenchInfrastructureError("OWNERSHIP_CONFLICT");
        owned.push(await this.inspectResource(resource, signal));
      }
    }
    return owned;
  }

  private async inspectResource(
    resource: ExpectedResource,
    signal: AbortSignal,
  ): Promise<OwnedResource> {
    const output = await this.command(
      [
        resource.kind,
        "inspect",
        "--format",
        inspectFormat(resource.kind),
        resource.name,
      ],
      signal,
    );
    const inspected = parseInspectedResource(output);
    assertOwnedResource(resource, inspected, this.options.projectName);
    return { ...resource, id: inspected.id };
  }

  private async command(
    args: readonly string[],
    signal: AbortSignal,
    timeoutMs = 10_000,
    failure: keyof typeof messages = "COMMAND_FAILED",
  ): Promise<string> {
    throwIfCancelled(signal);
    let output: string;
    try {
      output = await this.runner({
        args,
        env: this.environment,
        timeoutMs,
        signal,
      });
    } catch {
      throwIfCancelled(signal);
      throw new WorkbenchInfrastructureError(failure);
    }
    throwIfCancelled(signal);
    return output;
  }
}

/** The Docker inspect template for one kind: its identity, its name, and its labels. */
function inspectFormat(kind: ResourceKind): string {
  const idField = kind === "volume" ? ".Name" : ".Id";
  const labelField = kind === "container" ? ".Config.Labels" : ".Labels";
  return `{"id":{{json ${idField}}},"name":{{json .Name}},"labels":{{json ${labelField}}}}`;
}

/** Unreadable or unexpected inspect output is a refusal, never a partially trusted resource. */
function parseInspectedResource(
  output: string,
): z.output<typeof inspectedResource> {
  let json: unknown;
  try {
    json = JSON.parse(output);
  } catch {
    throw new WorkbenchInfrastructureError("OWNERSHIP_CONFLICT");
  }
  const parsed = inspectedResource.safeParse(json);
  if (!parsed.success)
    throw new WorkbenchInfrastructureError("OWNERSHIP_CONFLICT");
  return parsed.data;
}

/** Name, identity shape, owner label, Compose project, and Compose role must all be ours. */
function assertOwnedResource(
  resource: ExpectedResource,
  inspected: z.output<typeof inspectedResource>,
  projectName: string,
): void {
  const { id, name, labels } = inspected;
  const roleLabel = `com.docker.compose.${resource.kind === "container" ? "service" : resource.kind}`;
  if (
    name.replace(/^\//, "") !== resource.name ||
    (resource.kind === "volume"
      ? id !== resource.name
      : !/^[a-f0-9]{64}$/.test(id)) ||
    labels?.[ownerLabel] !== projectName ||
    labels[composeProjectLabel] !== projectName ||
    labels[roleLabel] !== resource.role
  )
    throw new WorkbenchInfrastructureError("OWNERSHIP_CONFLICT");
}

function throwIfCancelled(signal: AbortSignal): void {
  try {
    signal.throwIfAborted();
  } catch {
    throw new WorkbenchInfrastructureError("CANCELLED");
  }
}

function loopbackPort(mapping: string): number {
  const match = /^127\.0\.0\.1:([0-9]+)$/.exec(mapping.trim());
  const port = Number(match?.[1]);
  if (!match || !Number.isInteger(port) || port < 1 || port > 65_535)
    throw new WorkbenchInfrastructureError("INVALID_ENDPOINT");
  return port;
}

function runDockerCommand(command: DockerCommand): Promise<string> {
  return new Promise((resolve, reject) => {
    let failed = false;
    let output = "";
    const child = execFile(
      "docker",
      [...command.args],
      {
        encoding: "utf8",
        env: { ...process.env, ...command.env },
        timeout: command.timeoutMs,
        maxBuffer: 512 * 1024,
        killSignal: "SIGKILL",
        ...(command.signal ? { signal: command.signal } : {}),
      },
      (error, stdout) => {
        failed = error !== null;
        output = stdout;
      },
    );
    // Abort can invoke execFile's callback before its child has exited. Cleanup
    // must wait for close, including inherited output pipes, before proceeding.
    child.once("close", (code) => {
      if (failed || code !== 0) reject(new Error("Docker command failed."));
      else resolve(output);
    });
  });
}
