# Dads Framework website

Build the landing page and documentation from this repository. From the repository root, use Node 24 and run:

```sh
npm ci
npm run build
npm run docs:build
npm --prefix website ci
npm --prefix website test
npm --prefix website run build -- ../dist/dads-docs
python3 -m http.server 8080 --directory website/dist
```

The build consumes the generated `dads-docs` directory. It can also read its location from `DADS_DOCS_DIR`. The site build uses the dependencies in its own lockfile and requires no framework checkout. Publish the contents of `dist/` on the static host. The docs keep their generated Markdown, search index, article markup, and section anchors. The site adds shared navigation and the docs theme at build time. It also exports the readable content of each HTML page to a linked Markdown companion. Complete API declarations remain available in the original reports.

Font and image attribution is in `site/credits.html`.

The checked-in Wrangler configuration serves the built assets on `dadsframework.dev`. From `website/`, use `wrangler deploy --dry-run` to check the deployment configuration.
