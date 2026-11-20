/**
 * The one disposable Postgres container this proof owns.
 *
 * The container is created with a run-specific ownership label and its name is
 * recorded before Docker is asked for it, so a timeout or a signal between
 * creation and the returned identifier still leaves something cleanup can find.
 * Cleanup re-reads that label and refuses to remove anything this run did not
 * create.
 *
 * `verify-workbench-postgres-integration.mjs` owns the run; the transaction
 * claims it makes live in `verify-workbench-postgres-integration-proof.mjs`.
 */

import { execFile } from "node:child_process";
import process from "node:process";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";

const runFile = promisify(execFile);

export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function createWorkbenchPostgresContainer({
  image,
  runId,
  ownerLabel,
  password,
  cancellation,
  redact,
}) {
  let postgres;

  async function docker(args, { cleanup = false } = {}) {
    try {
      const { stdout } = await runFile("docker", args, {
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 2 * 1024 * 1024,
        signal: cleanup ? undefined : cancellation.signal,
        env: { ...process.env, POSTGRES_PASSWORD: password },
      });
      return stdout;
    } catch (error) {
      throw new Error(redact(errorMessage(error)), { cause: error });
    }
  }

  async function waitUntil(description, action) {
    const deadline = Date.now() + 60_000;
    let lastError;
    while (Date.now() < deadline) {
      cancellation.signal.throwIfAborted();
      try {
        await action();
        return;
      } catch (error) {
        lastError = error;
      }
      await setTimeout(250, undefined, { signal: cancellation.signal });
    }
    throw new Error(
      `Timed out waiting for ${description}: ${errorMessage(lastError)}`,
    );
  }

  async function postgresPort(containerId) {
    const mapping = (await docker(["port", containerId, "5432/tcp"])).trim();
    const match = /^127\.0\.0\.1:([0-9]+)$/.exec(mapping);
    if (!match)
      throw new Error("Postgres must expose exactly one loopback port.");
    const port = Number(match[1]);
    if (!Number.isInteger(port) || port < 1 || port > 65_535)
      throw new Error("Docker returned an invalid Postgres port.");
    return port;
  }

  return {
    /** Whether a container was claimed, so the caller can report cleanup. */
    hasContainer() {
      return postgres !== undefined;
    },

    async verifyPrerequisites() {
      await docker(["info", "--format", "{{.ServerVersion}}"]);
      try {
        await docker(["image", "inspect", image, "--format", "{{.Id}}"]);
      } catch {
        throw new Error(
          `Required Docker image is unavailable. Run: docker pull ${image}`,
        );
      }
    },

    /** Starts the container and returns its loopback connection string. */
    async startPostgres() {
      const name = `${runId}-postgres`;
      postgres = { id: name, name };
      const id = (
        await docker([
          "create",
          "--pull",
          "never",
          "--name",
          name,
          "--label",
          `${ownerLabel}=${runId}`,
          "--publish",
          "127.0.0.1::5432",
          "--env",
          "POSTGRES_USER=dads",
          "--env",
          "POSTGRES_DB=dads",
          "--env",
          "POSTGRES_PASSWORD",
          image,
        ])
      ).trim();
      if (!/^[a-f0-9]{64}$/.test(id))
        throw new Error(
          "Docker returned an invalid Postgres container identifier.",
        );
      postgres.id = id;
      await docker(["start", postgres.id]);
      await waitUntil("Postgres readiness", () =>
        docker([
          "exec",
          postgres.id,
          "pg_isready",
          "-h",
          "127.0.0.1",
          "-U",
          "dads",
          "-d",
          "dads",
        ]),
      );
      const port = await postgresPort(postgres.id);
      return `postgres://dads:${password}@127.0.0.1:${port}/dads`;
    },

    async cleanupOwnedContainer() {
      if (!postgres) return;
      const owner = (
        await docker(
          [
            "container",
            "inspect",
            "--format",
            `{{index .Config.Labels "${ownerLabel}"}}`,
            postgres.id,
          ],
          { cleanup: true },
        )
      ).trim();
      if (owner !== runId)
        throw new Error(
          `Refusing to remove unowned container ${postgres.name}.`,
        );
      await docker(["container", "rm", "--force", postgres.id], {
        cleanup: true,
      });
    },
  };
}
