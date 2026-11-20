# Dads documentation style guide

Dad is funny in the driveway and boring in the manual. Both are him.

Dads documentation is written in two registers. Mixing them is the only way
to get this wrong, so decide which one a paragraph is in before you write it.

## The two registers

**Reference register** — plain, scannable, no humor. It answers: what is this,
what does a runnable example look like, what does it refuse to do, what are
the contract shapes, what are the errors and when do they happen. Short
sentences. Present tense. No metaphor. A reader who is debugging at 2am reads
only this register, and it has to hold up.

**Dad register** — teaching, and only about _why_. One to three lines,
punchline first, then the point. It appears in overviews and in "why this rule
exists" spots, and nowhere else. Its job is to make a boundary memorable, not
to be a bit.

Most of a page is reference register. Dad register is the frame around it.

## The four rules

1. **Humor explains a why, never a how.** A joke may justify a rule. It may
   never carry the instruction. If deleting the joke loses information the
   reader needs, the joke was doing a job it is not allowed to do — move that
   information into the reference register.
2. **Never in error messages, CLI output, or API names.** Anything a machine
   emits or a program depends on is reference register, permanently. Function
   names, type names, option flags, JSON fields, thrown messages, log lines.
3. **Keep the metaphor system consistent.** The vocabulary below is fixed.
   Do not invent a parallel metaphor, and do not stretch one past the point it
   explains something.
4. **Jokes are about code, never about a reader.** The subject is always the
   codebase, the vendor, or the framework. Never the person reading, their
   team, their employer, or their past decisions.

## The vocabulary

Defined in [`DAD.md`](../DAD.md); use these words and no synonyms for them.

- **Dad** — the framework's rules. What Dad does, refuses, or allows.
- **Daddy issues** — the anti-patterns: what a codebase looks like when
  nobody held a boundary.
- **Attachment styles** — how boundaries fail. Anxious (the domain merges
  with the vendor so it cannot be left). Avoidant (no contracts, no schemas,
  nothing to hand a consumer). Disorganized (both, in the same file).
- **Vendors** — who you bring home. A vendor implements a capability; it
  never gets to say what the capability is.

## Where humor goes, and where it does not

Allowed:

- A package README's `## What Dad does for you` section.
- A package README's `## Daddy issues this prevents` section.
- The opening line or two of an overview document.
- A short "why this rule exists" aside next to a stated rule.

Not allowed, ever:

- Error messages, CLI output, log lines, JSON payloads.
- Function, type, option, field, package, or file names.
- Step-by-step instructions, contract tables, migration notes.
- Anything a reader hits while something is broken.

## Writing a package README

Follow [`package-readme-template.md`](./package-readme-template.md). It fixes
the section order and says which register each section is in and whether it is
required. Section headings are part of the contract: the conformance check
matches `## What it refuses to do` exactly.

Try each quick start from the reader's stated starting point. Name the
prerequisites, use the public entry point, and show the expected result.
When an example is a fragment, identify the application code it assumes.
Use plain status language to tell readers which environments or providers
the evidence covers.

## Enforcement

Documentation is part of done, in three places:

- `node scripts/checks/check-docs.mjs` runs in `npm run verify`. It checks README
  structure for every package listed in
  [`readme-conformance.json`](./readme-conformance.json), and checks that
  `packages/testing/core/README.md` names every `dad-test` command and every option
  the CLI parses. It reads the command list from the built CLI, so the check
  fails the moment the surface grows past the docs.
- [`AGENTS.md`](../AGENTS.md) carries the rule as a universal one: a change to
  a public surface updates that package's README.
- `.agents/skills/write-docs/SKILL.md` is the loadable procedure for an agent
  making that change.
