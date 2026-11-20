# @dads-framework/design-tokens

The default UI palette and semantic roles in the DTCG design token format.

## Try it

Install the token document in a project running Node.js 22 or later.

```sh
npm install @dads-framework/design-tokens
```

Save this as `inspect-tokens.mjs` and run `node inspect-tokens.mjs` to check the
light background role and the palette color it references.

```js
import tokens from "@dads-framework/design-tokens/default.tokens.json" with { type: "json" };

console.log(tokens.light.surfaces.background.$value);
console.log(tokens.palette.grey["grey-970"].$value);
```

The first line prints `{palette.grey.grey-970}`. The second prints
`{ colorSpace: 'oklch', components: [ 0.97, 0, 70 ] }`.

## Use it

`palette` declares raw OKLCH colors. `light` declares semantic roles, such as
`primary` and `background`. `dark` overrides roles for dark mode. Color role
aliases point to the palette.

Use the JSON export when converting tokens to another platform or inspecting
the raw palette. For a React app with Tailwind, the [styles package](../styles/README.md)
provides the matching CSS roles and dark-mode overrides.

## Contract

The exported JSON contains colors, dimensions, and shadow layers. Resolve token
aliases before converting the document to platform values.

## What it refuses to do

Product branding belongs in the application's theme.
