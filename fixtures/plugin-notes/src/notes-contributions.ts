import { fileURLToPath } from "node:url";

import { noteAccess, userAccess } from "./notes-access.js";

export const notesContributions = {
  migrations: [
    {
      directory: fileURLToPath(new URL("../src/migrations/", import.meta.url)),
    },
  ],
  access: [userAccess, noteAccess],
  audit: { untrackedTables: ["notes_read_marks"] },
};
