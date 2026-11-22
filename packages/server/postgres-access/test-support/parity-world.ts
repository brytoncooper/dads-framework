import {
  actor,
  allOf,
  anyOf,
  compileAccess,
  permissionToken,
  resource,
  world,
} from "@dads-framework/access";

const userActor = actor("user");
const team = resource("parity/team", {
  roles: { member: userActor },
});
const folder = resource("parity/folder", {
  roles: { team, viewer: team.roles.member },
  can: ({ team: teamRef, viewer }) => ({
    enter: anyOf(teamRef.member, viewer),
  }),
});
const note = resource("parity/note", {
  roles: { folder, shared: userActor.anyone, restricted: userActor },
  can: ({ folder: folderRef, shared, restricted }) => ({
    parent_view: folderRef.enter,
    view: allOf(permissionToken("parity/note", "parent_view"), shared).unless(
      restricted,
    ),
  }),
});

export const model = compileAccess([userActor, team, folder, note]);

export const noteWorld = world(
  "shared notes require folder access and no explicit restriction",
  ({ user, entity, members, write, expect }) => {
    const alice = user("alice");
    const bob = user("bob");
    const claire = user("claire");

    write(team.roles.member, "team1").to(alice);
    write(team.roles.member, "team1").to(bob);
    write(folder.roles.team, "folder1").to(entity(team, "team1"));
    write(folder.roles.viewer, "folder2").to(
      members(team.roles.member, "team1"),
    );
    write(note.roles.folder, "note1").to(entity(folder, "folder1"));
    write(note.roles.folder, "note1").to(entity(folder, "folder2"));
    write(note.roles.folder, "note2").to(entity(folder, "folder2"));
    write(note.roles.folder, "note3").to(entity(folder, "folder1"));
    write(note.roles.shared, "note1").to(userActor.anyone);
    write(note.roles.shared, "note2").to(userActor.anyone);
    write(note.roles.restricted, "note2").to(bob);

    expect(alice).can(note.can.view, "note1");
    expect(alice).can(note.can.view, "note2");
    expect(bob).can(note.can.view, "note1");
    expect(bob).cannot(note.can.view, "note2");
    expect(alice).cannot(note.can.view, "note3");
    expect(claire).cannot(note.can.view, "note1");
  },
);
