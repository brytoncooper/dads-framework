#!/usr/bin/env node

import { existsSync, realpathSync } from "node:fs";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const distEntrypoint = new URL("../dist/index.js", import.meta.url);

async function loadOptionalPackage(packageName, purpose) {
  try {
    return await import(packageName);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      (error.code === "ERR_MODULE_NOT_FOUND" ||
        error.code === "MODULE_NOT_FOUND")
    ) {
      throw new Error(
        `Package "${packageName}" is required ${purpose}. Install it with: npm install ${packageName}`,
        { cause: error },
      );
    }
    throw error;
  }
}

function createAuthzedParityClient(v1, client) {
  const consistency = v1.Consistency.create({
    requirement: { oneofKind: "fullyConsistent", fullyConsistent: true },
  });

  const toSubject = (subject) =>
    v1.SubjectReference.create({
      object: v1.ObjectReference.create({
        objectType: subject.type,
        objectId: subject.id,
      }),
      ...(subject.relation ? { optionalRelation: subject.relation } : {}),
    });

  return {
    async check(query) {
      const response = await client.promises.checkPermission(
        v1.CheckPermissionRequest.create({
          resource: v1.ObjectReference.create({
            objectType: query.resource.type,
            objectId: query.resource.id,
          }),
          permission: query.permission,
          subject: toSubject(query.subject),
          consistency,
        }),
      );
      return (
        response.permissionship ===
        v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION
      );
    },
    async lookupResources(query) {
      const responses = await client.promises.lookupResources(
        v1.LookupResourcesRequest.create({
          resourceObjectType: query.resourceType,
          permission: query.permission,
          subject: toSubject(query.subject),
          consistency,
        }),
      );
      return responses
        .filter(
          (item) =>
            item.permissionship === v1.LookupPermissionship.HAS_PERMISSION,
        )
        .map((item) => item.resourceObjectId);
    },
  };
}

export const defaultConnectors = {
  async connectSpiceDb({ endpoint, token, insecure }) {
    const authzed = await loadOptionalPackage(
      "@authzed/authzed-node",
      "to connect to SpiceDB",
    );
    const { v1 } = authzed;
    const security = insecure
      ? v1.ClientSecurity.INSECURE_LOCALHOST_ALLOWED
      : v1.ClientSecurity.SECURE;
    const client = v1.NewClient(token, endpoint, security);
    return {
      source: client,
      parityClient: createAuthzedParityClient(v1, client),
      close: () => {
        client.close();
      },
    };
  },

  async connectPostgres({ databaseUrl }) {
    const pgModule = await loadOptionalPackage("pg", "to connect to Postgres");
    const Pool = pgModule.Pool ?? pgModule.default?.Pool;
    if (typeof Pool !== "function") {
      throw new Error('Loaded "pg" module does not export Pool');
    }
    const pool = new Pool({ connectionString: databaseUrl });
    return {
      executor: pool,
      async createParityClient({ model, namespace }) {
        const pgAccess = await loadOptionalPackage(
          "@dads-framework/postgres-access",
          "for --verify parity checks",
        );
        return new pgAccess.PostgresAuthorization({
          model,
          namespace,
          executor: pool,
        });
      },
      close: () => pool.end(),
    };
  },
};

async function main() {
  if (!existsSync(distEntrypoint)) {
    const message =
      "CLI build files are missing. Run `npm --workspace=@dads-framework/authorization-migration run build` first.";
    process.stderr.write(
      process.argv.includes("--json")
        ? `${JSON.stringify({ ok: false, error: message })}\n`
        : `dads-import-spicedb: ${message}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const { runImportSpiceDbCli } = await import(distEntrypoint.href);
  const result = await runImportSpiceDbCli({
    argv: process.argv.slice(2),
    env: process.env,
    connectors: defaultConnectors,
    writeStdout: (text) => {
      process.stdout.write(text);
    },
    writeStderr: (text) => {
      process.stderr.write(text);
    },
  });
  process.exitCode = result.exitCode;
}

const invokedPath =
  process.argv[1] === undefined ? undefined : realpathSync(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main();
}
