#!/usr/bin/env python3
"""
Independent replay of Meridian ruleset v1 (H1), written from
/home/team/shared/verify/ruleset-spec.md.

This is NOT a port of the team's replay. It was written from the written spec
before the team's results file was opened. No code, structure or helper from
backtest/run_backtest.ts or site/src/lib/market/* was read or reused.

Data: /home/team/shared/backtest/data/<PAIR>.jsonl
  line = [t, mid o,h,l,c, ask o,h,l,c, bid o,h,l,c]   t = bar OPEN, unix secs UTC

Usage: python3 replay.py [--data DIR] [--out FILE]
"""
import json
import os
import sys

PAIRS = ["EUR_USD", "GBP_USD", "USD_JPY", "AUD_USD"]
PIP = {"USD_JPY": 0.01}
DEFAULT_PIP = 0.0001

SCAN_START = 200          # first bar index the rule may fire on (spec 4.9)
STOP_ATR = 1.5            # spec 4.5
TARGET_ATR = 3.0          # spec 4.6

HOLDOUT_START = 1760227200  # 2025-10-12T00:00:00Z
HOLDOUT_END = 1792454400    # 2026-10-13T00:00:00Z exclusive


# ---------------------------------------------------------------- data loading
def load_pair(path):
    """Return dict of lists: t, mo,mh,ml,mc, ao,ah,al,ac, bo,bh,bl,bc."""
    cols = [[] for _ in range(13)]
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            if len(row) != 13:
                raise ValueError("bad row len in %s: %r" % (path, row))
            for i, v in enumerate(row):
                cols[i].append(v)
    keys = ["t", "mo", "mh", "ml", "mc", "ao", "ah", "al", "ac",
            "bo", "bh", "bl", "bc"]
    return {k: c for k, c in zip(keys, cols)}


# ------------------------------------------------------------------ indicators
def ema(values, n):
    """SMA seed of the first n values, then k=2/(n+1) forward. None before n-1."""
    out = [None] * len(values)
    if len(values) < n:
        return out
    seed = sum(values[:n]) / n
    out[n - 1] = seed
    k = 2.0 / (n + 1.0)
    prev = seed
    for i in range(n, len(values)):
        prev = values[i] * k + prev * (1.0 - k)
        out[i] = prev
    return out


def atr_wilder(high, low, close, n=14):
    """Wilder ATR. TR[0]=h0-l0; ATR[n-1]=mean(TR[0..n-1]); then Wilder recursion."""
    m = len(close)
    tr = [0.0] * m
    if m == 0:
        return [None] * m
    tr[0] = high[0] - low[0]
    for i in range(1, m):
        hl = high[i] - low[i]
        hc = abs(high[i] - close[i - 1])
        lc = abs(low[i] - close[i - 1])
        tr[i] = max(hl, hc, lc)
    out = [None] * m
    if m < n:
        return out
    out[n - 1] = sum(tr[:n]) / n
    prev = out[n - 1]
    for i in range(n, m):
        prev = (prev * (n - 1) + tr[i]) / n
        out[i] = prev
    return out


# --------------------------------------------------------------- rule signals
def rule_events(d):
    """State machine of spec section 4. Returns (entries, exits) lists.

    entry: {'bar': i, 'dir': 'long'|'short'}
    exit : {'bar': i}          # paired 1:1, in order, with the entries
    """
    mc = d["mc"]
    n = len(mc)
    e20 = ema(mc, 20)
    e50 = ema(mc, 50)
    e200 = ema(mc, 200)
    entries, exits = [], []
    state = "flat"
    for i in range(SCAN_START, n):
        a20p, a50p = e20[i - 1], e50[i - 1]
        a20, a50 = e20[i], e50[i]
        if None in (a20p, a50p, a20, a50, e200[i]):
            continue
        cross_up = a20p <= a50p and a20 > a50
        cross_dn = a20p >= a50p and a20 < a50
        trend_up = a50 > e200[i]
        trend_dn = a50 < e200[i]
        flip_dn = a50 < e200[i] and e50[i - 1] >= e200[i - 1]
        flip_up = a50 > e200[i] and e50[i - 1] <= e200[i - 1]
        if state == "flat":
            if cross_up and trend_up:
                state = "long"
                entries.append({"bar": i, "dir": "long"})
            elif cross_dn and trend_dn:
                state = "short"
                entries.append({"bar": i, "dir": "short"})
        elif state == "long":
            if cross_dn:
                state = "flat"
                exits.append({"bar": i, "reason": "cross_against"})
            elif flip_dn:
                state = "flat"
                exits.append({"bar": i, "reason": "trend_flip"})
        else:  # short
            if cross_up:
                state = "flat"
                exits.append({"bar": i, "reason": "cross_against"})
            elif flip_up:
                state = "flat"
                exits.append({"bar": i, "reason": "trend_flip"})
    return entries, exits


