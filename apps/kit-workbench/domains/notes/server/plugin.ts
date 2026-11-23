import { definePlugin } from "@dads-framework/core/plugin";
import { starterServices } from "../../../libraries/app-runtime/index.js";
import { noteAttachmentJobs, noteAttachmentRoutes } from "./attachments.js";
import { noteExportRoutes } from "./exports.js";
import { notesExportFlag } from "./flags.js";
import { notesRoutes } from "./routes.js";

export const notesPlugin = definePlugin({
  name: "notes",
  requires: [starterServices],
  contributes: { flags: [notesExportFlag] },
  setup: ({ use }) => {
    const services = use(starterServices);
    return {
      routes: [...notesRoutes(services), ...noteAttachmentRoutes(services), ...noteExportRoutes(services)],
    };
  },
});

export const notesAttachmentWorker = definePlugin({
  name: "notes-attachment-worker",
  requires: [starterServices],
  setup: ({ use }) => ({ jobs: noteAttachmentJobs(use(starterServices)) }),
});
