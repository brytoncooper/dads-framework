import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { emitZedForDefinitions } from "./vendor/access/core/emit-zed.js";
import { boundaryVerificationModel } from "./compiled/access.js";

const outputRoot = globalThis.process.env["DADS_VERIFICATION_OUTPUT_DIR"];
if (!outputRoot) throw new Error("Missing controlled output directory.");
writeFileSync(
  join(outputRoot, "policy.json"),
  JSON.stringify(emitZedForDefinitions(boundaryVerificationModel)),
);
