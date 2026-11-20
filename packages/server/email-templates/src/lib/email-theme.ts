/** Default palette for clients that require inline, literal CSS colors. */
const color = Object.freeze({
  /** `--background` — the concrete page a card lifts off. */
  background: "#f4f6f8",
  /** `--foreground` — body ink. */
  foreground: "#202730",
  /** `--card` — the white panel the message is written on. */
  card: "#ffffff",
  /** `--muted` — the quietest fill. */
  muted: "#eef1f5",
  /** `--muted-foreground` — secondary copy, 4.5:1 on card. */
  mutedForeground: "#525c69",
  /** `--table-header` — the band a data table stops the eye on. */
  tableHeader: "#edf0f4",
  /** `--border` — structural lines. */
  border: "#ccd4db",
  /** `--primary` — every safe action. */
  primary: "#304fa2",
  /** `--primary-foreground` — ink on a primary fill. */
  primaryForeground: "#ffffff",
  /** `--brand` — identity, never an action. */
  brand: "#563b83",
  /** `--logo-accent` · lockup cyan — the prompt in the wordmark, nowhere else. */
  logoAccent: "#3f7374",
  /** `--link` — inline links. */
  link: "#244f9b",
  /** `--success` — status only, always beside words. */
  success: "#126042",
  /** `--warning` — status only, always beside words. */
  warning: "#86530d",
  /** `--info` — status only, always beside words. */
  info: "#305a87",
  /** `--destructive` — consequence, distinct from decorative color. */
  destructive: "#94283b",
});

/**
 * Font stacks. No webfont: `@font-face` is stripped by most clients and a
 * download that fails leaves the message rendering in Times. IBM Plex is
 * named first for the readers who already have it, then the platform's own
 * UI face, then the generic family.
 */
const font = Object.freeze({
  sans: "'IBM Plex Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  mono: "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, 'Courier New', monospace",
});

/** Type sizes in px — `rem` is unreliable in Outlook, so the scale is absolute. */
const fontSize = Object.freeze({
  /** Section title, 1.5rem on the web. */
  heading: "24px",
  /** Subsection, 1.25rem on the web. */
  subheading: "20px",
  /** Prose and primary values, 1rem on the web. */
  body: "16px",
  /** Fields, metadata, footer, 0.875rem on the web. */
  label: "14px",
  /** A code a person reads aloud or types into a terminal. */
  code: "28px",
});

/** Line heights in px, paired with the sizes above. */
const lineHeight = Object.freeze({
  heading: "32px",
  subheading: "28px",
  body: "24px",
  label: "20px",
  code: "36px",
});

/** The 4px grid, in px: 4, 8, 16, 24, 32. */
const space = Object.freeze({
  xs: "4px",
  sm: "8px",
  md: "16px",
  lg: "24px",
  xl: "32px",
});

/** Corner radii in px. */
const radius = Object.freeze({
  sm: "4px",
  md: "6px",
  lg: "8px",
  card: "10px",
  pill: "999px",
});

/**
 * The one brand object every shared component and every template styles
 * from. Frozen so a template cannot quietly bend the palette for itself —
 * the way an email ends up with a fourth blue.
 */
export const emailTheme = Object.freeze({
  color,
  font,
  fontSize,
  lineHeight,
  space,
  radius,
  /**
   * The card the message sits on, in px. Narrower than the 600px every
   * client allows: a short message in a wide box reads as empty space.
   */
  cardWidth: 480,
  /**
   * Message width in px. 600 is the width every email client has agreed on
   * since Outlook 2007's reading pane; wider and Outlook clips.
   */
  contentWidth: 600,
});

/** The brand object's type, for a component that takes part of it. */
export type EmailTheme = typeof emailTheme;
