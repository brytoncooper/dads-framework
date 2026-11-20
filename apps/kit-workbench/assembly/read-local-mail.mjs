import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { z } from "zod";

const envelope = z.object({
  to: z.array(z.object({ address: z.string() })),
  subject: z.string(),
  text: z.string(),
});

const spool = process.env["DADS_MAIL_SPOOL_DIR"];
if (!spool) throw new Error("The local mail spool is unavailable.");

async function mailEntries(directory) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (fault) {
    if (
      typeof fault === "object" &&
      fault !== null &&
      "code" in fault &&
      fault.code === "ENOENT"
    )
      return [];
    throw fault;
  }
}

async function readLatestMail(directory) {
  const entries = await mailEntries(directory);
  const files = entries.filter(
    (entry) => entry.isFile() && entry.name.endsWith(".json"),
  );
  const ordered = await Promise.all(
    files.map(async ({ name }) => {
      const path = join(directory, name);
      return { path, updated: (await stat(path)).mtimeMs };
    }),
  );
  ordered.sort((left, right) => right.updated - left.updated);
  return Promise.all(
    ordered
      .slice(0, 20)
      .map(async ({ path }) =>
        envelope.parse(JSON.parse(await readFile(path, "utf8"))),
      ),
  );
}

const mail = await readLatestMail(spool);
if (process.argv.includes("--json")) {
  process.stdout.write(JSON.stringify({ ok: true, mail }) + "\n");
} else if (mail.length === 0) {
  process.stdout.write("No mail has been delivered yet.\n");
} else {
  process.stdout.write(
    mail
      .map(
        ({ to, subject, text }) =>
          `To: ${to.map(({ address }) => address).join(", ")}\nSubject: ${subject}\n\n${text}`,
      )
      .join("\n\n") + "\n",
  );
}
