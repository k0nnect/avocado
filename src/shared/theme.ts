// avocado visual identity — lowercase violet.
// Single source of truth for the palette, shared by the canvas overlay, the
// commentary ticker, and the popup. Keep everything lowercase in UI copy.

export const VIOLET = {
  // backgrounds
  bg: '#16121f', // near-black violet
  bgPanel: '#1e1830',
  bgPanelAlpha: 'rgba(30, 24, 48, 0.92)',

  // brand violets, dark → light
  primary: '#7c3aed', // pv1 / best
  mid: '#a78bfa', // pv2 / secondary
  soft: '#c4b5fd', // pv3 / tertiary, pit

  // semantics (still violet-leaning, but readable)
  good: '#86efac', // winning swing
  bad: '#fb7185', // blunder / hung piece
  text: '#ede9fe',
  textDim: '#9d8fc4',
} as const;

// Multi-PV arrow colours, indexed by rank (0 = best).
export const PV_COLORS = [VIOLET.primary, VIOLET.mid, VIOLET.soft, '#ddd6fe'] as const;

// Opponent-reply guess arrow (drawn translucent).
export const OPP_COLOR = VIOLET.bad;

export const FONT_STACK =
  "'SFMono-Regular', 'JetBrains Mono', 'Menlo', 'Consolas', monospace";

/** lowercase a string the avocado way (used so UI copy stays on-brand). */
export function lc(s: string): string {
  return s.toLowerCase();
}
