import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readProtectedDocument } from "./compiled/read-document.js";

const outputRoot = globalThis.process.env["DADS_VERIFICATION_OUTPUT_DIR"];
if (!outputRoot) throw new Error("Missing controlled output directory.");
const policyJson = readFileSync("verification/generated/policy.json", "utf8");

assert.equal(
  await readProtectedDocument({
    policyJson,
    readers: [],
    userId: "alice",
    documentId: "document-1",
  }),
  undefined,
  "Relationship-free access was granted.",
);
assert.equal(
  await readProtectedDocument({
    policyJson,
    readers: [{ userId: "alice", documentId: "document-1" }],
    userId: "alice",
    documentId: "document-1",
  }),
  "document:document-1",
  "The serialized policy did not grant the declared reader.",
);

writeFileSync(
  join(outputRoot, "consumer-result.json"),
  `${JSON.stringify({ denied: true, granted: true })}\n`,
);
