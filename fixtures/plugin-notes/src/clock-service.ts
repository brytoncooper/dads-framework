import { defineService } from "@dads-framework/core/plugin";

/** What the notes plugin needs from the host to stamp and prune notes. */
export type NotesClock = { readonly now: () => Date };

/** Implemented by the host (`providePlugin`), never by the notes plugin. */
export const clockService = defineService("clock").ofType<NotesClock>();
