import {
  createCopyHook,
  defineCopy,
  type CopyKey,
  type CopyTranslator,
} from "../../copy/index.js";

export const pageCopy = defineCopy({
  "page.attachments.empty": { en: "No files yet" },
  "page.attachments.loading": { en: "Loading files" },
  "page.attachments.open": { en: "Open {name}" },
  "page.attachments.download": { en: "Download {name}" },
  "page.attachments.kind.pdf": { en: "PDF" },
  "page.attachments.kind.image": { en: "Image" },
  "page.attachments.kind.file": { en: "File" },
  "page.masterDetail.name": { en: "Name" },
  "page.masterDetail.sortAscending": { en: "Sort by {label}, ascending" },
  "page.masterDetail.sortDescending": { en: "Sort by {label}, descending" },
  "page.masterDetail.loaded": { en: "{loaded} of {total} loaded" },
  "page.masterDetail.loadMore": { en: "Load More" },
  "page.masterDetail.loadingMore": { en: "Loading…" },
  "page.masterDetail.retry": { en: "Try Again" },
  "page.masterDetail.noSelection": { en: "Choose a record from the list." },
});

export type PageCopyKey = CopyKey<typeof pageCopy>;
export type PageCopyTranslator = CopyTranslator<typeof pageCopy>;

export const usePageCopy = createCopyHook(pageCopy);
