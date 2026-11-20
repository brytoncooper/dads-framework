import { createCopyHook, defineCopy, type CopyKey } from "@dads-framework/copy";

export const workbenchCopy = defineCopy({
  "workbench.brand": { en: "Dads Workbench" },
  "workbench.title.signedOut": { en: "A workspace for your notes." },
  "workbench.title.signedIn": { en: "Your workspaces" },
  "workbench.starter": { en: "Dads starter app" },
  "workbench.summary": {
    en: "Keep notes organized by workspace and invite collaborators to join.",
  },
  "workbench.links": { en: "Workbench links" },
  "workbench.apiHealth": { en: "API health" },
  "workbench.session.loading": { en: "Checking session…" },
  "workbench.auth.signOut": { en: "Sign out" },
  "workbench.auth.signIn": { en: "Sign in" },
  "workbench.auth.createTitle": { en: "Create an account" },
  "workbench.auth.create": { en: "Create account" },
  "workbench.auth.existing": { en: "Use an existing account" },
  "workbench.auth.invitationEmail": {
    en: "Use the email address on your invitation.",
  },
  "workbench.auth.verify": {
    en: "Check your email for the verification link. In local development, run npm run dev:mail to read the message.",
  },
  "workbench.auth.name": { en: "Name" },
  "workbench.auth.email": { en: "Email" },
  "workbench.auth.password": { en: "Password" },
  "workbench.tenant.controls": { en: "Workspace controls" },
  "workbench.tenant.title": { en: "Workspaces" },
  "workbench.tenant.loading": { en: "Loading workspaces…" },
  "workbench.tenant.active": { en: "Active workspace" },
  "workbench.tenant.name": { en: "New workspace name" },
  "workbench.tenant.create": { en: "Create workspace" },
  "workbench.tenant.emptyTitle": { en: "Your notes will appear here" },
  "workbench.tenant.emptyBody": {
    en: "Create a workspace or accept an invitation to start.",
  },
  "workbench.invite.title": { en: "Workspace invitation" },
  "workbench.invite.accept": { en: "Accept invitation" },
  "workbench.invite.open": { en: "Invite a collaborator" },
  "workbench.invite.email": { en: "Collaborator email" },
  "workbench.invite.sent": { en: "Invitation sent." },
  "workbench.invite.send": { en: "Send invitation" },
  "workbench.notes.eyebrow": { en: "Workspace notes" },
  "workbench.notes.export.on": { en: "Notes export enabled" },
  "workbench.notes.export.off": { en: "Notes export off" },
  "workbench.notes.export.csv": { en: "Download CSV" },
  "workbench.notes.export.pdf": { en: "Download PDF" },
  "workbench.notes.new": { en: "New note" },
  "workbench.notes.placeholder": { en: "Write a note…" },
  "workbench.notes.saved": { en: "Note saved." },
  "workbench.notes.add": { en: "Add note" },
  "workbench.notes.loading": { en: "Loading notes…" },
  "workbench.notes.empty": { en: "No notes yet." },
  "workbench.notes.pages": { en: "Notes pages" },
  "workbench.notes.page": { en: "Page {number}" },
  "workbench.notes.previous": { en: "Previous" },
  "workbench.notes.next": { en: "Next" },
  "workbench.retry": { en: "Retry" },
  "workbench.error.network": { en: "Could not reach the server. Try again." },
  "workbench.error.session": { en: "Sign in to continue." },
  "workbench.error.signIn": {
    en: "Check your email and password. Open the verification email if you haven’t verified the account.",
  },
  "workbench.error.forbidden": {
    en: "Your account does not have access to this action.",
  },
  "workbench.error.missing": { en: "This item is unavailable." },
  "workbench.error.conflict": {
    en: "The workspace changed. Check the latest state and try again.",
  },
  "workbench.error.input": {
    en: "Check the information you entered and try again.",
  },
  "workbench.error.rate": {
    en: "Too many requests. Wait a moment and try again.",
  },
  "workbench.error.generic": { en: "The request failed. Try again." },
});

export type WorkbenchCopyKey = CopyKey<typeof workbenchCopy>;
export const useWorkbenchCopy = createCopyHook(workbenchCopy);
