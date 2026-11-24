import { resolve } from "node:path";
import type { OptionSpecification } from "../cli-arguments.js";
import { writeCommandSuccess } from "../cli-output.js";
import type { DadTestCommand } from "../dad-test-cli.js";
import { expandTestingManifest } from "../testing-api.js";
import { serializeTestingManifest } from "../testing-manifest.js";
import { writeFilesAtomically } from "../write-files-atomically.js";

const expandOptions: readonly OptionSpecification[] = [
  { name: "--manifest", kind: "value" },
  { name: "--out", kind: "value" },
];

export const expandCommand: DadTestCommand = {
  options: expandOptions,
  execute: async (parsed, io, json) => {
    const manifestPath = parsed.values.get("--manifest");
    const outPath = parsed.values.get("--out");
    const manifest = await expandTestingManifest({
      workspaceRoot: io.cwd,
      ...(manifestPath === undefined ? {} : { manifestPath }),
      ...(io.nativeBinary === undefined ? {} : { nativeBinary: io.nativeBinary }),
    });
    if (outPath !== undefined) {
      writeFilesAtomically([{ path: resolve(io.cwd, outPath), contents: serializeTestingManifest(manifest) }]);
    }
    writeCommandSuccess(io, json, "expand", manifest);
    return 0;
  },
};
