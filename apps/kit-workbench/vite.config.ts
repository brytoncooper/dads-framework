import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, posix, resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";
import { bundledExamplesPage } from "./assembly/examples-page.js";

const apiTarget = process.env["DADS_DEV_API_URL"] ?? "http://127.0.0.1:3000";

async function installedNotices() {
  const require = createRequire(import.meta.url);
  const styles = require.resolve("@dads-framework/ui/styles/fonts.css");
  const resolveFromStyles = createRequire(styles);
  const fonts = ["ibm-plex-sans", "ibm-plex-mono"].map((font) => ({
    fileName: `licenses/${font}.txt`,
    source: join(
      dirname(resolveFromStyles.resolve(`@fontsource/${font}`)),
      "LICENSE",
    ),
  }));
  const ui = resolve(
    dirname(require.resolve("@dads-framework/ui/elements")),
    "../..",
  );
  const uiLicenses = await readdir(join(ui, "third-party-licenses"));
  const uiNotices = [
    "THIRD_PARTY_NOTICES.md",
    ...uiLicenses.map((name) => posix.join("third-party-licenses", name)),
  ];
  return [
    ...fonts,
    ...uiNotices.map((name) => ({
      fileName: `licenses/dads-ui/${name}`,
      source: join(ui, name),
    })),
  ];
}

// The browser build redistributes font binaries and adapted UI source notices.
function bundledAssetLicenses(): Plugin {
  return {
    name: "workbench-asset-licenses",
    apply: "build",
    async generateBundle() {
      for (const notice of await installedNotices()) {
        this.emitFile({
          type: "asset",
          fileName: notice.fileName,
          source: await readFile(notice.source),
        });
      }
    },
  };
}

export default defineConfig({
  plugins: [tailwindcss(), bundledAssetLicenses(), bundledExamplesPage()],
  build: {
    license: { fileName: "THIRD_PARTY_LICENSES.md" },
    rolldownOptions: {
      input: { workbench: "index.html", examples: "examples.html" },
    },
  },
  server: {
    strictPort: true,
    fs: {
      // Keep Vite's default denials and protect the local example sessions.
      deny: [
        ".env",
        ".env.*",
        "*.{crt,pem,key,p12,pfx,cer,der}",
        ".npmrc",
        ".yarnrc.yml",
        "**/.git/**",
        "**/.dads/**",
      ],
    },
    proxy: { "/api": { target: apiTarget } },
  },
  preview: {
    proxy: { "/api": { target: apiTarget } },
  },
});
