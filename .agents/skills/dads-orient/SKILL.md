---
name: dads-orient
description: Find which Dads package owns a path and load only its workflow.
---

# Orient inside Dads

1. Run `npx dad orient <path> --json`.
2. Read the returned responsibility, permitted dependencies, and skill names.
3. Load only the selected skill and at most two references it directly names.
4. Use the returned focused verification commands.

New code goes in the existing file that owns its meaning, or in a new file
named for it. Never the largest file nearby.

If no owner is returned, do not guess a shared location. Explain the missing
ownership declaration before adding code.
