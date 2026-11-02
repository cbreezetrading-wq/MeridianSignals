#!/usr/bin/env python3
"""Trade-by-trade comparison: our independent replay vs the team's stored results.json.
Reads only the stored RESULTS (never the team's replay code)."""
import json, sys, datetime
sys.path.insert(0,'/home/team/shared/verify/audit')
import replay as R

theirs=json.load(open('/home/team/shared/backtest/results.json'))
tt=theirs['tradesHeadline']

def utc(ts):
    return datetime.datetime.fromtimestamp(ts,datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')

ours={}
for p in R.PAIRS:
    d=R.load_pair('/home/team/shared/backtest/data/%s.jsonl'%p)
    d['_pair']=p; d['_pip']=R.PIP.get(p,R.DEFAULT_PIP)
    d['_atr']=R.atr_wilder(d['mh'],d['ml'],d['mc'],14)
    e,x=R.rule_events(d)
    ours[p]=R.simulate(d,e,x,'headline')

FIELDS=[('side',lambda o:o['dir'],None),
        ('fillBarUtc',lambda o:utc(o['entry_t']),None),
        ('fillPrice',lambda o:o['entry_px'],1e-9),
        ('exitBarUtc',lambda o:utc(o['exit_t']),None),
        ('exitPrice',lambda o:o['exit_px'],1e-9),
        ('exitReason',lambda o:o['exit_reason'],None),
        ('pips',lambda o:o['pips'],1e-6),
        ('r',lambda o:o['r'],1e-6),
        ('riskPips',lambda o:o['risk_pips'],1e-6),
        ('holdingHours',lambda o:o['hold_hours'],1e-6)]

summary=[]; allmismatch=[]; ALL_LEFTOVER=[]
for p in R.PAIRS:
    T=list(tt[p]); by_t={}
    for x in T: by_t.setdefault(x.get('triggerBarUtc'),[]).append(x)
    matched=0; mm=[]
    for o in ours[p]:
        k=utc(o['signal_t'])
        cand=by_t.get(k)
        if not cand:
            mm.append(('trade_missing_in_theirs',k,round(o['pips'],2))); continue
        x=cand.pop(0); matched+=1
        for f,getter,tol in FIELDS:
            if f not in x: continue
            ov=getter(o); xv=x[f]
            if f=='exitReason':
                a=str(xv).replace('-','_'); b=str(ov)
                if a!=b: mm.append((f,k,xv,ov))
            elif tol is None:
                if str(xv)!=str(ov): mm.append((f,k,xv,ov))
            else:
                if abs(float(xv)-ov)>tol: mm.append((f,k,xv,round(ov,8)))
        for f,getter in (('stop',lambda o:None),('target',lambda o:None)):
            pass
    leftover=[x for v in by_t.values() for x in v]
    ALL_LEFTOVER+=leftover
    summary.append((p,len(T),len(ours[p]),matched,len(leftover),len(mm)))
    allmismatch+= [(p,)+m for m in mm]
    print("%-8s theirs_list=%4d ours=%4d matched=%4d unmatched_theirs=%d field_mismatches=%d"%(p,len(T),len(ours[p]),matched,len(leftover),len(mm)))
    for m in mm[:8]: print("      ",m)
print("TOTAL theirs=%d ours=%d matched=%d mismatches=%d"%(sum(s[1] for s in summary),sum(s[2] for s in summary),sum(s[3] for s in summary),len(allmismatch)))
if ALL_LEFTOVER:
    print("unmatched entries in their list:", [(x['pair'],x['triggerBarUtc'],x.get('exitReason'),x.get('pips')) for x in leftover])
json.dump({'summary':[{'pair':s[0],'theirs':s[1],'ours':s[2],'matched':s[3],'unmatched_theirs':s[4],'field_mismatches':s[5]} for s in summary],
           'mismatches':allmismatch,'unmatched_theirs':[{'pair':x['pair'],'trigger':x['triggerBarUtc'],'reason':x.get('exitReason'),'pips':x.get('pips')} for x in ALL_LEFTOVER]},
          open('comparison-headline.json','w'), indent=1)
print("wrote comparison-headline.json")
