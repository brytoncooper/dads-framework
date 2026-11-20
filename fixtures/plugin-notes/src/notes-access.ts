import { access, entityHandle } from "@dads-framework/access";
import { z } from "zod";

const idSchema = z.string().min(1);

export const userEntity = entityHandle({ wireName: "notes_user", idSchema });

export const noteEntity = entityHandle({
  wireName: "notes/note",
  idSchema,
  kind: "record",
});

export const userAccess = access(userEntity, {
  roles: {},
  permissions: () => ({}),
});

/** Who may read a note: its author. */
export const noteAccess = access(noteEntity, {
  roles: { author: userEntity },
  permissions: (roles) => ({ view: [roles.author] }),
});
