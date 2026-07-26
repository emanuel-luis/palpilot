import type { Config } from "tailwindcss";

/**
 * PalPilot console — design tokens.
 *
 * Dark-first navy. Every colour is a CSS variable so the light variant is the
 * same system rather than a second stylesheet, and `data-theme` on <html> (set
 * by lib/theme.ts) is the switch.
 *
 * Colour discipline that matters here:
 *   - `signal` (blue) is the only accent used for actions.
 *   - `ion` (cyan) is reserved for things CURRENTLY MOVING — live chart strokes,
 *     the running-cost meter, streaming log indicator. Never decoration.
 *   - status hues are the only saturated colours on the page.
 */
export default {
  darkMode: ["class", '[data-theme="dark"]'],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "hsl(var(--bg) / <alpha-value>)",
        surface: "hsl(var(--surface) / <alpha-value>)",
        "surface-2": "hsl(var(--surface-2) / <alpha-value>)",
        line: "hsl(var(--line) / <alpha-value>)",
        fg: "hsl(var(--fg) / <alpha-value>)",
        muted: "hsl(var(--muted) / <alpha-value>)",
        faint: "hsl(var(--faint) / <alpha-value>)",
        signal: "hsl(var(--signal) / <alpha-value>)",
        "signal-fg": "hsl(var(--signal-fg) / <alpha-value>)",
        ion: "hsl(var(--ion) / <alpha-value>)",
        ok: "hsl(var(--ok) / <alpha-value>)",
        warn: "hsl(var(--warn) / <alpha-value>)",
        danger: "hsl(var(--danger) / <alpha-value>)",
        ring: "hsl(var(--ring) / <alpha-value>)",
      },
      borderRadius: {
        // Brief: 10–14px. Nothing sharper, nothing pill-shaped except badges.
        md: "10px",
        lg: "12px",
        xl: "14px",
      },
      // 8px grid. The named steps below are the only spacings used.
      spacing: {
        1: "4px",
        2: "8px",
        3: "12px",
        4: "16px",
        5: "24px",
        6: "32px",
        7: "40px",
        8: "48px",
        9: "64px",
      },
      fontFamily: {
        sans: ["ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "Inter", "sans-serif"],
        // Every number, ID and metric renders here, with tabular figures.
        mono: ["ui-monospace", "SFMono-Regular", "SF Mono", "Menlo", "Consolas", "monospace"],
      },
      fontSize: {
        "2xs": ["11px", { lineHeight: "16px", letterSpacing: "0.08em" }],
        xs: ["12px", { lineHeight: "18px" }],
        sm: ["13px", { lineHeight: "20px" }],
        base: ["14px", { lineHeight: "22px" }],
        lg: ["16px", { lineHeight: "24px" }],
        xl: ["20px", { lineHeight: "28px", letterSpacing: "-0.01em" }],
        "2xl": ["26px", { lineHeight: "32px", letterSpacing: "-0.02em" }],
        "3xl": ["34px", { lineHeight: "40px", letterSpacing: "-0.02em" }],
      },
      boxShadow: {
        // Soft elevation instead of heavy borders (brief).
        soft: "0 1px 2px hsl(var(--shadow) / 0.28), 0 2px 8px hsl(var(--shadow) / 0.22)",
        lift: "0 8px 24px hsl(var(--shadow) / 0.34)",
        pop: "0 16px 48px hsl(var(--shadow) / 0.46)",
        "glow-ok": "0 0 0 1px hsl(var(--ok) / 0.4), 0 0 24px hsl(var(--ok) / 0.28)",
        "glow-warn": "0 0 0 1px hsl(var(--warn) / 0.4), 0 0 24px hsl(var(--warn) / 0.3)",
      },
      transitionDuration: { fast: "150ms", DEFAULT: "180ms", slow: "250ms" },
      transitionTimingFunction: { out: "cubic-bezier(0.22, 1, 0.36, 1)" },
      keyframes: {
        "fade-up": { from: { opacity: "0", transform: "translateY(6px)" }, to: { opacity: "1", transform: "none" } },
        "ring-spin": { to: { transform: "rotate(360deg)" } },
        breathe: { "0%,100%": { opacity: "0.55" }, "50%": { opacity: "1" } },
        shimmer: { "100%": { transform: "translateX(100%)" } },
      },
      animation: {
        "fade-up": "fade-up 250ms cubic-bezier(0.22,1,0.36,1) both",
        "ring-spin": "ring-spin 2.4s linear infinite",
        breathe: "breathe 2.4s ease-in-out infinite",
        shimmer: "shimmer 1.6s infinite",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
} satisfies Config;
