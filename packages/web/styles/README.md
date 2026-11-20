# @dads-framework/styles

The default stylesheet for Dads React components and Tailwind CSS 4 apps.

## Try it

In your application's Tailwind CSS entry point, import the theme and scan the
installed UI package. Adjust the source path relative to your stylesheet.

```css
@import "@dads-framework/styles/index.css";
@source "../node_modules/@dads-framework/ui/dist";
```

## Use it

`index.css` imports the palette, semantic roles, dark overrides, Tailwind
utilities, and fonts. Add `dark` to the application root for dark mode. To
customize the theme, override semantic CSS variables in your application after
the theme import. An element with `className="bg-background text-foreground"`
uses the same role names in both modes and changes colors when the root mode
changes.

## Contract

The CSS exposes roles such as `--primary`, `--background`, and
`--foreground`, alongside Tailwind utilities such as `bg-primary` and
`text-foreground`. The light and dark modes share those role names.

## What it refuses to do

Your application chooses the active mode and supplies product branding.

The font stylesheet imports the Latin IBM Plex Sans and Mono subsets from
Fontsource dependencies. The font software uses the SIL Open Font License
1.1 with reserved font name “Plex”. [IBM Plex license](https://github.com/IBM/plex/blob/master/LICENSE.txt)
