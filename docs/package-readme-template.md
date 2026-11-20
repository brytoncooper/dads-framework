# Package README template

Copy this skeleton into `packages/<group>/<name>/README.md`. Keep the section order.
The notes under each heading explain which register to use and whether the
section is required. Replace those notes with package-specific content.
Keep the applicable command or library section.
[Documentation style guide](./style-guide.md)

---

# `@dads-framework/<name>`

_Reference. Required._ One sentence saying what the package is, in plain
words. No metaphor. This is the paragraph before the first `##`, and the
conformance check requires it.

## What Dad does for you

_Dad register. Optional._ One to three lines, punchline first, on why this
package holds the boundary it holds. Delete the section rather than pad it.

## Try it

_Reference. Required._ Name the environment and give the installation command. Walk the reader through one job the package does using its public entry point. Show the output, resulting record, or visible change they can use to confirm it worked. If an adapter needs a running service or credentials, identify those inputs before using them.

Put `<!-- dads:check-example -->` on the line immediately before the canonical TypeScript or TSX code block so the docs check compiles it. For a command-line tool or stylesheet, show the actual invocation or stylesheet and how to observe the result.

## Commands

_Reference. Required for a CLI package; replace with `## Use it` for a
library._ Every command, every option it accepts, and what each one does. For
`@dads-framework/testing` this section is checked against the built CLI: every
command name and every option flag must appear.

## Use it

_Reference. Required for a library package; replace with `## Commands` for a
CLI._ The exported entry points and a short example of each in context.

## What it refuses to do

_Reference. Required, and the heading text must match exactly._ The things
this package will not do and the boundary each refusal protects. State the
refusal, then the reason, both plainly.

## Contract

_Reference. Required._ The shapes a caller passes and receives, the errors
thrown or returned, and when each error happens.

## Daddy issues this prevents

_Dad register. Optional._ One to three lines naming the anti-pattern this
package exists to stop. About code, never about the reader.
