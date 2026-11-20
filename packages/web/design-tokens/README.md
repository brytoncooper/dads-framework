# @dads-framework/design-tokens

The default UI palette and semantic roles in the DTCG design token format.

## Try it

Install this package and import the token document with your JSON-aware tooling.

```js
import tokens from "@dads-framework/design-tokens/default.tokens.json" with { type: "json" };

console.log(Object.keys(tokens));
```

The document defines `palette`, `light`, and `dark` groups.

## Use it

`palette` declares raw OKLCH colors. `light` declares semantic roles, such as
`primary` and `background`. `dark` overrides roles for dark mode. Color role
aliases point to the palette.

For Tailwind applications, use the corresponding CSS in
`@dads-framework/styles`.

## Contract

The exported JSON contains colors, dimensions, and shadow layers. Resolve token
aliases before converting the document to platform values.

## What it refuses to do

Product branding belongs in the application's theme.
