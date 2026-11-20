/** The Docker edge must refuse ownership collisions, keep secrets out of failures, and accept only one loopback endpoint. */
import { describe, expect, it } from "vitest";
import {
  WorkbenchInfrastructure,
  type DockerCommand,
  type DockerCommandRunner,
} from "./docker-infrastructure.js";

const projectName = `dads-workbench-${"a".repeat(32)}`;
const options = {
  projectName,
  password: "b".repeat(64),
  token: "c".repeat(64),
  adapter: "postgres" as const,
  composeFile: "/workspace/compose.yaml",
};
type Resource = {
  kind: "container" | "network" | "volume";
  name: string;
  id: string;
  labels: Record<string, string>;
};

function resource(
  kind: Resource["kind"],
  suffix: string,
  idCharacter = "d",
): Resource {
  const name = `${projectName}-${suffix}`;
  return {
    kind,
    name,
    id: kind === "volume" ? name : idCharacter.repeat(64),
    labels: {
      "dev.dads.workbench": projectName,
      "com.docker.compose.project": projectName,
      [`com.docker.compose.${kind === "container" ? "service" : kind}`]:
        kind === "volume"
          ? "postgres_data"
          : kind === "network"
            ? "workbench"
            : suffix,
    },
  };
}

function fakeDocker(initial: Resource[] = []) {
  const resources = [...initial];
  const calls: DockerCommand[] = [];
  let mapping = "127.0.0.1:49152\n";
  let failure: Error | undefined;
  let afterUp: (() => void) | undefined;
  const execute = (command: DockerCommand): string => {
    calls.push(command);
    if (failure) throw failure;
    const [kind, action] = command.args;
    if (kind === "info") return "28.0.0\n";
    if (kind === "compose" && action === "version") return "5.3.1\n";
    if (kind === "compose" && command.args.includes("up")) {
      const items = [
        resource("container", "postgres", "d"),
        resource("network", "network", "1"),
        resource("volume", "postgres-data"),
      ];
      if (command.args.includes("--profile"))
        items.splice(
          1,
          0,
          resource("container", "migrate", "e"),
          resource("container", "spicedb", "f"),
        );
      for (const item of items) {
        if (!resources.some((entry) => entry.name === item.name))
          resources.push(item);
      }
      afterUp?.();
      return "";
    }
    if (kind === "port") return mapping;
    if (action === "ls") {
      const filter = command.args.find(
        (arg) => arg.startsWith("label=") || arg.startsWith("name="),
      );
      return resources
        .filter(
          (entry) =>
            entry.kind === kind &&
            (filter?.startsWith("label=")
              ? entry.labels["com.docker.compose.project"] === projectName
              : entry.name.startsWith(`${projectName}-`)),
        )
        .map((entry) => entry.name)
        .join("\n");
    }
    if (action === "inspect") {
      const target = command.args.at(-1);
      const found = resources.find(
        (entry) =>
          entry.kind === kind && (entry.name === target || entry.id === target),
      );
      if (!found) throw new Error("Missing fake resource");
      return JSON.stringify({
        id: found.id,
        name: kind === "container" ? `/${found.name}` : found.name,
        labels: found.labels,
      });
    }
    if (action === "stop") return "";
    if (action === "rm") {
      const index = resources.findIndex(
        (entry) => entry.kind === kind && entry.id === command.args.at(-1),
      );
      if (index < 0) throw new Error("Removed an unknown resource");
      resources.splice(index, 1);
      return "";
    }
    throw new Error(`Unexpected fake command: ${command.args.join(" ")}`);
  };
  const run: DockerCommandRunner = (command) =>
    Promise.resolve().then(() => execute(command));
  return {
    run,
    resources,
    calls,
    setMapping: (value: string) => {
      mapping = value;
    },
    setFailure: (error: Error) => {
      failure = error;
    },
    afterUp: (callback: () => void) => {
      afterUp = callback;
    },
  };
}

