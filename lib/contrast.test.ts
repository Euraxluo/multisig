import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"

// WCAG 2.1 contrast pins for the design tokens in `app/globals.css`.
//
// These read the *shipped* token file rather than a hard-coded copy, so a token
// edit that breaks a threshold fails here instead of shipping. Only pairs the
// app actually renders are checked; a token combination nobody uses is not a
// regression, and inventing pairs would make the suite cry wolf.
//
// Ratios are computed from the HSL triplets in the stylesheet exactly as the
// browser resolves them, including the alpha composites used by error banners
// (`bg-destructive/10`) and status badges.

const CSS = readFileSync(join(__dirname, "..", "app", "globals.css"), "utf8")

type Rgb = [number, number, number]

function hslToRgb(h: number, s: number, l: number): Rgb {
  h /= 360
  s /= 100
  l /= 100
  if (s === 0) return [l, l, l]
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const channel = (t: number): number => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  return [channel(h + 1 / 3), channel(h), channel(h - 1 / 3)]
}

const linear = (c: number): number => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const luminance = ([r, g, b]: Rgb): number => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)

function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** Tailwind's `bg-x/NN` composites a colour over whatever is behind it. */
const over = (fg: Rgb, alpha: number, bg: Rgb): Rgb =>
  fg.map((c, i) => c * alpha + bg[i] * (1 - alpha)) as Rgb

/**
 * Pull `--name: H S% L%` out of one theme block. `.dark` must be read from its
 * own block: dark mode is a deliberate set of steps, not an inverted light one.
 */
function tokens(selector: string): Record<string, Rgb> {
  const start = CSS.indexOf(selector)
  assert.ok(start >= 0, `theme block ${selector} is missing from globals.css`)
  const open = CSS.indexOf("{", start)
  const close = CSS.indexOf("}", open)
  assert.ok(open >= 0 && close > open, `theme block ${selector} is malformed`)

  const found: Record<string, Rgb> = {}
  for (const line of CSS.slice(open, close).split("\n")) {
    const match = /--([a-z-]+):\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%/.exec(line)
    if (!match) continue
    found[match[1]] = hslToRgb(Number(match[2]), Number(match[3]), Number(match[4]))
  }
  return found
}

const light = tokens(":root {")
const dark = tokens(".dark {")

interface Pair {
  label: string
  fg: (t: Record<string, Rgb>) => Rgb
  bg: (t: Record<string, Rgb>) => Rgb
  min: number
}

// Normal text needs 4.5:1 (WCAG 1.4.3). Non-text UI boundaries and focus
// indicators need 3:1 (WCAG 1.4.11) — an input's own border is the only thing
// showing the field is interactive once the placeholder is replaced.
const PAIRS: Pair[] = [
  { label: "body text", fg: t => t.foreground, bg: t => t.background, min: 4.5 },
  { label: "card text", fg: t => t.foreground, bg: t => t.card, min: 4.5 },
  { label: "muted text on page", fg: t => t["muted-foreground"], bg: t => t.background, min: 4.5 },
  { label: "muted text on muted surface", fg: t => t["muted-foreground"], bg: t => t.muted, min: 4.5 },
  { label: "secondary label", fg: t => t["secondary-foreground"], bg: t => t.secondary, min: 4.5 },
  { label: "primary button label", fg: t => t["primary-foreground"], bg: t => t.primary, min: 4.5 },
  { label: "error text on page", fg: t => t.destructive, bg: t => t.background, min: 4.5 },
  { label: "error text on card", fg: t => t.destructive, bg: t => t.card, min: 4.5 },
  {
    label: "error text on bg-destructive/10 banner",
    fg: t => t.destructive,
    bg: t => over(t.destructive, 0.1, t.background),
    min: 4.5,
  },
  { label: "destructive button label", fg: t => t["destructive-foreground"], bg: t => t.destructive, min: 4.5 },
  { label: "input border", fg: t => t.input, bg: t => t.background, min: 3 },
  { label: "focus ring", fg: t => t.ring, bg: t => t.background, min: 3 },
  { label: "apple primary label on canvas", fg: t => t["label-primary"], bg: t => t["surface-canvas"], min: 4.5 },
  { label: "apple primary label on card", fg: t => t["label-primary"], bg: t => t["surface-card"], min: 4.5 },
  { label: "apple secondary label on canvas", fg: t => t["label-secondary"], bg: t => t["surface-canvas"], min: 4.5 },
  { label: "apple secondary label on card", fg: t => t["label-secondary"], bg: t => t["surface-card"], min: 4.5 },
]

