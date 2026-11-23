/**
 * The environment every `git` this folder spawns starts from.
 *
 * Git exports `GIT_DIR`, and often `GIT_WORK_TREE`, `GIT_INDEX_FILE`,
 * `GIT_COMMON_DIR` and `GIT_PREFIX`, into the environment of the hooks it runs.
 * Those variables are absolute, and from a linked worktree they point at the
 * hook's repository. A `git` spawned for an explicit project root inherits them
 * and silently operates on the hook's repository instead of the root it was
 * given: verification then reads someone else's changed scope, and temporary
 * fixture repositories commit onto a real branch. Removing every `GIT_`
 * variable is the only filter that stays correct as Git adds more of them.
 */
export function environmentWithoutGitVariables(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
}