# --------------------------------------------------------------- trade filling
def simulate(d, entries, exits, variant):
    """Fill the entry/exit event stream. variant in {'headline','zero','optimistic'}.

    Returns list of trades dicts (only completed ones).
    """
    t, mc = d["t"], d["mc"]
    n = len(t)
    trades = []
    report_open = []
    for idx, ev in enumerate(entries):
        # pair entry k with exit k (the state machine alternates); an entry with no
        # following exit event is still a trade and must be scanned to the last bar.
        xv = exits[idx] if idx < len(exits) else None
        i = ev["bar"]
        direction = ev["dir"]
        long_ = direction == "long"
        atr = d["_atr"][i]
        anchor = mc[i]
        stop = anchor - STOP_ATR * atr if long_ else anchor + STOP_ATR * atr
        target = anchor + TARGET_ATR * atr if long_ else anchor - TARGET_ATR * atr
        risk_pips = (STOP_ATR * atr) / d["_pip"]

        if variant == "optimistic":
            fill_bar = i
            entry_px = anchor
        else:
            fill_bar = i + 1
            if fill_bar >= n:
                continue  # signal on the last bar: no fill possible
            entry_px = (d["ao"][fill_bar] if long_ else d["bo"][fill_bar]) \
                if variant == "headline" else d["mo"][fill_bar]

        # bars whose range can breach stop/target
        first_scan = fill_bar if variant != "optimistic" else fill_bar + 1
        exit_bar_limit = xv["bar"] if xv is not None else (n - 1)
        exit_px = None
        exit_reason = None
        exit_bar = None

        for j in range(first_scan, min(exit_bar_limit, n - 1) + 1):
            if variant == "headline":
                hi, lo, op = (d["bh"][j], d["bl"][j], d["bo"][j]) if long_ \
                    else (d["ah"][j], d["al"][j], d["ao"][j])
            else:
                hi, lo, op = d["mh"][j], d["ml"][j], d["mo"][j]
            if long_:
                if op <= stop:
                    exit_px, exit_reason, exit_bar = op, "stop", j
                    break
                if op >= target:
                    exit_px, exit_reason, exit_bar = op, "target", j
                    break
                if lo <= stop:                       # tie -> stop (pessimistic)
                    exit_px, exit_reason, exit_bar = stop, "stop", j
                    break
                if hi >= target:
                    exit_px, exit_reason, exit_bar = target, "target", j
                    break
            else:
                if op >= stop:
                    exit_px, exit_reason, exit_bar = op, "stop", j
                    break
                if op <= target:
                    exit_px, exit_reason, exit_bar = op, "target", j
                    break
                if hi >= stop:
                    exit_px, exit_reason, exit_bar = stop, "stop", j
                    break
                if lo <= target:
                    exit_px, exit_reason, exit_bar = target, "target", j
                    break

        if exit_px is None:
            # rule exit, filled at the next bar's open
            fb = exit_bar_limit + 1
            if fb >= n:
                report_open.append(ev)   # still open at the end of the data: not a result
                continue
            if variant == "headline":
                exit_px = d["bo"][fb] if long_ else d["ao"][fb]
            else:
                exit_px = d["mo"][fb]
            exit_bar = fb
            # label: cross against, or trend flip (recomputed for the report)
            exit_reason = xv.get("reason", "rule_exit") if xv else "rule_exit"

        pips = ((exit_px - entry_px) if long_ else (entry_px - exit_px)) / d["_pip"]
        trades.append({
            "pair": d["_pair"],
            "dir": direction,
            "signal_bar": i,
            "signal_t": t[i],
            "entry_bar": fill_bar if variant != "optimistic" else fill_bar,
            "entry_t": t[fill_bar],
            "entry_px": entry_px,
            "exit_t": t[exit_bar] if exit_bar < n else None,
            "exit_px": exit_px,
            "exit_reason": exit_reason,
            "pips": pips,
            "risk_pips": risk_pips,
            "r": pips / risk_pips if risk_pips else None,
            "hold_hours": (t[exit_bar] - t[fill_bar]) / 3600.0 if exit_bar < n else None,
        })
    simulate.open_signals = len(report_open)
    return trades


