#!/usr/bin/env python3
"""
Interpretation matrix for the two non-headline variants.

WHY THIS EXISTS
---------------
Our replay reproduces the team's HEADLINE numbers trade-for-trade (see compare.py),
but not the zero-cost variant. Its exit *decisions* match the stored results exactly
(2,258 stops / 1,267 targets / 264 cross-against), so the disagreement is purely in
which prices the zero-cost path uses for the entry and for each kind of exit.

This script enumerates every combination of plausible price conventions that keeps the
exit decisions fixed, and prints the resulting totals so the reader can see that the
stored zero-cost figure is not reproduced by any of them, and that the stored
OPTIMISTIC figure is reproduced exactly by one of them.

Run: python3 variant-matrix.py
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import replay as R

DATA = "/home/team/shared/backtest/data"

_cache = {}


def load():
    if _cache:
        return _cache
    for p in R.PAIRS:
        d = R.load_pair(os.path.join(DATA, p + ".jsonl"))
        d["_pair"] = p
        d["_pip"] = R.PIP.get(p, R.DEFAULT_PIP)
        d["_atr"] = R.atr_wilder(d["mh"], d["ml"], d["mc"], 14)
        e, x = R.rule_events(d)
        _cache[p] = (d, e, x)
    return _cache


def run(entry_mode="mid_open", level_fill="level", rule_fill="mid_open_next",
        gap_open=True, reanchor=False):
    """entry_mode: mid_open | mid_close_trigger | ba
       level_fill: level | mid_close | mid_open_next
       rule_fill : mid_open_next | mid_close_exitbar | mid_open_exitbar
    Stop/target detection is always on the mid high/low (that is what makes the exit
    decisions match the stored results)."""
    per = {}
    for p, (d, entries, exits) in load().items():
        t, mc, N, pip = d["t"], d["mc"], len(d["t"]), d["_pip"]
        tot = wins = n = 0
        totR = 0.0
        mix = {}
        for idx, ev in enumerate(entries):
            xv = exits[idx] if idx < len(exits) else None
            i, long_ = ev["bar"], ev["dir"] == "long"
            atr, anchor = d["_atr"][i], mc[i]
            stop = anchor - 1.5 * atr if long_ else anchor + 1.5 * atr
            target = anchor + 3.0 * atr if long_ else anchor - 3.0 * atr
            fb = i + 1
            if fb >= N:
                continue
            if entry_mode == "mid_open":
                entry = d["mo"][fb]
            elif entry_mode == "mid_close_trigger":
                entry = mc[i]
            else:
                entry = d["ao"][fb] if long_ else d["bo"][fb]
            if reanchor:
                stop = entry - 1.5 * atr if long_ else entry + 1.5 * atr
                target = entry + 3.0 * atr if long_ else entry - 3.0 * atr
            lim = xv["bar"] if xv else N - 1
            ep = er = None
            for j in range(fb, min(lim, N - 1) + 1):
                hi, lo, op = d["mh"][j], d["ml"][j], d["mo"][j]
                if long_:
                    if op <= stop: er = "stop"
                    elif op >= target: er = "target"
                    elif lo <= stop: er = "stop"
                    elif hi >= target: er = "target"
                    else: continue
                else:
                    if op >= stop: er = "stop"
                    elif op <= target: er = "target"
                    elif hi >= stop: er = "stop"
                    elif lo <= target: er = "target"
                    else: continue
                lvl = stop if er == "stop" else target
                gapped = (long_ and ((er == "stop" and op <= stop) or (er == "target" and op >= target))) or \
                         ((not long_) and ((er == "stop" and op >= stop) or (er == "target" and op <= target)))
                if level_fill == "level":
                    ep = op if (gapped and gap_open) else lvl
                elif level_fill == "mid_close":
                    ep = mc[j]
                else:
                    ep = d["mo"][j + 1] if j + 1 < N else mc[j]
                break
            if ep is None:
                f2 = lim + 1
                if f2 >= N:
                    continue
                if rule_fill == "mid_open_next":
                    ep = d["mo"][f2]
                elif rule_fill == "mid_close_exitbar":
                    ep = mc[lim]
                else:
                    ep = d["mo"][lim]
                er = "cross"
            pips = ((ep - entry) if long_ else (entry - ep)) / pip
            tot += pips
            n += 1
            totR += pips / (1.5 * atr / pip)
            mix[er] = mix.get(er, 0) + 1
            if pips > 0:
                wins += 1
        per[p] = (n, wins, round(tot, 1), round(totR, 2), mix)
    return per


def show(name, **kw):
    r = run(**kw)
    tot = round(sum(v[2] for v in r.values()), 1)
    wins = sum(v[1] for v in r.values())
    n = sum(v[0] for v in r.values())
    totR = round(sum(v[3] for v in r.values()), 2)
    print("%-46s n=%d wins=%d pips=%+.1f R=%+.2f  %s"
          % (name, n, wins, tot, totR, {p: v[2] for p, v in r.items()}))
    return tot


if __name__ == "__main__":
    print("STORED (results.json):")
    print("  zero-cost : n=3789 wins=1416 pips=+4289.1 R=+125.47")
    print("  optimistic: n=3789 wins=1275 pips=+3416.2 R=+115.74")
    print("\nzero-cost candidates (exit decisions fixed, prices varied):")
    show("mid_open entry, level fill, next-open exit  [ours]", )
    show("mid_open entry, level fill, no gap-to-open",
         gap_open=False)
    show("mid_open entry, levels re-anchored to entry", reanchor=True)
    show("mid_open entry, fill at bar close", level_fill="mid_close")
    show("mid_open entry, rule exit at exit-bar close", rule_fill="mid_close_exitbar")
    show("mid_open entry, rule exit at exit-bar open", rule_fill="mid_open_exitbar")
    show("ask/bid entry, level fill, mid exit", entry_mode="ba")
    print("\noptimistic candidates (entry at the trigger bar's mid close):")
    show("trigger-close entry, level fill, next-open exit [ours]",
         entry_mode="mid_close_trigger")
    show("trigger-close entry, level fill, exit-bar-close exit  <-- STORED",
         entry_mode="mid_close_trigger", rule_fill="mid_close_exitbar")
