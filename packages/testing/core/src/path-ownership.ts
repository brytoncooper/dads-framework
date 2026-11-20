/**
 * Path ownership is declared by project roots in the testing manifest. A root of
 * "." owns the whole workspace, and the deepest declared root wins whenever more
 * than one project could own a path.
 */

/** Reports whether a workspace-relative path is owned by a project root. */
export function pathIsInside(path: string, root: string): boolean {
  if (root === ".") return true;
  return path === root || path.startsWith(`${root}/`);
}

/**
 * Returns the project owning a workspace-relative path, or undefined when no
 * project owns it or when two equally deep roots both claim it. An ambiguous
 * ownership answer is deliberately no answer: the caller must widen instead of
 * guessing.
 */
export function owningProjectForPath<Project extends { readonly root: string }>(
  projects: readonly Project[],
  path: string,
): Project | undefined {
  let owner: Project | undefined;
  let ownerDepth = -1;
  let ambiguous = false;
  for (const project of projects) {
    if (!pathIsInside(path, project.root)) continue;
    const depth = project.root === "." ? 0 : project.root.length;
    if (depth > ownerDepth) {
      owner = project;
      ownerDepth = depth;
      ambiguous = false;
    } else if (depth === ownerDepth) {
      ambiguous = true;
    }
  }
  return ambiguous ? undefined : owner;
}
