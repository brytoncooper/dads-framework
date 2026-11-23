import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DevConfig } from "./dev-config.js";
import { readSlots, slotDirectory, writeJson, writeSlots, type Slot } from "./slot-state.js";

export async function reserveSlot(root: string, worktree: string, config: DevConfig): Promise<Slot> {
  const slots = await readSlots(root);
  const existing = slots.find((slot) => slot.worktree === worktree);
  const slot = existing ?? (await allocate(worktree, config, slots));
  if (slot.portCount !== config.portsPerSlot)
    throw new Error("The configured block size differs from this checkout's reservation.");
  const updated = { ...slot, lastUsed: Date.now() };
  await writeSlots(root, [...slots.filter((entry) => entry.worktree !== worktree), updated]);
  return updated;
}

async function allocate(worktree: string, config: DevConfig, slots: readonly Slot[]): Promise<Slot> {
  for (let index = 0; index < config.maxSlots; index++) {
    const firstPort = config.basePort + config.portsPerSlot * index;
    const portCount = config.portsPerSlot;
    if (slots.some((slot) => overlaps(slot, firstPort, portCount))) continue;
    if (!(await slotPortsAvailable(firstPort, portCount))) continue;
    return {
      worktree,
      id: randomBytes(12).toString("hex"),
      firstPort,
      portCount,
      lastUsed: Date.now(),
    };
  }
  throw new Error("No free port block is available.");
}

function overlaps(slot: Slot, firstPort: number, portCount: number): boolean {
  return slot.firstPort < firstPort + portCount && firstPort < slot.firstPort + slot.portCount;
}

export async function slotPortsAvailable(firstPort: number, portCount: number): Promise<boolean> {
  const ports = Array.from({ length: portCount }, (_, offset) => firstPort + offset);
  return (await Promise.all(ports.map(portAvailable))).every(Boolean);
}

function portAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => {
      resolve(false);
    });
    server.listen(port, "127.0.0.1", () => {
      server.close(() => {
        resolve(true);
      });
    });
  });
}

export async function prepareSlot(root: string, slot: Slot): Promise<void> {
  const directory = slotDirectory(root, slot);
  await mkdir(join(directory, "files"), { recursive: true, mode: 0o700 });
  const maintenance = maintenanceUrl(process.env["DADS_DEV_POSTGRES_URL"]);
  const databaseName = `dads_${slot.id}`;
  await ensureDatabase(maintenance, databaseName);
  maintenance.pathname = `/${databaseName}`;
  await writeJson(join(directory, "environment.json"), {
    HOST: "127.0.0.1",
    PORT: String(slot.firstPort),
    DATABASE_URL: maintenance.href,
    DADS_FILE_ROOT: join(directory, "files"),
  });
}

function maintenanceUrl(value: string | undefined): URL {
  if (value === undefined || !URL.canParse(value))
    throw new Error("Set DADS_DEV_POSTGRES_URL to a local PostgreSQL maintenance URL.");
  const url = new URL(value);
  if (
    !["postgresql:", "postgres:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.pathname.length <= 1
  ) {
    throw new Error("DADS_DEV_POSTGRES_URL must name a database on loopback.");
  }
  for (const parameter of url.searchParams.keys()) {
    if (parameter !== "sslmode" && parameter !== "connect_timeout") {
      throw new Error("Unsupported PostgreSQL connection option in DADS_DEV_POSTGRES_URL.");
    }
  }
  return url;
}

async function ensureDatabase(url: URL, database: string): Promise<void> {
  const execute = promisify(execFile);
  const psql = async (statement: string) => {
    try {
      return (
        await execute("psql", ["-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", statement], {
          env: {
            PATH: process.env["PATH"],
            HOME: process.env["HOME"],
            PGHOST: url.hostname.replace(/^\[|\]$/g, ""),
            PGPORT: url.port || "5432",
            PGUSER: decodeURIComponent(url.username),
            PGPASSWORD: decodeURIComponent(url.password),
            PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
            PGSSLMODE: url.searchParams.get("sslmode") ?? "prefer",
            PGCONNECT_TIMEOUT: url.searchParams.get("connect_timeout") ?? "3",
          },
          timeout: 15_000,
        })
      ).stdout.trim();
    } catch (error) {
      throw new Error(
        "Could not prepare the slot database. Check psql, the maintenance URL, and CREATE DATABASE privileges.",
        { cause: error },
      );
    }
  };
  if ((await psql(`SELECT datname FROM pg_database WHERE datname = '${database}'`)) !== database) {
    await psql(`CREATE DATABASE "${database}"`);
  }
}
