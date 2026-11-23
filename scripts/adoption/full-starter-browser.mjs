import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers/promises";

export async function proveStarterFrontend(targetUrl, profile) {
  const browser = spawn(
    process.env.DADS_STARTER_BROWSER ?? "google-chrome",
    [
      "--headless",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-port=0",
      "--user-data-dir=" + profile,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const closed = once(browser, "close");
  try {
    const port = await Promise.race([
      waitForDebugPort(profile),
      closed.then(() => {
        throw new Error("The headless browser exited before rendering the starter");
      }),
    ]);
    const tabs = await (
      await globalThis.fetch("http://127.0.0.1:" + port + "/json/list", {
        signal: globalThis.AbortSignal.timeout(3000),
      })
    ).json();
    const page = tabs.find(({ type }) => type === "page");
    const socket = new globalThis.WebSocket(page.webSocketDebuggerUrl);
    try {
      await once(socket, "open", {
        signal: globalThis.AbortSignal.timeout(3000),
      });
      await command(socket, "Page.navigate", { url: targetUrl });
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const { result } = await command(socket, "Runtime.evaluate", {
          expression: "Array.from(document.querySelectorAll('button')).some(b => b.textContent.trim() === 'Sign in')",
          returnByValue: true,
        });
        if (result.value === true) return;
        await setTimeout(250);
      }
      throw new Error("The browser did not render the starter sign-in form");
    } finally {
      socket.close();
    }
  } finally {
    browser.kill();
    await closed.catch(() => undefined);
    await rm(profile, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
}

async function waitForDebugPort(profile) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const file = await readFile(join(profile, "DevToolsActivePort"), "utf8");
      const port = Number(file.split("\n", 1)[0]);
      if (port > 0 && port <= 65535) return port;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await setTimeout(250);
  }
  throw new Error("The headless browser did not open its local debug socket");
}

async function command(socket, method, params) {
  // Calls are serialized. Chrome also sends unsolicited events on this socket.
  socket.send(JSON.stringify({ id: 1, method, params }));
  for (;;) {
    const [event] = await once(socket, "message", {
      signal: globalThis.AbortSignal.timeout(3000),
    });
    const answer = JSON.parse(event.data);
    if (answer.id !== 1) continue;
    if (answer.error) throw new Error("Browser command failed: " + method);
    return answer.result;
  }
}
