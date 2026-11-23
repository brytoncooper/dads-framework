import { mutationSource } from "./testing-soundness-generator-source.mjs";
import { PROJECT_IDS, downstreamProjects, taskIds } from "./testing-soundness-generator-model.mjs";

export function buildManifest(model) {
  const tasks = [];
  for (const project of model.projects) {
    tasks.push({
      id: `${project.id}:lint`,
      project: project.id,
      kind: "lint",
      execution: {
        executable: "node",
        args: ["node_modules/oxlint/bin/oxlint", `${project.root}/src`],
      },
      dependsOn: [],
      impact: { mode: "project" },
    });
    tasks.push({
      id: `${project.id}:typecheck`,
      project: project.id,
      kind: "typecheck",
      execution: {
        executable: "node",
        args: [
          "node_modules/typescript-native/bin/tsc",
          "--project",
          `${project.root}/tsconfig.json`,
          "--pretty",
          "false",
        ],
      },
      dependsOn: [`${project.id}:lint`],
      impact: { mode: "project" },
    });
    tasks.push({
      id: `${project.id}:test`,
      project: project.id,
      kind: "test",
      execution: {
        executable: "node",
        args: ["node_modules/vitest/vitest.mjs", "run", `${project.root}/src`],
      },
      dependsOn: [`${project.id}:typecheck`],
      impact: { mode: "reachability" },
    });
  }
  return {
    schemaVersion: 1,
    workspace: {
      root: ".",
      fullFallback: { taskIds: taskIds(PROJECT_IDS) },
    },
    projects: model.projects.map((project) => ({
      id: project.id,
      root: project.root,
      fallbackDependencies: project.dependsOn,
    })),
    tasks,
  };
}

export function buildGraph(model) {
  return {
    schemaVersion: 1,
    kind: "dads-testing-soundness-generator-graph",
    seed: model.seed,
    topology: model.topology,
    projects: model.projects.map((project) => ({
      id: project.id,
      root: project.root,
      dependsOn: project.dependsOn,
      baselineValues: {
        value: project.value,
        unused: project.unusedValue,
      },
      modules: [
        {
          id: "value",
          path: `${project.root}/src/value.ts`,
          exportName: "value",
          baselineValue: project.value,
          imports: project.dependsOn.map((upstream) => ({
            path: `packages/${upstream}/src/value.ts`,
            project: upstream,
            module: "value",
            importedName: "value",
            localName: "upstreamValue",
          })),
        },
        {
          id: "unused",
          path: `${project.root}/src/unused.ts`,
          exportName: "unused",
          baselineValue: project.unusedValue,
          imports: [],
        },
      ],
      taskInputs: taskInputs(model, project),
    })),
    relationships: [
      {
        fromProject: "p0",
        toProject: "p1",
        fromModule: "value",
        toModule: "value",
        importPath: "packages/p0/src/value.ts",
        importedName: "value",
      },
      {
        fromProject: model.topology === "fanout" ? "p0" : "p1",
        toProject: "p2",
        fromModule: "value",
        toModule: "value",
        importPath: `packages/${model.topology === "fanout" ? "p0" : "p1"}/src/value.ts`,
        importedName: "value",
      },
    ],
    limitations: [
      "The model contains three TypeScript projects and only explicit relative value imports.",
      "unused.ts is intentionally isolated and is never imported by a consumer.",
      "The expected task sets are an authored oracle for this generated topology, not a guarantee for other repositories.",
    ],
  };
}

function taskInputs(model, project) {
  const upstreamValues = upstreamProjects(model, project.id).map((upstream) => `packages/${upstream}/src/value.ts`);
  return [
    {
      taskId: `${project.id}:lint`,
      mode: "project",
      declaredInputs: [`${project.root}/src`, ".oxlintrc.json"],
      executedPaths: [`${project.root}/src`],
    },
    {
      taskId: `${project.id}:typecheck`,
      mode: "project",
      declaredInputs: [`${project.root}/src`, `${project.root}/tsconfig.json`, ...upstreamValues],
      executedPaths: [`${project.root}/tsconfig.json`],
    },
    {
      taskId: `${project.id}:test`,
      mode: "reachability",
      declaredInputs: [`${project.root}/src/value.test.ts`, `${project.root}/src/value.ts`, ...upstreamValues],
      executedPaths: [`${project.root}/src`],
    },
  ];
}

function upstreamProjects(model, projectId) {
  const project = model.projects.find((candidate) => candidate.id === projectId);
  if (project === undefined) throw new Error(`Unknown generated project ${projectId}.`);
  const result = [];
  const pending = [...project.dependsOn];
  while (pending.length > 0) {
    const upstream = pending.shift();
    if (result.includes(upstream)) continue;
    result.push(upstream);
    const dependency = model.projects.find((candidate) => candidate.id === upstream);
    if (dependency !== undefined) pending.push(...dependency.dependsOn);
  }
  return result;
}

export function buildCases(model) {
  return {
    schemaVersion: 1,
    allTaskIds: taskIds(PROJECT_IDS),
    generator: {
      schemaVersion: 1,
      seed: model.seed,
      topology: model.topology,
      projectCount: 3,
      graphFile: "graph.json",
    },
    cases: PROJECT_IDS.flatMap((owner) => casesForProject(model, owner)),
  };
}

function casesForProject(model, owner) {
  const closure = [owner, ...downstreamProjects(model, owner)].sort();
  const allClosureTasks = taskIds(closure);
  const controlTasks = taskIds(closure, ["lint", "typecheck"])
    .concat(taskIds([owner], ["test"]))
    .sort();
  return [
    makeCase(
      model,
      owner,
      "value-export",
      "breaking",
      allClosureTasks,
      closure.map((project) => `${project}:test`),
    ),
    makeCase(model, owner, "unused-number", "control", controlTasks, []),
    makeCase(model, owner, "unused-string", "breaking", controlTasks, [`${owner}:typecheck`]),
    makeCase(model, owner, "unused-console", "breaking", allClosureTasks, [`${owner}:lint`]),
  ];
}

function makeCase(model, owner, mutationKind, classification, selected, changed) {
  const module = mutationKind === "value-export" ? "value" : "unused";
  const proofPath = `packages/${owner}/src/${module}.ts`;
  return {
    id: `${owner}-${mutationKind.replace("-export", "")}`,
    description: descriptionFor(mutationKind, owner, model.topology),
    operations: [
      {
        kind: "write",
        path: proofPath,
        contents: mutationSource(model, owner, mutationKind),
      },
    ],
    requiredTaskIds: selected,
    expectedSelectionTaskIds: selected,
    fullFallbackPolicy: "forbidden",
    classification,
    expectedChangedTaskIds: changed.sort(),
    proofPath,
    mutationKind,
  };
}

function descriptionFor(kind, project, topology) {
  if (kind === "value-export")
    return `${project} value export mutation crosses the ${topology} value dependency closure.`;
  if (kind === "unused-number") return `${project} isolated numeric export control has no consumer reachability.`;
  if (kind === "unused-string") return `${project} isolated export receives an explicit number annotation violation.`;
  return `${project} isolated module receives an unattributed console statement.`;
}
