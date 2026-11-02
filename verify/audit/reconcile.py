#!/usr/bin/env python3
"""Aggregate reconciliation: ours-independent.json vs the team's results.json,
plus data facts the report asserts (bar counts, period start, bar spacing)."""
import json, sys, datetime
sys.path.insert(0,'.')
import replay as R

ours=json.load(open('ours-independent.json'))
theirs=json.load(open('/home/team/shared/backtest/results.json'))
VAR={'headline':'headline_nextBarOpen_bidAsk','zero':'zeroCost_mid_nextBarOpen','optimistic':'optimisticUpperBound_triggerClose'}
out={'aggregates':[], 'data_facts':{}, 'year_by_year':[]}

def U(ts): return datetime.datetime.fromtimestamp(ts,datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M')

# ---- bar spacing facts
facts={}
for p in R.PAIRS:
    d=R.load_pair('/home/team/shared/backtest/data/%s.jsonl'%p)
    t=d['t']
    gaps=[t[i+1]-t[i] for i in range(len(t)-1)]
    # index at which the series becomes "genuinely hourly": last bar before which
    # more than 20% of gaps exceed one hour
    last_sparse=0
    win=gaps[:300]
    for i in range(0,min(3000,len(gaps))):
        seg=gaps[i:i+50]
        if seg and sum(1 for g in seg if g>3600)/len(seg)>0.2: last_sparse=i+50
    facts[p]={'bars':len(t),'first_bar_utc':U(t[0]),'last_bar_utc':U(t[-1]),
              'bars_with_gap_gt_1h_in_first_300':sum(1 for g in gaps[:300] if g>3600),
              'index_where_series_becomes_hourly':last_sparse,
              'utc_at_that_index':U(t[min(last_sparse,len(t)-1)]),
              'bar_at_index_200_utc':U(t[200])}
out['data_facts']=facts

# ---- aggregates
def row(name,o,t,key,tkey):
    return {'metric':name,'ours':o,'theirs':t,'match':(abs(o-t)<1e-6) if isinstance(o,(int,float)) and isinstance(t,(int,float)) else o==t}
for variant,tk in VAR.items():
    t=theirs['results'][tk]['fullPeriod']['combined']
    o=ours['combined'][variant]
    pairs=[('trades','trades'),('wins','wins'),('losses','losses'),('win_rate_pct','winRatePct'),
           ('total_pips','totalPips'),('total_r','totalR'),('avg_r','avgRPerTrade'),
           ('profit_factor','profitFactor'),('max_dd_pips','maxDrawdownPips'),
           ('max_dd_r','maxDrawdownR'),('longest_losing_streak','longestLosingStreak'),
           ('avg_win_pips','avgWinPips'),('avg_loss_pips','avgLossPips'),('expectancy_pips','expectancyPipsPerTrade')]
    for a,b in pairs:
        ov=o.get(a); tv=t.get(b)
        if ov is None or tv is None: continue
        if isinstance(ov,(int,float)) and isinstance(tv,(int,float)):
            m = abs(ov-tv) <= max(1e-6, abs(tv)*1e-4)
        else: m=None
        out['aggregates'].append({'variant':variant,'metric':a,'ours':ov,'theirs':tv,'match':m})
    # per pair
    for p,tp in theirs['results'][tk]['fullPeriod']['perPair'].items():
        po=ours['pairs'][p.replace('/','_')][variant]
        for a,b in (('trades','trades'),('total_pips','totalPips'),('total_r','totalR'),('win_rate_pct','winRatePct'),('profit_factor','profitFactor'),('max_dd_pips','maxDrawdownPips'),('longest_losing_streak','longestLosingStreak'),('wins','wins')):
            ov=po.get(a); tv=tp.get(b)
            if ov is None or tv is None: continue
            out['aggregates'].append({'variant':variant,'pair':p,'metric':a,'ours':ov,'theirs':tv,
                                      'match': abs(ov-tv)<=max(1e-6,abs(tv)*1e-4) if isinstance(ov,(int,float)) else None})
    # holdout
    th=theirs['results'][tk]['last12MonthsHeldOut']['combined']
    oh=ours['combined'][variant]['holdout_12m']
    for a,b in (('trades','trades'),('total_pips','totalPips'),('total_r','totalR'),('win_rate_pct','winRatePct'),('profit_factor','profitFactor'),('max_dd_pips','maxDrawdownPips'),('longest_losing_streak','longestLosingStreak'),('wins','wins')):
        if oh.get(a) is None or th.get(b) is None: continue
        out['aggregates'].append({'variant':variant,'window':'holdout','metric':a,'ours':oh[a],'theirs':th[b],
                                  'match': abs(oh[a]-th[b])<=max(1e-6,abs(th[b])*1e-4) if isinstance(oh[a],(int,float)) else None})

# ---- year by year
ty={x['year']:x for x in theirs['yearByYear']['headline']['combined']}
oy=ours['combined']['headline']['by_year']
for y in sorted(set(list(ty.keys())+[str(k) for k in oy.keys()])):
    o=oy.get(str(y)); t=ty.get(y)
    out['year_by_year'].append({'year':y,'ours_trades':o[0] if o else None,'ours_pips':o[1] if o else None,
                                'theirs_trades':t['trades'] if t else None,'theirs_pips':t['totalPips'] if t else None})

json.dump(out,open('reconciliation.json','w'),indent=1)
bad=[a for a in out['aggregates'] if a['match'] is False]
print("aggregate rows:",len(out['aggregates'])," mismatches:",len(bad))
for b in bad: print("  MISMATCH",b)
print("\nDATA FACTS")
for p,f in facts.items(): print(" ",p,f)
print("\nYEAR BY YEAR (headline)")
for y in out['year_by_year']:
    flag='' if (y['ours_pips'] is not None and y['theirs_pips'] is not None and abs(y['ours_pips']-y['theirs_pips'])<0.15) else '  <-- DIFF'
    print("  %s ours %4s %9s | theirs %4s %9s%s"%(y['year'],y['ours_trades'],y['ours_pips'],y['theirs_trades'],y['theirs_pips'],flag))
