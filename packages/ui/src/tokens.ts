/**
 * Shared ReplicantOS presentation tokens.
 *
 * CSS remains the canonical runtime representation. This typed mirror gives
 * application code stable names for canvas, chart, and non-CSS rendering.
 */
export const designTokens = {
  color: {
    canvas: "#070808",
    surface: "#0c0e0e",
    surfaceRaised: "#121414",
    line: "#292c2b",
    lineStrong: "#444846",
    ink: "#f3f4ef",
    inkMuted: "#a6aaa5",
    inkFaint: "#6f7470",
    signal: "#e5e8df",
    positive: "#bdc9bf",
    warning: "#c9c3b7",
  },
  font: {
    display:
      '"Arial Narrow", "Helvetica Neue", "Inter Tight", system-ui, sans-serif',
    body: 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
    mono: '"SFMono-Regular", "Cascadia Code", "Roboto Mono", Consolas, monospace',
  },
  radius: {
    xs: "0.25rem",
    sm: "0.5rem",
    md: "0.875rem",
    lg: "1.25rem",
    pill: "999px",
  },
  space: {
    1: "0.25rem",
    2: "0.5rem",
    3: "0.75rem",
    4: "1rem",
    6: "1.5rem",
    8: "2rem",
    12: "3rem",
    16: "4rem",
    24: "6rem",
  },
} as const;

export type DesignTokens = typeof designTokens;
