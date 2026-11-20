---
name: write-docs
description: Write a Dads package README in the two-register documentation style.
---

# Write docs

Load this for any change to a public surface — an export, a CLI command or
option, an error — or any edit to a README.

Two registers:

- Reference: plain, scannable, no humor. What it is, a runnable example, what
  it refuses to do, the contract shapes, the errors and when.
- Dad: teaching, and only why. One to three lines, punchline first, in
  overviews and "why this rule exists" spots.

Four rules:

1. Humor explains a why, never a how.
2. Never in error messages, CLI output, or API names.
3. Keep the metaphor consistent: Dad, daddy issues, attachment styles,
   vendors (`DAD.md`).
4. Jokes are about code, never about a reader.

Copy the section order from `docs/package-readme-template.md`; the exact
heading `## What it refuses to do` is required. `docs/style-guide.md` is the
full rule.

Then run `node scripts/checks/check-docs.mjs`.
