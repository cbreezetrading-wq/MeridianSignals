import type { Bar } from "./types";

/**
 * Indicator maths for the Meridian Signals ruleset. Pure functions, no I/O.
 * The exact definitions here are the ones written down in /home/team/shared/ruleset.md;
 * any change to this file is a change to the ruleset and must be made there too.
 */

/**
 * Standard EMA with k = 2/(n+1), seeded with the simple average of the first `n`
 * values. Index i of the result is the EMA of values[0..i]; entries before
 * index n-1 are `null` because the EMA is undefined there.
 */
export function ema(values: number[], n: number): (number | null)[] {
  const out: (number | null)[] = new Array<number | null>(values.length).fill(null);
  if (n <= 0 || values.length < n) return out;
  let seed = 0;
  for (let i = 0; i < n; i++) seed += values[i]!;
  let prev = seed / n;
  out[n - 1] = prev;
  const k = 2 / (n + 1);
  for (let i = n; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder's average true range. Index i is ATR(i) over bars[0..i]; null before index n-1. */
export function atr(bars: Bar[], n: number): (number | null)[] {
  const out: (number | null)[] = new Array<number | null>(bars.length).fill(null);
  if (bars.length < n || n <= 0) return out;
  const tr: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    if (i === 0) {
      tr.push(b.h - b.l);
      continue;
    }
    const pc = bars[i - 1]!.c;
    tr.push(Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc)));
  }
  let sum = 0;
  for (let i = 0; i < n; i++) sum += tr[i]!;
  let prev = sum / n;
  out[n - 1] = prev;
  for (let i = n; i < bars.length; i++) {
    prev = (prev * (n - 1) + tr[i]!) / n;
    out[i] = prev;
  }
  return out;
}

/** The last non-null entry, or null if there is none. */
export function lastDefined(values: (number | null)[]): number | null {
  for (let i = values.length - 1; i >= 0; i--) {
    const v = values[i];
    if (v !== null && v !== undefined && Number.isFinite(v)) return v;
  }
  return null;
}

/** Format a price at a pair's conventional precision. Display only. */
export function fmt(value: number | null, decimals: number): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  return value.toFixed(decimals);
}