# ------------------------------------------------------------------ statistics
def stats(trades, label=""):
    n = len(trades)
    out = {"label": label, "trades": n}
    if n == 0:
        return out
    wins = [x for x in trades if x["pips"] > 0]
    losses = [x for x in trades if x["pips"] <= 0]
    gp = sum(x["pips"] for x in wins)
    gl = -sum(x["pips"] for x in losses)
    total = sum(x["pips"] for x in trades)
    total_r = sum(x["r"] for x in trades)
    out.update({
        "wins": len(wins),
        "losses": len(losses),
        "win_rate_pct": round(100.0 * len(wins) / n, 2),
        "avg_win_pips": round(gp / len(wins), 2) if wins else None,
        "avg_loss_pips": round(-gl / len(losses), 2) if losses else None,
        "expectancy_pips": round(total / n, 2),
        "total_pips": round(total, 1),
        "total_r": round(total_r, 1),
        "avg_r": round(total_r / n, 4),
        "profit_factor": round(gp / gl, 2) if gl > 0 else None,
    })
    # drawdown on the realised-equity curve (ordered by exit time, spec 5.5c)
    ordered = sorted(trades, key=lambda x: (x["exit_t"] if x["exit_t"] else 0))
    peak_p = peak_r = 0.0
    cum_p = cum_r = 0.0
    dd_p = dd_r = 0.0
    for x in ordered:
        cum_p += x["pips"]
        cum_r += x["r"]
        peak_p = max(peak_p, cum_p)
        peak_r = max(peak_r, cum_r)
        dd_p = max(dd_p, peak_p - cum_p)
        dd_r = max(dd_r, peak_r - cum_r)
    out["max_dd_pips"] = round(dd_p, 1)
    out["max_dd_r"] = round(dd_r, 1)
    # longest losing streak
    best = cur = 0
    for x in ordered:
        if x["pips"] <= 0:
            cur += 1
            best = max(best, cur)
        else:
            cur = 0
    out["longest_losing_streak"] = best
    mix = {}
    for x in ordered:
        mix[x["exit_reason"]] = mix.get(x["exit_reason"], 0) + 1
    out["exit_mix"] = mix
    holds = sorted(x["hold_hours"] for x in ordered if x["hold_hours"] is not None)
    if holds:
        out["hold_hours_median"] = round(holds[len(holds) // 2], 1)
        out["hold_hours_mean"] = round(sum(holds) / len(holds), 1)
        out["hold_hours_p90"] = round(holds[int(len(holds) * 0.9)], 1)
        out["hold_hours_max"] = round(holds[-1], 1)
    return out


def year_breakdown(trades):
    by = {}
    for x in trades:
        y = int(__import__("datetime").datetime.fromtimestamp(
            x["entry_t"], __import__("datetime").timezone.utc).year)
        by.setdefault(y, [0, 0.0])
        by[y][0] += 1
        by[y][1] += x["pips"]
    return {y: [v[0], round(v[1], 1)] for y, v in sorted(by.items())}


# ------------------------------------------------------------------------ main
def main():
    data_dir = "/home/team/shared/backtest/data"
    out_path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            "ours-independent.json")
    args = sys.argv[1:]
    if "--data" in args:
        data_dir = args[args.index("--data") + 1]
    if "--out" in args:
        out_path = args[args.index("--out") + 1]

    report = {"spec": "/home/team/shared/verify/ruleset-spec.md",
              "data_dir": data_dir, "pairs": {}, "data_facts": {}}

    per_variant = {"headline": [], "zero": [], "optimistic": []}

    for pair in PAIRS:
        d = load_pair(os.path.join(data_dir, pair + ".jsonl"))
        d["_pair"] = pair
        d["_pip"] = PIP.get(pair, DEFAULT_PIP)
        d["_atr"] = atr_wilder(d["mh"], d["ml"], d["mc"], 14)

        # data facts: bar count, first/last, and how many early bars are not hourly
        t = d["t"]
        gaps = [t[i + 1] - t[i] for i in range(min(600, len(t) - 1))]
        non_hourly_early = sum(1 for g in gaps if g > 3600)
        first_hourly_idx = next((i for i in range(len(t) - 1)
                                 if t[i + 1] - t[i] == 3600), None)
        report["data_facts"][pair] = {
            "bars": len(t),
            "first_utc": __import__("datetime").datetime.fromtimestamp(
                t[0], __import__("datetime").timezone.utc).isoformat(),
            "last_utc": __import__("datetime").datetime.fromtimestamp(
                t[-1], __import__("datetime").timezone.utc).isoformat(),
            "non_hourly_gaps_in_first_600": non_hourly_early,
            "first_hourly_bar_index": first_hourly_idx,
            "bar_at_scan_start_200_utc": __import__("datetime").datetime.fromtimestamp(
                t[SCAN_START], __import__("datetime").timezone.utc).isoformat(),
            "spread_pips_mean_all_bars": round(
                sum((d["ao"][i] - d["bo"][i]) / d["_pip"] for i in range(len(t))) / len(t), 2),
        }

        entries, exits = rule_events(d)
        report["data_facts"][pair]["entry_events"] = len(entries)
        report["data_facts"][pair]["exit_events"] = len(exits)

        for variant in ("headline", "zero", "optimistic"):
            tr = simulate(d, entries, exits, variant)
            per_variant[variant].extend(tr)
            report["pairs"].setdefault(pair, {})[variant] = stats(tr, pair + "/" + variant)

    # combined + held-out
    combined = {}
    for variant in ("headline", "zero", "optimistic"):
        tr = per_variant[variant]
        s = stats(tr, "combined/" + variant)
        hold = [x for x in tr if HOLDOUT_START <= x["entry_t"] < HOLDOUT_END]
        s["holdout_12m"] = stats(hold, "holdout/" + variant)
        s["holdout_by_pair"] = {
            p: [len([x for x in hold if x["pair"] == p]),
                round(sum(x["pips"] for x in hold if x["pair"] == p), 1)]
            for p in PAIRS}
        s["by_year"] = year_breakdown(tr)
        combined[variant] = s
    report["combined"] = combined

    # spread actually paid at entry, per pair, headline (ask open - bid open on the fill bar)
    spread_at_entry = {}
    for pair in PAIRS:
        d = load_pair(os.path.join(data_dir, pair + ".jsonl"))
        d["_pip"] = PIP.get(pair, DEFAULT_PIP)
        rows = []
        for x in per_variant["headline"]:
            if x["pair"] != pair:
                continue
            b = x["entry_bar"]
            rows.append((d["ao"][b] - d["bo"][b]) / d["_pip"])
        if rows:
            rows.sort()
            spread_at_entry[pair] = {
                "mean": round(sum(rows) / len(rows), 2),
                "median": round(rows[len(rows) // 2], 2),
            }
    report["spread_at_entry_pips"] = spread_at_entry

    with open(out_path, "w") as fh:
        json.dump(report, fh, indent=1, default=str)
    print("wrote", out_path)
    for variant in ("headline", "zero", "optimistic"):
        s = report["combined"][variant]
        print("%-11s n=%d total=%+.1f pips  win=%.2f%%  PF=%s  R=%+.1f  maxDD=%.0fp/%.1fR  LLS=%d"
              % (variant, s["trades"], s["total_pips"], s["win_rate_pct"],
                 s["profit_factor"], s["total_r"], s["max_dd_pips"],
                 s["max_dd_r"], s["longest_losing_streak"]))
    print("data facts:")
    for p, f in report["data_facts"].items():
        print(" ", p, f["bars"], "scan@200:", f["bar_at_scan_start_200_utc"],
              "first hourly idx:", f["first_hourly_bar_index"],
              "entries:", f["entry_events"])


if __name__ == "__main__":
    main()
