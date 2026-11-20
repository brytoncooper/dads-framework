import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import { isMissingPathError } from "../missing-path-error.js";

type Edit = {
  readonly before: string | undefined;
  readonly after: string;
};

/** Preflights all output and only updates explicitly marked registries. */
export class GenerationPlan {
  private readonly edits = new Map<string, Edit>();
  private readonly root: string;

  constructor(root: string) {
    this.root = realpathSync(root);
  }

  read(path: string): string | undefined {
    return this.edits.get(path)?.after ?? this.readDisk(path);
  }

  create(path: string, content: string): void {
    const existing = this.read(path);
    if (existing !== undefined && existing !== content) {
      throw new Error(`File already exists with other content: ${path}`);
    }
    if (existing === undefined)
      this.edits.set(path, { before: undefined, after: content });
  }

  appendLine(path: string, marker: string, line: string): void {
    const content = this.read(path);
    if (content === undefined)
      throw new Error(`Required registry does not exist: ${path}`);
    const lines = content.split("\n");
    if (lines.some((candidate) => candidate.trim() === line.trim())) return;
    const matches = lines.flatMap((candidate, index) =>
      candidate.trim() === marker ? [index] : [],
    );
    const [index] = matches;
    if (matches.length !== 1 || index === undefined) {
      throw new Error(`Expected one "${marker}" marker in ${path}`);
    }
    const indent = (lines[index] ?? "").match(/^\s*/)?.[0] ?? "";
    lines.splice(index, 0, indent + line.trim());
    this.edits.set(path, {
      before: this.readDisk(path),
      after: lines.join("\n"),
    });
  }

  rewrite(path: string, after: string): void {
    const before = this.readDisk(path);
    if (before === undefined)
      throw new Error(`Cannot update missing file: ${path}`);
    if (before !== after) this.edits.set(path, { before, after });
  }

  paths(): string[] {
    return [...this.edits.keys()].sort();
  }

  write(): void {
    for (const [path, edit] of this.edits) {
      if (this.readDisk(path) !== edit.before) {
        throw new Error(`File changed while preparing generator: ${path}`);
      }
    }
    for (const [path, edit] of this.edits) {
      const target = this.target(path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, edit.after, {
        flag: edit.before === undefined ? "wx" : "w",
      });
    }
  }

  private readDisk(path: string): string | undefined {
    try {
      return readFileSync(this.target(path), "utf8");
    } catch (error) {
      if (isMissingPathError(error)) return undefined;
      throw error;
    }
  }

  private target(path: string): string {
    const target = join(this.root, path);
    const segments = relative(this.root, target).split(sep);
    let current = this.root;
    for (const segment of segments) {
      if (segment === ".." || segment === "")
        throw new Error(`Invalid generator path: ${path}`);
      current = join(current, segment);
      if (isSymbolicLink(current))
        throw new Error(`Generator path contains a symbolic link: ${path}`);
    }
    return target;
  }
}

function isSymbolicLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}
