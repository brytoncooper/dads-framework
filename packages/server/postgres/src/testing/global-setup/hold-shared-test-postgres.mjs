import { execFile } from "node:child_process";
import process from "node:process";
import { clearInterval, setInterval } from "node:timers";
import { promisify } from "node:util";

const run = promisify(execFile);
const containerId = process.argv[2];
const nxPid = Number(process.argv[3]);

if (containerId === undefined || !Number.isInteger(nxPid)) {
  process.exit(2);
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
  }
}

const timer = setInterval(() => {
  if (processIsAlive(nxPid)) {
    return;
  }
  clearInterval(timer);
  void run("docker", ["rm", "-f", containerId]).finally(() => {
    process.exit(0);
  });
}, 500);
