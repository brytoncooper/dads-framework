import { defineJob } from "@dads-framework/job-queue";
import { definePlugin } from "@dads-framework/plugin";
import { z } from "zod";

import { notesData } from "../notes-data.js";

export const staffNotesJobs = definePlugin({
  name: "staff-notes-jobs",
  requires: [notesData],
  setup: ({ use }) => {
    const notes = use(notesData);
    let lastCount = 0;
    return {
      provides: { lastCount: () => lastCount },
      jobs: [
        defineJob({
          name: "notes.count",
          payload: z.object({}),
          retry: { attempts: 1, backoffMs: 1_000 },
          schedules: [],
          run: () => {
            lastCount = notes.count();
            return Promise.resolve();
          },
        }),
      ],
    };
  },
});
