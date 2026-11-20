/**
 * A document the code walked away from: 180 days, 90 in strict.
 *
 * A wiki last touched during the Obama administration is not a neutral
 * artefact. It is an authority, and the newer the code it describes, the more
 * confidently it is wrong. The failure is not that a document is old; plenty of
 * good documents are finished. It is that a document is old *and* the code it
 * points at has moved since, so the file it cites and the sentence about it now
 * disagree and only one of them runs.
 *
 * So a document reads zero until something it cites changes after it, and then
 * it reads the number of days it has been sitting there being wrong. The
 * citation is a relative link to a file that exists and is not itself a
 * document: a link between two documents is a table of contents, not a claim
 * about code.
 *
 * Both dates come from the log — the last commit that touched the document, the
 * last commit that touched each file it cites — and the age is measured against
 * `--today`. A document nobody has committed yet cites nothing it can be late
 * for, and is left out.
 */

import type { DoctorContext } from "../../doctor-context.js";
import type {
  DoctorSignal,
  SignalEvidence,
  SignalReading,
  SignalReadings,
} from "../../doctor-signal.js";
import {
  daysBefore,
  isAfter,
  lastChangeDates,
  readCommitLog,
  requireGitWorkspace,
  requireToday,
} from "../scanners/git-history.js";

const DOCUMENT_SUFFIX = ".md";
const MARKDOWN_LINK = /\[[^\]]*\]\(([^)\s]+)/g;
const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i;

/**
 * The repository-relative path a link in `document` points at, or `undefined`
 * when the link leaves the repository or climbs above its root.
 */
function resolveCitedPath(
  document: string,
  target: string,
): string | undefined {
  if (EXTERNAL.test(target)) return undefined;
  const resolved: string[] = document.split("/").slice(0, -1);
  for (const segment of target.split("#")[0]?.split("/") ?? []) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment !== "..") {
      resolved.push(segment);
      continue;
    }
    if (resolved.pop() === undefined) return undefined;
  }
  return resolved.length === 0 ? undefined : resolved.join("/");
}

/** Every file this document cites that is code rather than another document. */
function documentCitations(
  context: DoctorContext,
  document: string,
): readonly string[] {
  const cited = new Set<string>();
  for (const link of context.read(document).matchAll(MARKDOWN_LINK)) {
    const target = link[1];
    if (target === undefined) continue;
    const path = resolveCitedPath(document, target);
    if (path === undefined || path.endsWith(DOCUMENT_SUFFIX)) continue;
    if (context.exists(path)) cited.add(path);
  }
  return [...cited];
}

function ageOneDocument(
  document: string,
  written: string,
  today: string,
  moved: readonly SignalEvidence[],
): SignalReading {
  return {
    value: moved.length === 0 ? 0 : daysBefore(written, today),
    evidence: [{ path: document, name: `last written ${written}` }, ...moved],
  };
}

function ageStaleDocuments(context: DoctorContext): SignalReadings {
  requireGitWorkspace(context.root);
  const today = requireToday(context.today);
  const changed = lastChangeDates(readCommitLog(context.root));
  const readings = new Map<string, SignalReading>();
  for (const document of context.files()) {
    if (!document.endsWith(DOCUMENT_SUFFIX)) continue;
    const written = changed.get(document);
    if (written === undefined) continue;
    const moved = documentCitations(context, document)
      .filter((path) => isAfter(changed.get(path), written))
      .map((path) => ({ path, name: `changed ${changed.get(path) ?? ""}` }));
    readings.set(document, ageOneDocument(document, written, today, moved));
  }
  return readings;
}

export const staleDocsSignal: DoctorSignal = {
  id: "stale-docs",
  issue: "you-are-looking-for-a-father-figure",
  question:
    "Is a document that cites code untouched for longer than the profile's threshold while the code it cites changed?",
  reads: "git",
  unit: "days",
  direction: "ceiling",
  thresholds: { standard: 180, strict: 90 },
  sentence:
    "This is how a codebase ends up raised by wolves and a wiki last touched during the Obama administration.",
  run: (context) => Promise.resolve(ageStaleDocuments(context)),
};
