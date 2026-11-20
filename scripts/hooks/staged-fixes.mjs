import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { git } from "./staged-snapshot.mjs";

export function applyStagedFixes(root, scratch, snapshot, before, files) {
  const updates = [];
  for (const path of files.keys()) {
    const { mode, bytes } = files.get(path);
    const fixed = readFileSync(join(snapshot, path));
    if (fixed.equals(bytes)) continue;

    const oid = git(root, ["hash-object", "-w", "--stdin"], {
      input: fixed,
      encoding: "utf8",
    }).trim();
    updates.push(`${mode} ${oid}\t${path}\0`);
  }
  if (git(root, ["write-tree"], { encoding: "utf8" }).trim() !== before) {
    throw new Error("The staged tree changed during checks. Retry the commit.");
  }
  if (updates.length === 0) return;

  const env = { ...process.env, GIT_INDEX_FILE: join(scratch, "fixes.index") };
  git(root, ["read-tree", before], { env });
  git(root, ["update-index", "-z", "--index-info"], {
    env,
    input: updates.join(""),
  });
  const patch = git(
    root,
    [
      "diff",
      "--cached",
      "--binary",
      "--no-ext-diff",
      "--no-textconv",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      before,
    ],
    { env },
  );
  try {
    git(root, ["apply", "--index", "--binary", "--whitespace=nowarn"], {
      input: patch,
      stdio: ["pipe", "inherit", "inherit"],
    });
  } catch {
    throw new Error(
      "Staged fixes could not be applied. Format and lint the affected files, then stage only the intended changes.",
    );
  }
}
