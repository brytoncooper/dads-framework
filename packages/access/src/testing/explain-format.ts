import type { PermissionQuery } from "../runtime/authorization.js";

/** One node in a permission decision explanation tree. */
export type PermissionTrace = {
  readonly label: string;
  readonly outcome: "ALLOW" | "DENY" | "BLOCKED";
  readonly detail?: string;
  readonly children?: readonly PermissionTrace[];
};

/** Full decision + human-readable explanation tree for a single permission check. */
export type PermissionExplanation = {
  readonly allowed: boolean;
  readonly trace: PermissionTrace;
};

/** Render a subject reference as `type:id` or `type:id#relation`. */
export function formatSubjectRef(subject: PermissionQuery["subject"]): string {
  return subject.relation === undefined
    ? `${subject.type}:${subject.id}`
    : `${subject.type}:${subject.id}#${subject.relation}`;
}

/** Render a permission query as `resourceType:resourceId#permission`. */
export function formatPermissionTarget(query: PermissionQuery): string {
  return `${query.resource.type}:${query.resource.id}#${query.permission}`;
}

function renderTraceNode(
  node: PermissionTrace,
  prefix: string,
  isLast: boolean,
  isRoot: boolean,
  lines: string[],
): void {
  const connector = isRoot ? "  " : `${prefix}${isLast ? "└── " : "├── "}`;
  const detailSuffix = node.detail === undefined ? "" : ` (${node.detail})`;
  lines.push(`${connector}${node.label} -> ${node.outcome}${detailSuffix}`);

  const children = node.children ?? [];
  const childPrefix = isRoot ? "  " : `${prefix}${isLast ? "    " : "│   "}`;
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (child === undefined) continue;
    renderTraceNode(child, childPrefix, index === children.length - 1, false, lines);
  }
}

/** Format a decision tree into readable multiline diagnostic text. */
export function formatPermissionExplanation(query: PermissionQuery, explanation: PermissionExplanation): string {
  const lines: string[] = [
    `${formatSubjectRef(query.subject)} on ${formatPermissionTarget(query)} => ${explanation.allowed ? "ALLOW" : "DENY"}`,
  ];
  renderTraceNode(explanation.trace, "", true, true, lines);
  return lines.join("\n");
}
