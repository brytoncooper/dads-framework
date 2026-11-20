# Dads documentation

Framework guides and reference material are indexed here. Package-specific
documentation lives beside each package.

## Local documentation site

Run `npm run build` followed by `npm run docs:build` at the repository root.
Open `dist/dads-docs/index.html` to browse and search the site. Every page links
to its Markdown source, and `dist/dads-docs/llms.txt` indexes those sources.

[The site catalogue](./site/catalog.json) declares the owner of each guide and
the packages that have a generated API reference. The site check runs inside
`npm run verify`. To run it by itself after building, use `npm run docs:check`.

## Build and verify an app

- [Start a Dads project](./site/guides/start.md)
- [Generate application code](./generators.md)
- [Keep domains independent](./domain-boundaries.md)
- [Share an application contract with another repository](./dependency-libraries.md)
- [Run the app's verification in CI](../ci/README.md)

## Diagnosis

Read [Dad](../DAD.md) for the short version of the house rules.
[Who let Gary back in?](./go-ask-your-other-database.md) explains why
the Postgres adapter keeps records and permissions together.

| Page                                   | What it covers                                                                                                |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| [`doctor.md`](./doctor.md)             | `dad doctor`: the command, its flags, the profiles, the verdicts, and how a repository gates.                 |
| [`daddy-issues.md`](./daddy-issues.md) | The seventeen issues: a definition, a numbered test, and a cure for each. The essay is [`DAD.md`](../DAD.md). |

## Standards

| Page                                                     | What it covers                                                           |
| -------------------------------------------------------- | ------------------------------------------------------------------------ |
| [`principles.md`](./principles.md)                       | The Independent Evolution Principle and what follows from it.            |
| [`goals.md`](./goals.md)                                 | What Dads must make true before larger product ideas deserve attention.  |
| [`house-rules.md`](./house-rules.md)                     | The rules this repository holds itself to, and the gates that hold them. |
| [`validation.md`](./validation.md)                       | Zod ID and envelope schemas, boundary parsing, and OpenAPI.              |
| [`http-hosting.md`](./http-hosting.md)                   | Registering typed routes and testing the HTTP pipeline.                  |
| [`adoption-model.md`](./adoption-model.md)               | How a team adopts and trusts one capability at a time.                   |
| [`agent-operating-model.md`](./agent-operating-model.md) | What coding agents are given, and what they are held to.                 |

## Writing

| Page                                                         | What it covers                                    |
| ------------------------------------------------------------ | ------------------------------------------------- |
| [`style-guide.md`](./style-guide.md)                         | The two registers, and where each one is allowed. |
| [`package-readme-template.md`](./package-readme-template.md) | The section order every package README copies.    |

## Testing

| Page                                               | What it covers                                                       |
| -------------------------------------------------- | -------------------------------------------------------------------- |
| [`testing/README.md`](./testing/README.md)         | Testing soundness evidence: what is measured and how it is released. |
| [`testing/quickstart.md`](./testing/quickstart.md) | Running the testing tools on a repository for the first time.        |

## Product direction

These describe broader proposals beyond the current tools.

| Page                                                           | What it covers                                       |
| -------------------------------------------------------------- | ---------------------------------------------------- |
| [`development-environment.md`](./development-environment.md)   | An optional first-class development environment.     |
| [`polyglot-capability-host.md`](./polyglot-capability-host.md) | Server-side capabilities written in other languages. |
