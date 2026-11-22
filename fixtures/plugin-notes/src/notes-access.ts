import { actor, resource } from "@dads-framework/access";
import { z } from "zod";

const idSchema = z.string().min(1);

export const userAccess = actor("notes_user", { id: idSchema });

export const userEntity = userAccess.handle;

/** Who may read a note: its author. */
export const noteAccess = resource("notes/note", {
  id: idSchema,
  roles: { author: userAccess },
  can: ({ author }) => ({ view: author }),
});

export const noteEntity = noteAccess.handle;
