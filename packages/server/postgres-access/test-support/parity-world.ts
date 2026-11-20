import {
  access,
  accessModel,
  both,
  entityHandle,
  excluding,
  membersOf,
  permissionToken,
  through,
  wildcard,
  world,
} from "@dads-framework/access";
import { z } from "zod";

const idSchema = z.string();
const userEntity = entityHandle({ wireName: "user", idSchema });
const team = entityHandle({ wireName: "parity/team", kind: "scope", idSchema });
const folder = entityHandle({
  wireName: "parity/folder",
  kind: "scope",
  idSchema,
});
const note = entityHandle({
  wireName: "parity/note",
  kind: "record",
  idSchema,
});

const userAccess = access(userEntity, { roles: {}, permissions: () => ({}) });
const teamAccess = access(team, {
  roles: { member: userEntity },
  permissions: () => ({}),
});
const folderAccess = access(folder, {
  roles: { team, viewer: membersOf(teamAccess.roles.member) },
  permissions: (roles) => ({
    enter: [through(roles.team, teamAccess.roles.member), roles.viewer],
  }),
});
const noteAccess = access(note, {
  roles: { folder, shared: wildcard(userEntity), restricted: userEntity },
  permissions: (roles) => ({
    parent_view: [through(roles.folder, folderAccess.permissions.enter)],
    view: [
      excluding(
        both(permissionToken(note.wireName, "parent_view"), roles.shared),
        roles.restricted,
      ),
    ],
  }),
});

export const model = accessModel([
  userAccess,
  teamAccess,
  folderAccess,
  noteAccess,
]);

export const noteWorld = world(
  "shared notes require folder access and no explicit restriction",
  ({ user, entity, members, write, expect }) => {
    const alice = user("alice");
    const bob = user("bob");
    const claire = user("claire");

    write(teamAccess.roles.member, "team1").to(alice);
    write(teamAccess.roles.member, "team1").to(bob);
    write(folderAccess.roles.team, "folder1").to(entity(team, "team1"));
    write(folderAccess.roles.viewer, "folder2").to(
      members(teamAccess.roles.member, "team1"),
    );
    write(noteAccess.roles.folder, "note1").to(entity(folder, "folder1"));
    write(noteAccess.roles.folder, "note1").to(entity(folder, "folder2"));
    write(noteAccess.roles.folder, "note2").to(entity(folder, "folder2"));
    write(noteAccess.roles.folder, "note3").to(entity(folder, "folder1"));
    write(noteAccess.roles.shared, "note1").to(wildcard(userEntity));
    write(noteAccess.roles.shared, "note2").to(wildcard(userEntity));
    write(noteAccess.roles.restricted, "note2").to(bob);

    expect(alice).can(noteAccess.permissions.view, "note1");
    expect(alice).can(noteAccess.permissions.view, "note2");
    expect(bob).can(noteAccess.permissions.view, "note1");
    expect(bob).cannot(noteAccess.permissions.view, "note2");
    expect(alice).cannot(noteAccess.permissions.view, "note3");
    expect(claire).cannot(noteAccess.permissions.view, "note1");
  },
);
