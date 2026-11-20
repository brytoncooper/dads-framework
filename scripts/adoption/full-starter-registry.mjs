import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, join } from "node:path";
import { once } from "node:events";
import { URL } from "node:url";

export async function startStarterRegistry(context, directory, host) {
  const packages = new Map();
  const archives = new Set();
  for (const [name, path] of context.tarballs) {
    const bytes = await readFile(path);
    const tarball = basename(path);
    archives.add(tarball);
    packages.set(name, {
      manifest: context.packages.get(name).manifest,
      tarball,
      integrity:
        "sha512-" + createHash("sha512").update(bytes).digest("base64"),
      shasum: createHash("sha1").update(bytes).digest("hex"),
    });
  }

  let origin;
  const server = createServer((request, response) => {
    if (request.method !== "GET") {
      response.writeHead(405).end();
      return;
    }
    const pathname = new URL(request.url, origin).pathname;
    let key;
    try {
      key = decodeURIComponent(pathname);
    } catch {
      response.writeHead(400).end();
      return;
    }
    if (key.startsWith("/tarballs/")) {
      const archive = key.slice("/tarballs/".length);
      if (!archives.has(archive)) {
        response.writeHead(404).end();
        return;
      }
      const path = join(directory, archive);
      void stat(path).then(
        ({ size }) => {
          response.writeHead(200, {
            "content-type": "application/octet-stream",
            "content-length": size,
          });
          createReadStream(path).pipe(response);
        },
        () => response.writeHead(404).end(),
      );
      return;
    }

    const name = key.slice(1);
    const pkg = packages.get(name);
    if (pkg === undefined) {
      if (name === "create-dads" || name.startsWith("@dads-framework/")) {
        response.writeHead(404).end();
      } else {
        response
          .writeHead(302, {
            location: "https://registry.npmjs.org" + pathname,
          })
          .end();
      }
      return;
    }
    const version = pkg.manifest.version;
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        name,
        "dist-tags": { latest: version },
        versions: {
          [version]: {
            ...pkg.manifest,
            dist: {
              tarball: origin + "/tarballs/" + encodeURIComponent(pkg.tarball),
              integrity: pkg.integrity,
              shasum: pkg.shasum,
            },
          },
        },
      }),
    );
  });

  server.listen(0, host);
  await once(server, "listening");
  origin = "http://" + host + ":" + server.address().port;
  return {
    origin,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}