for (const [theme, table] of [["light", light], ["dark", dark]] as const) {
  for (const { label, fg, bg, min } of PAIRS) {
    test(`${theme}: ${label} meets ${min}:1`, () => {
      const ratio = contrast(fg(table), bg(table))
      assert.ok(
        ratio >= min,
        `${theme} ${label} is ${ratio.toFixed(2)}:1, below the ${min}:1 minimum`,
      )
    })
  }
}

// === Gradient headers ===

const rgb = (hex: number): Rgb => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255]

// Every endpoint reachable through a `color` field: groups, bills, proposals
// and votes all store one of these Tailwind gradient pairs.
const GRADIENT_ENDPOINTS: Record<string, Rgb> = {
  "blue-500": rgb(0x3b82f6),
  "cyan-400": rgb(0x22d3ee),
  "green-500": rgb(0x22c55e),
  "emerald-400": rgb(0x34d399),
  "orange-500": rgb(0xf97316),
  "amber-400": rgb(0xfbbf24),
  "purple-500": rgb(0xa855f7),
  "violet-400": rgb(0xa78bfa),
  "pink-500": rgb(0xec4899),
  "rose-400": rgb(0xfb7185),
  "purple-600": rgb(0x9333ea),
}

// The header scrim is `bg-black/45`. Removing it drops the lightest endpoints
// (`amber-400` at 1.67:1) below anything readable, so this pins both the scrim
// alpha and the lightest colour the palette can put under it.
const HEADER_SCRIM = 0.45
const scrimmed = (c: Rgb): Rgb => over([0, 0, 0], HEADER_SCRIM, c)

for (const [name, endpoint] of Object.entries(GRADIENT_ENDPOINTS)) {
  test(`header white text on ${name} (scrimmed) meets 4.5:1`, () => {
    const ratio = contrast([1, 1, 1], scrimmed(endpoint))
    assert.ok(ratio >= 4.5, `white on scrimmed ${name} is ${ratio.toFixed(2)}:1`)
  })
}

// Grouping `--primary` here too: it is the `from-` endpoint of the default
// gradient on every generated card.
test("header white text on the default primary gradient (scrimmed) meets 4.5:1", () => {
  const ratio = contrast([1, 1, 1], scrimmed(light.primary))
  assert.ok(ratio >= 4.5, `white on scrimmed primary is ${ratio.toFixed(2)}:1`)
})

// The status chips drawn on the header are `bg-white/20 + text-white`; they sit
// above the scrim, so measure against the composited result.
test("header status chip (bg-white/20 + white text) meets 3:1 on every endpoint", () => {
  for (const [name, endpoint] of Object.entries(GRADIENT_ENDPOINTS)) {
    const bg = over([1, 1, 1], 0.2, scrimmed(endpoint))
    const ratio = contrast([1, 1, 1], bg)
    assert.ok(ratio >= 3, `chip on scrimmed ${name} is ${ratio.toFixed(2)}:1`)
  }
})

// Solid status badges introduced after the translucent versions failed.
test("solid status badges meet 4.5:1", () => {
  const badges: Array<[string, Rgb, Rgb]> = [
    ["rejected (light)", light["destructive-foreground"], light.destructive],
    ["rejected (dark)", dark["destructive-foreground"], dark.destructive],
    ["executed", [1, 1, 1], rgb(0x047857)], // emerald-700
  ]
  for (const [label, fg, bg] of badges) {
    const ratio = contrast(fg, bg)
    assert.ok(ratio >= 4.5, `${label} badge is ${ratio.toFixed(2)}:1`)
  }
})
