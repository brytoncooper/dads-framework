import { definePlugin } from "@dads-framework/plugin";

import { notesData } from "../notes-data.js";
import { notesRoutes } from "../notes-routes.js";

export const customerNotes = definePlugin({
  name: "customer-notes",
  requires: [notesData],
  setup: ({ use }) => ({ routes: notesRoutes(use(notesData)) }),
});
