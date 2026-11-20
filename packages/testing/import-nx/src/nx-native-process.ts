import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

export async function nativeNxProcess(
  executable: string,
  args: readonly string[],
  workspaceRoot: string,
  environment: NodeJS.ProcessEnv = {},
): Promise<string> {
  const result = await execute(executable, args, {
    cwd: workspaceRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      ...environment,
      NX_DAEMON: "false",
      NX_TUI: "false",
    },
  });
  return result.stdout;
}
