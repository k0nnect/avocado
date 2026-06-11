// Shared game-over classifier. Both site adapters surface the end of a game by
// reading whatever modal/status text the site shows ("won by checkmate", "on
// time", "Stalemate", "resigned", …) and running it through this matcher. Pure
// string work — keep it lenient, sites reword these strings often.

import type { GameEndKind } from './types.ts';

/** Classify a chunk of game-over UI text into a reason, or null. */
export function classifyGameOverText(text: string | null | undefined): GameEndKind | null {
  if (!text) return null;
  const t = text.toLowerCase();
  // order matters: check the most specific phrases first
  if (t.includes('checkmate') || t.includes('by mate')) return 'checkmate';
  if (t.includes('stalemate')) return 'stalemate';
  if (t.includes('resign')) return 'resign';
  if (t.includes('on time') || t.includes('time out') || t.includes('timeout') || t.includes('out of time'))
    return 'timewin';
  if (t.includes('abandon')) return 'resign';
  if (
    t.includes('draw') ||
    t.includes('drawn') ||
    t.includes('stalemate') ||
    t.includes('insufficient') ||
    t.includes('repetition') ||
    t.includes('agreement')
  )
    return 'draw';
  return null;
}

/**
 * Read the first matching element's text and classify it. Returns null if no
 * game-over UI is present (game ongoing).
 */
export function readGameOver(selectors: string[]): GameEndKind | null {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    const kind = classifyGameOverText(el?.textContent);
    if (kind) return kind;
  }
  return null;
}
