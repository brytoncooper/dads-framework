import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const { PORT, DADS_FILE_ROOT, DATABASE_URL, DADS_API } = process.env;

if (DADS_API !== "customer" && DADS_API !== "staff")
  throw new Error("Unknown fixture service.");

const file = join(DADS_FILE_ROOT, `${DADS_API}.txt`);
await writeFile(file, process.cwd());

const result = await execute(
  "psql",
  [
    DATABASE_URL,
    "-XAt",
    "-c",
    `CREATE TABLE IF NOT EXISTS app_slot (service text); INSERT INTO app_slot VALUES ('${DADS_API}');`,
  ],
  { env: process.env },
);
if (result.stderr.includes("ERROR"))
  throw new Error("Could not write fixture row.");

const server = createServer(async (_request, reply) => {
  const rows = await execute(
    "psql",
    [
      DATABASE_URL,
      "-XAt",
      "-c",
      "SELECT current_database(),count(*) FROM app_slot",
    ],
    {
      env: process.env,
    },
  );
  reply.setHeader("content-type", "application/json");
  reply.end(
    JSON.stringify({
      worktree: await readFile(file, "utf8"),
      db: rows.stdout.trim(),
    }),
  );
});
server.listen(Number(PORT), "127.0.0.1");
