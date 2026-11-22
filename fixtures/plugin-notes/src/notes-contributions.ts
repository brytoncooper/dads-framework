import { fileURLToPath } from "node:url";

import type { DslNode } from "@dads-framework/access";

import { noteAccess, userAccess } from "./notes-access.js";

const access: readonly DslNode[] = [userAccess, noteAccess];

export const notesContributions = {
  migrations: [
    {
      directory: fileURLToPath(new URL("../src/migrations/", import.meta.url)),
    },
  ],
  access,
  audit: { untrackedTables: ["notes_read_marks"] },
};
