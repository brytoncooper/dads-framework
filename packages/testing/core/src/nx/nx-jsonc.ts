/** Parses Nx JSONC without interpreting comments or commas inside strings. */
export function parseNxConfiguration(text: string, subject: string): unknown {
  try {
    return JSON.parse(removeTrailingCommasAfterValues(removeJsonComments(text)));
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : "unknown JSON error";
    throw new Error(`Unable to parse ${subject}: ${detail}`, { cause: error });
  }
}

function removeJsonComments(text: string): string {
  let output = "";
  let index = 0;
  while (index < text.length) {
    if (text[index] === '"') {
      const end = findStringEnd(text, index);
      output += text.slice(index, end);
      index = end;
      continue;
    }
    const commentEnd = findCommentEnd(text, index);
    if (commentEnd !== undefined) {
      output += text.slice(index, commentEnd).replace(/[^\r\n]/gu, " ");
      index = commentEnd;
      continue;
    }
    output += text[index] ?? "";
    index += 1;
  }
  return output;
}

function findStringEnd(text: string, start: number): number {
  let index = start + 1;
  while (index < text.length) {
    if (text[index] === "\\") {
      index += 2;
      continue;
    }
    if (text[index] === '"') return index + 1;
    index += 1;
  }
  return text.length;
}

function findCommentEnd(text: string, start: number): number | undefined {
  const opening = text.slice(start, start + 2);
  if (opening === "//") {
    const newline = text.indexOf("\n", start + 2);
    return newline === -1 ? text.length : newline;
  }
  if (opening !== "/*") return undefined;
  const closing = text.indexOf("*/", start + 2);
  if (closing === -1) throw new Error("unterminated block comment");
  return closing + 2;
}

function removeTrailingCommasAfterValues(text: string): string {
  let output = "";
  let index = 0;
  while (index < text.length) {
    if (text[index] === '"') {
      const end = findStringEnd(text, index);
      output += text.slice(index, end);
      index = end;
      continue;
    }
    if (text[index] !== "," || !isTrailingComma(text, index)) output += text[index] ?? "";
    index += 1;
  }
  return output;
}

function isTrailingComma(text: string, index: number): boolean {
  const next = findNonWhitespace(text, index + 1, 1);
  if (next !== "}" && next !== "]") return false;
  const previous = findNonWhitespace(text, index - 1, -1);
  return previous !== undefined && !"[{:,".includes(previous);
}

function findNonWhitespace(text: string, start: number, direction: 1 | -1): string | undefined {
  let index = start;
  while (index >= 0 && index < text.length) {
    const character = text[index];
    if (character !== undefined && !" \t\r\n".includes(character)) return character;
    index += direction;
  }
  return undefined;
}
