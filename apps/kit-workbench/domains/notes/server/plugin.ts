import { definePlugin } from "@dads-framework/core/plugin";
import {
  databaseService,
  featureFlagsService,
  jobQueueService,
  objectStorageService,
  protectedWriteService,
} from "../../../libraries/app-runtime/index.js";
import { noteAttachmentJobs, noteAttachmentRoutes } from "./attachments.js";
import { noteExportRoutes } from "./exports.js";
import { notesExportFlag } from "./flags.js";
import { notesRoutes } from "./routes.js";

export const notesPlugin = definePlugin({
  name: "notes",
  requires: [databaseService, featureFlagsService, objectStorageService, jobQueueService, protectedWriteService],
  contributes: { flags: [notesExportFlag] },
  setup: ({ use }) => {
    const db = use(databaseService);
    const flags = use(featureFlagsService);
    const files = use(objectStorageService);
    const jobs = use(jobQueueService);
    const writeWithPermission = use(protectedWriteService);
    return {
      routes: [
        ...notesRoutes({ db, flags, writeWithPermission }),
        ...noteAttachmentRoutes({ files, jobs, writeWithPermission }),
        ...noteExportRoutes({ db, flags }),
      ],
    };
  },
});

export const notesAttachmentWorker = definePlugin({
  name: "notes-attachment-worker",
  requires: [objectStorageService],
  setup: ({ use }) => ({ jobs: noteAttachmentJobs({ files: use(objectStorageService) }) }),
});
