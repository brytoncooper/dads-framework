# Package README template

Copy this skeleton into `packages/<group>/<name>/README.md`. Keep the section order.
Register and requirement are given under each heading; see
[`style-guide.md`](./style-guide.md) for what the registers are.

---

# `@dads-framework/<name>`

_Reference. Required._ One sentence saying what the package is, in plain
words. No metaphor. This is the paragraph before the first `##`, and the
conformance check requires it.

## What Dad does for you

_Dad register. Optional._ One to three lines, punchline first, on why this
package holds the boundary it holds. Delete the section rather than pad it.

## Try it

_Reference. Required._ One fenced code block a reader can paste and run, with
the output or effect they should see. The conformance check requires at least
one fenced block somewhere in the file; put it here.

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