describe("workbench Docker ownership", () => {
  it.each(["container", "network", "volume"])(
    "refuses a foreign exact-name %s before start or stop",
    async (kind) => {
      const candidate =
        kind === "container"
          ? resource("container", "postgres")
          : kind === "network"
            ? resource("network", "network")
            : resource("volume", "postgres-data");
      delete candidate.labels["dev.dads.workbench"];
      for (const action of ["start", "stop"]) {
        const fake = fakeDocker([candidate]);
        const infrastructure = new WorkbenchInfrastructure(options, fake.run);
        await expect(
          action === "start" ? infrastructure.start() : infrastructure.stop(),
        ).rejects.toMatchObject({ code: "OWNERSHIP_CONFLICT" });
        expect(
          fake.calls.some(
            (call) =>
              call.args.includes("up") ||
              call.args.includes("rm") ||
              call.args.includes("stop"),
          ),
        ).toBe(false);
      }
    },
  );

  it("refuses an unexpected container with the same Compose project label", async () => {
    const fake = fakeDocker([resource("container", "foreign")]);
    await expect(
      new WorkbenchInfrastructure(options, fake.run).stop(),
    ).rejects.toMatchObject({ code: "OWNERSHIP_CONFLICT" });
    expect(fake.calls.some((call) => call.args.includes("rm"))).toBe(false);
  });

  it.each(["com.docker.compose.project", "com.docker.compose.volume"])(
    "refuses a retained volume with a mismatched %s label",
    async (label) => {
      const volume = resource("volume", "postgres-data");
      volume.labels[label] = "foreign";
      const fake = fakeDocker([volume]);
      await expect(
        new WorkbenchInfrastructure(options, fake.run).start(),
      ).rejects.toMatchObject({ code: "OWNERSHIP_CONFLICT" });
      expect(fake.calls.some((call) => call.args.includes("up"))).toBe(false);
    },
  );

  it("reuses a correctly owned retained volume without removing or replacing it", async () => {
    const volume = resource("volume", "postgres-data");
    const fake = fakeDocker([volume]);
    const infrastructure = new WorkbenchInfrastructure(options, fake.run);
    await infrastructure.start();
    await infrastructure.stop();
    expect(fake.resources).toEqual([volume]);
    await infrastructure.start();
    expect(fake.resources.filter((entry) => entry.kind === "volume")).toEqual([
      volume,
    ]);
  });

  it("refuses an initialized instance with missing authorization data before Compose can create a blank database", async () => {
    const fake = fakeDocker();
    const initialized = { ...options, requireExistingData: true };
    await expect(
      new WorkbenchInfrastructure(initialized, fake.run).start(),
    ).rejects.toMatchObject({ code: "DATA_MISSING" });
    expect(fake.calls.some((call) => call.args.includes("up"))).toBe(false);
    expect(fake.resources).toEqual([]);
  });

  it("allows an initialized instance to start with its exact owned retained volume", async () => {
    const volume = resource("volume", "postgres-data");
    const fake = fakeDocker([volume]);
    const initialized = { ...options, requireExistingData: true };
    await expect(
      new WorkbenchInfrastructure(initialized, fake.run).start(),
    ).resolves.toMatchObject({ adapter: "postgres" });
    expect(fake.resources.filter((entry) => entry.kind === "volume")).toEqual([
      volume,
    ]);
  });

  it("allows scoped partial cleanup even when initialized authorization data is missing", async () => {
    const fake = fakeDocker([
      resource("container", "postgres"),
      resource("network", "network", "1"),
    ]);
    const initialized = { ...options, requireExistingData: true };
    const infrastructure = new WorkbenchInfrastructure(initialized, fake.run);
    await infrastructure.stop();
    await infrastructure.stop();
    expect(fake.resources).toEqual([]);
    expect(fake.calls.some((call) => call.args.includes("up"))).toBe(false);
  });

  it("refuses malformed inspection without exposing raw output or mutating anything", async () => {
    const fake = fakeDocker([resource("network", "network")]);
    const runner: DockerCommandRunner = async (command) => {
      const output = await fake.run(command);
      return command.args.includes("inspect")
        ? `malformed ${options.password} ${options.token}`
        : output;
    };
    const result = await new WorkbenchInfrastructure(options, runner)
      .stop()
      .catch((error: unknown) => error);
    expect(result).toMatchObject({ code: "OWNERSHIP_CONFLICT" });
    expect(String(result)).not.toContain(options.password);
    expect(String(result)).not.toContain(options.token);
    expect(fake.calls.some((call) => call.args.includes("rm"))).toBe(false);
  });

  it("starts with bounded commands and environment-only secrets, then retains data on repeated stop", async () => {
    const fake = fakeDocker();
    const infrastructure = new WorkbenchInfrastructure(options, fake.run);
    await expect(infrastructure.start()).resolves.toMatchObject({
      adapter: "postgres",
    });
    const up = fake.calls.find((call) => call.args.includes("up"));
    expect(up?.args).toEqual(
      expect.arrayContaining(["--pull", "missing", "--wait", "--wait-timeout"]),
    );
    expect(up?.env["DADS_WORKBENCH_PASSWORD"]).toBe(options.password);
    expect(up?.env["DADS_WORKBENCH_TOKEN"]).toBe(options.token);
    expect(
      fake.calls.every(
        (call) => call.timeoutMs > 0 && call.timeoutMs <= 120_000,
      ),
    ).toBe(true);
    expect(JSON.stringify(fake.calls.map((call) => call.args))).not.toContain(
      options.password,
    );
    expect(JSON.stringify(fake.calls.map((call) => call.args))).not.toContain(
      options.token,
    );
    await infrastructure.stop();
    await infrastructure.stop();
    expect(fake.resources.map((entry) => entry.kind)).toEqual(["volume"]);
    for (const call of fake.calls.filter(
      (entry) => entry.args.includes("rm") || entry.args.includes("stop"),
    )) {
      expect(call.args[0]).not.toBe("volume");
      expect(call.args.at(-1)).toMatch(/^[a-f0-9]{64}$/);
      expect(call.args).not.toContain("--force");
      expect(call.args).not.toContain("--remove-orphans");
    }
  });

  it("never exposes credentials in a command failure or nested error", async () => {
    const fake = fakeDocker();
    fake.setFailure(
      new Error(`docker stderr ${options.password} ${options.token}`, {
        cause: { password: options.password },
      }),
    );
    const result = await new WorkbenchInfrastructure(options, fake.run)
      .start()
      .catch((error: unknown) => error);
    expect(result).toBeInstanceOf(Error);
    expect(String(result)).not.toContain(options.password);
    expect(String(result)).not.toContain(options.token);
    expect(JSON.stringify(result)).not.toContain(options.password);
    expect(JSON.stringify(result)).not.toContain(options.token);
  });

  it.each([
    "0.0.0.0:49152",
    "[::]:49152",
    "127.0.0.1:0",
    "127.0.0.1:65536",
    "127.0.0.1:49152\n127.0.0.1:49153",
  ])("rejects invalid published mapping %s", async (mapping) => {
    const fake = fakeDocker();
    fake.setMapping(mapping);
    await expect(
      new WorkbenchInfrastructure(options, fake.run).start(),
    ).rejects.toMatchObject({ code: "INVALID_ENDPOINT" });
  });

  it("validates the project name before issuing any command", () => {
    const fake = fakeDocker();
    expect(
      () =>
        new WorkbenchInfrastructure(
          { ...options, projectName: "foreign-project" },
          fake.run,
        ),
    ).toThrow();
    expect(fake.calls).toEqual([]);
  });

  it("honors cancellation before mutation and after an in-flight creation, allowing scoped cleanup", async () => {
    const cancelled = new AbortController();
    cancelled.abort();
    const untouched = fakeDocker();
    await expect(
      new WorkbenchInfrastructure(options, untouched.run).start(
        cancelled.signal,
      ),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(untouched.calls).toEqual([]);
    const duringUp = new AbortController();
    const partial = fakeDocker();
    partial.afterUp(() => {
      duringUp.abort();
    });
    const infrastructure = new WorkbenchInfrastructure(options, partial.run);
    await expect(infrastructure.start(duringUp.signal)).rejects.toMatchObject({
      code: "CANCELLED",
    });
    await infrastructure.stop();
    expect(partial.resources.map((entry) => entry.kind)).toEqual(["volume"]);
  });

  it("starts SpiceDB only with its explicit Compose profile", async () => {
    const fake = fakeDocker();
    const infrastructure = new WorkbenchInfrastructure(
      { ...options, adapter: "spicedb" },
      fake.run,
    );
    await expect(infrastructure.start()).resolves.toEqual({
      adapter: "spicedb",
      endpoint: "127.0.0.1:49152",
    });
    const up = fake.calls.find((call) => call.args.includes("up"));
    expect(up?.args).toContain("--profile");
    expect(up?.args).toContain("spicedb");
    const port = fake.calls.find((call) => call.args[0] === "port");
    expect(port?.args).toContain("50051/tcp");
    expect(
      fake.resources.filter((entry) => entry.kind === "container"),
    ).toHaveLength(3);
  });

  it("starts the default backend with only its retained Postgres resources", async () => {
    const fake = fakeDocker();
    await new WorkbenchInfrastructure(options, fake.run).start();
    const up = fake.calls.find((call) => call.args.includes("up"));
    expect(up?.args).not.toContain("--profile");
    expect(fake.resources.map((entry) => entry.name)).toEqual([
      `${projectName}-postgres`,
      `${projectName}-network`,
      `${projectName}-postgres-data`,
    ]);
  });
});
