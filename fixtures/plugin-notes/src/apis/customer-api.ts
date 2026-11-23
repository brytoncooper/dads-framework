import { composeApi } from "@dads-framework/core/plugin";

import { notesData } from "../notes-data.js";
import { customerNotes } from "../surfaces/customer-notes.js";
import { apiClock } from "./host-clock.js";

/** Composition root for the customer HTTP server. */
export const customerApi = composeApi("customer", {
  services: [apiClock, notesData],
  routes: [customerNotes],
  jobs: [],
});
