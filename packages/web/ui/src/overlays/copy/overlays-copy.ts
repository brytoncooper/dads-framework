import {
  createCopyHook,
  defineCopy,
  type CopyKey,
  type CopyTranslator,
} from "../../copy/index.js";

export const overlaysCopy = defineCopy({
  "overlays.action.close": { en: "Close" },
  "overlays.splitButton.moreActions": { en: "More actions" },
  "overlays.commandPalette.title": { en: "Command Palette" },
  "overlays.commandPalette.description": {
    en: "Search for a command to run.",
  },
  "overlays.attachmentViewer.download": { en: "Download" },
  "overlays.attachmentViewer.download.failed": {
    en: "The file couldn't be downloaded. Try again.",
  },
  "overlays.attachmentViewer.kind.pdf": { en: "PDF" },
  "overlays.attachmentViewer.kind.image": { en: "Image" },
  "overlays.attachmentViewer.kind.other": { en: "File" },
  "overlays.attachmentViewer.loading": { en: "Opening file" },
  "overlays.attachmentViewer.unsupported.title": {
    en: "We Can't Preview This File Type",
  },
  "overlays.attachmentViewer.unsupported.hint": {
    en: "Download it to open it in another app.",
  },
  "overlays.attachmentViewer.tooLarge.title": {
    en: "This File Is Too Large to Preview",
  },
  "overlays.attachmentViewer.tooLarge.hint": {
    en: "It is {size}. Download it to open it in another app.",
  },
  "overlays.attachmentViewer.failed.title": { en: "Couldn't Open This File" },
  "overlays.attachmentViewer.failed.hint": {
    en: "You can still download it.",
  },
  "overlays.attachmentViewer.zoomOut": { en: "Zoom Out" },
  "overlays.attachmentViewer.zoomIn": { en: "Zoom In" },
  "overlays.attachmentViewer.rotateCounterclockwise": {
    en: "Rotate Counterclockwise",
  },
  "overlays.attachmentViewer.rotateClockwise": { en: "Rotate Clockwise" },
  "overlays.attachmentViewer.fullScreen.enter": { en: "Full Screen" },
  "overlays.attachmentViewer.fullScreen.exit": { en: "Exit Full Screen" },
  "overlays.attachmentViewer.pdf.toolbar": { en: "PDF Controls" },
  "overlays.attachmentViewer.pdf.thumbnails": { en: "Page Thumbnails" },
  "overlays.attachmentViewer.pdf.thumbnails.show": {
    en: "Show Page Thumbnails",
  },
  "overlays.attachmentViewer.pdf.thumbnails.hide": {
    en: "Hide Page Thumbnails",
  },
  "overlays.attachmentViewer.pdf.thumbnail": { en: "Page {page}" },
  "overlays.attachmentViewer.pdf.firstPage": { en: "First Page" },
  "overlays.attachmentViewer.pdf.previousPage": { en: "Previous Page" },
  "overlays.attachmentViewer.pdf.nextPage": { en: "Next Page" },
  "overlays.attachmentViewer.pdf.lastPage": { en: "Last Page" },
  "overlays.attachmentViewer.pdf.pageNumber": { en: "Page Number" },
  "overlays.attachmentViewer.pdf.pageCount": { en: "of {count}" },
  "overlays.attachmentViewer.pdf.fitWidth": { en: "Fit Width" },
  "overlays.attachmentViewer.pdf.find": { en: "Find in Document" },
  "overlays.attachmentViewer.pdf.find.placeholder": {
    en: "Find in document",
  },
  "overlays.attachmentViewer.pdf.find.previous": { en: "Previous Match" },
  "overlays.attachmentViewer.pdf.find.next": { en: "Next Match" },
  "overlays.attachmentViewer.pdf.find.highlightAll": { en: "Highlight All" },
  "overlays.attachmentViewer.pdf.find.matchCase": { en: "Match Case" },
  "overlays.attachmentViewer.pdf.find.wholeWord": { en: "Match Whole Word" },
  "overlays.attachmentViewer.pdf.find.close": { en: "Close Find" },
  "overlays.attachmentViewer.pdf.find.noMatches": { en: "No matches" },
  "overlays.attachmentViewer.pdf.find.matchCount": {
    en: "{current} of {total}",
  },
  "overlays.attachmentViewer.pdf.print": { en: "Print" },
  "overlays.attachmentViewer.pdf.print.cancel": { en: "Cancel Printing" },
  "overlays.attachmentViewer.pdf.print.retry": { en: "Retry Print" },
  "overlays.attachmentViewer.pdf.print.progress": {
    en: "Preparing {done} of {total}",
  },
  "overlays.attachmentViewer.pdf.print.failed": {
    en: "The file couldn't be printed. Try again.",
  },
  "overlays.attachmentViewer.image.toolbar": { en: "Image Controls" },
  "overlays.attachmentViewer.image.fit": { en: "Fit to Window" },
  "overlays.attachmentViewer.image.actualSize": { en: "Actual Size" },
});

export type OverlaysCopyKey = CopyKey<typeof overlaysCopy>;
export type OverlaysCopyTranslator = CopyTranslator<typeof overlaysCopy>;

export const useOverlaysCopy = createCopyHook(overlaysCopy);
