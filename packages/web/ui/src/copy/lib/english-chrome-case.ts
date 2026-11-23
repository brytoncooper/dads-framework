import type { MergedCopy } from "./merge-copy.js";

/** One English chrome phrase that does not follow the authored Title Case rule. */
export type EnglishChromeCaseViolation = {
  readonly key: string;
  readonly file: string;
  readonly phrase: string;
};

const BUTTON_OR_TITLE =
  /(^|\.)(action|affordance|button)(\.|$)|(?:^|\.)title$/i;
const SENTENCE_CASE_KEY = /error|failure|refusal|refused|tooMany/i;
const PLACEHOLDER = /\{\w+\}/g;
const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’/-]*/gu;
const LOWERCASE_CONNECTORS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "but",
  "by",
  "for",
  "from",
  "in",
  "into",
  "nor",
  "of",
  "on",
  "or",
  "per",
  "the",
  "to",
  "via",
  "vs",
  "with",
]);
const INITIALISMS = new Set([
  // A product name its makers and customers only ever write in capitals.
  "AGRIS",
  // Artificial intelligence: the AI assistants a user connects to the application.
  "AI",
  "API",
  "CSV",
  "ERP",
  "HMI",
  "HTTP",
  "ID",
  "IP",
  // Information technology: a company's IT person or IT team.
  "IT",
  // Light-emitting diode: an LED status display.
  "LED",
  // Model Context Protocol: a protocol for exposing tools.
  "MCP",
  "OIDC",
  // Personal identification number: the short code a person types to sign in.
  "PIN",
  "PLC",
  // Quality assurance: the QA team and its walkthroughs.
  "QA",
  "SAML",
  "SCIM",
  "SKU",
  "SSO",
  "URL",
  "USB",
  "UTC",
]);

function isEnglishChromeKey(key: string): boolean {
  if (SENTENCE_CASE_KEY.test(key)) return false;
  return BUTTON_OR_TITLE.test(key);
}

function isPlaceholder(word: string): boolean {
  return word === "PLACEHOLDER";
}

function isUppercaseStart(word: string): boolean {
  const [first] = word;
  const uppercaseFirst = first?.toLocaleUpperCase("en");
  return uppercaseFirst !== undefined && first === uppercaseFirst;
}

function isAllUppercaseWord(word: string): boolean {
  const letters = word.match(/\p{L}/gu) ?? [];
  const uppercase = word.toLocaleUpperCase("en");
  const lowercase = word.toLocaleLowerCase("en");
  return letters.length > 1 && word === uppercase && uppercase !== lowercase;
}

function followsEnglishTitleCase(phrase: string): boolean {
  const words = phrase.replaceAll(PLACEHOLDER, "PLACEHOLDER").match(WORD) ?? [];

  return words.every((word, index) => {
    if (isPlaceholder(word)) return true;
    if (isAllUppercaseWord(word) && !INITIALISMS.has(word)) return false;

    const isEdge = index === 0 || index === words.length - 1;
    const lowercaseWord = word.toLocaleLowerCase("en");
    if (!isEdge && LOWERCASE_CONNECTORS.has(lowercaseWord)) {
      return word === lowercaseWord;
    }
    return isUppercaseStart(word);
  });
}

/**
 * Find English buttons and titles that were authored in sentence case.
 *
 * This checks catalog source copy; it never rewrites output at runtime. Field
 * labels, columns, headings, generic `.label` keys, errors, refusals, and
 * explanatory prose stay outside the rule.
 */
export function checkEnglishChromeCase(
  merged: MergedCopy,
): EnglishChromeCaseViolation[] {
  const violations: EnglishChromeCaseViolation[] = [];

  for (const [key, entry] of merged) {
    const phrase = entry.text.en;
    if (!isEnglishChromeKey(key) || followsEnglishTitleCase(phrase)) continue;
    violations.push({ key, file: entry.file, phrase });
  }

  return violations;
}
