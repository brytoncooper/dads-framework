import { composeApi } from "@dads-framework/core/plugin";

import { notesData } from "../notes-data.js";
import { staffNotesJobs } from "../surfaces/staff-notes-jobs.js";
import { staffNotes } from "../surfaces/staff-notes.js";
import { apiClock } from "./host-clock.js";

/** Composition root for the staff HTTP server and its job worker. */
export const staffApi = composeApi("staff", {
  services: [apiClock, notesData],
  routes: [staffNotes],
  jobs: [staffNotesJobs],
});
