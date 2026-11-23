import { defineJob, intervalSchedule } from "@dads-framework/job-queue";
import { definePlugin } from "@dads-framework/core/plugin";
import { z } from "zod";

import { clockService } from "./clock-service.js";
import { notesContributions } from "./notes-contributions.js";
import { notesRoutes } from "./notes-routes.js";
import { NotesStore } from "./notes-store.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** What the notes plugin offers other plugins: a count, never its store. */
export type NotesApi = {
  readonly countNotes: () => number;
  readonly write: (id: string, text: string) => void;
};

const pruneJobPayload = z.object({ keepDays: z.number().int().positive() });

/**
 * The example plugin: one route, one migration, one access definition, one
 * job, and one effect on its scope.
 */
export const notesPlugin = definePlugin({
  name: "notes",
  requires: [clockService],
  contributes: notesContributions,
  setup: ({ scope, use }) => {
    const clock = use(clockService);
    const store = new NotesStore();
    scope.interval(() => {
      store.pruneBefore(new Date(clock.now().getTime() - 30 * DAY_MS));
    }, DAY_MS);
    const pruneJob = defineJob({
      name: "notes.prune",
      payload: pruneJobPayload,
      retry: { attempts: 3, backoffMs: 1_000 },
      schedules: [
        intervalSchedule({
          id: "notes.prune.daily",
          everyMs: DAY_MS,
          payload: { keepDays: 30 },
        }),
      ],
      run: ({ keepDays }) => {
        store.pruneBefore(new Date(clock.now().getTime() - keepDays * DAY_MS));
        return Promise.resolve();
      },
    });
    const provides: NotesApi = {
      countNotes: () => store.count(),
      write: (id, text) => {
        store.write({ id, text, writtenAt: clock.now() });
      },
    };
    return { provides, routes: notesRoutes(store), jobs: [pruneJob] };
  },
});
