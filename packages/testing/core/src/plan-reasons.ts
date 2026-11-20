/** The sentence each reason code stands for. An unknown code is its own text. */
export const reasonTexts: Readonly<Record<string, string>> = {
  "direct-task-input": "requested explicitly with --task",
  "full-fallback": "complete workspace fallback selected",
  "impact-always": "declared impact.mode always",
  "graph-uncertainty-project-fallback":
    "graph proof incomplete; widened through fallback dependencies",
  "selected-prerequisite": "prerequisite of a selected task",
  "graph-changed-export": "an exported symbol in this project changed",
  "graph-symbol-importer": "imports a changed symbol",
  "changed-owned-project": "a changed path is owned by this project",
  "changed-file-input": "a declared file input changed",
  "proven-unaffected": "no changed path or symbol reaches this task",
};
