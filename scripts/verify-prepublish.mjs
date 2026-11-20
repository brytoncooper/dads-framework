/** npm publish must have full, uncached proof for the current checkout. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";
import { verifyReleaseArtifacts } from "./release/pack-preflight.mjs";
import { captureProof, hasProof } from "./verify-receipt.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const current = captureProof(root);
if (current === null || !hasProof(root, current.committed, current.key, true)) {
  process.stderr.write(
    "Publish requires a full, uncached receipt for this committed checkout. Run npm run verify:release, then retry npm publish.\n",
  );
  process.exitCode = 1;
} else {
  try {
    const manifest = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf8"),
    );
    if (typeof manifest.name !== "string" || manifest.name.length === 0) {
      throw new Error("The workspace package has no name.");
    }
    verifyReleaseArtifacts(root, manifest.name);
  } catch {
    process.stderr.write(
      "Publish refused because the local package archive did not pass release preflight.\n",
    );
    process.exitCode = 1;
  }
}
