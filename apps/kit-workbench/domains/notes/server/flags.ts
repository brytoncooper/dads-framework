import { defineFeatureFlag } from "@dads-framework/feature-flags";
import { notesExport } from "../contract/index.js";
import { noteFlagCopy } from "../copy/flag-metadata.js";

export const notesExportFlag = defineFeatureFlag({
  slug: notesExport,
  name: "Notes export",
  description: noteFlagCopy["notes.export.description"].en,
  owner: "Notes",
  defaultEnabled: false,
  affectedPages: [],
  affectedApiCapabilities: [notesExport],
  cleanupTrigger: "The export capability reaches every tenant.",
  globalStabilityDays: 14,
});
