import { definePlugin } from "@dads-framework/plugin";

import { clockService } from "./clock-service.js";
import { notesContributions } from "./notes-contributions.js";
import { NotesStore } from "./notes-store.js";

/** Shared notes state and metadata. The host must separately select a surface. */
export const notesData = definePlugin({
  name: "notes-data",
  requires: [clockService],
  contributes: notesContributions,
  setup: ({ use }) => {
    const clock = use(clockService);
    const store = new NotesStore();
    return {
      provides: {
        find: (id: string) => store.find(id),
        count: () => store.count(),
        write: (id: string, text: string) => {
          store.write({ id, text, writtenAt: clock.now() });
        },
      },
    };
  },
});
