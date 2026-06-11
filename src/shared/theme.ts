// avocado visual identity — lowercase mauve / lilac.
// Single source of truth for the palette, shared by the canvas overlay, the
// commentary ticker, and the popup. Keep everything lowercase in UI copy.
// (Export name stays VIOLET for import stability; the values are the mauve set.)

export const VIOLET = {
  // backgrounds — near-black with a cool violet tint
  bg: '#11111b',
  bgPanel: '#181825',
  bgPanelAlpha: 'rgba(24, 24, 37, 0.94)',

  // brand mauve → lilac → lavender, dark → light
  primary: '#cba6f7', // mauve · pv1 / best
  mid: '#b4befe', // lavender · pv2 / secondary
  soft: '#dabffc', // light lilac · pv3 / tertiary, pit

  // semantics
  good: '#a6e3a1', // winning swing
  bad: '#f38ba8', // blunder / hung piece
  text: '#cdd6f4',
  textDim: '#9399b2',
} as const;

// Multi-PV arrow colours, indexed by rank (0 = best).
export const PV_COLORS = [VIOLET.primary, VIOLET.mid, VIOLET.soft, '#f5c2e7'] as const;

// Opponent-reply guess arrow (drawn translucent).
export const OPP_COLOR = VIOLET.bad;

export const FONT_STACK =
  "'SFMono-Regular', 'JetBrains Mono', 'Menlo', 'Consolas', monospace";

/** lowercase a string the avocado way (used so UI copy stays on-brand). */
export function lc(s: string): string {
  return s.toLowerCase();
}
