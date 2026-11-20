import {
  createCopyHook,
  defineCopy,
  type CopyKey,
  type CopyTranslator,
} from "@dads-framework/copy";

export const shellCopy = defineCopy({
  "shell.breadcrumb.label": { en: "Breadcrumb" },
  "shell.breadcrumb.more": { en: "More" },
  "shell.sidebar.title": { en: "Sidebar" },
  "shell.sidebar.mobileDescription": {
    en: "App navigation.",
  },
  "shell.sidebar.toggle": { en: "Toggle Sidebar" },
});

export type ShellCopyKey = CopyKey<typeof shellCopy>;
export type ShellCopyTranslator = CopyTranslator<typeof shellCopy>;

export const useShellCopy = createCopyHook(shellCopy);
