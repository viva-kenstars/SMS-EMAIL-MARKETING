#!/usr/bin/env python3
"""Bounded, operator-authorized HTTPS acceptance. Does not send message content."""
import argparse
import json
import os
from pathlib import Path
import stat
import sys
import time
import urllib.parse
import urllib.request
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,req,fp,code,msg,headers,newurl):
        raise RuntimeError('Redirect refused; credentials were not forwarded.')
def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--url',required=True);p.add_argument('--token-file',required=True,type=Path)
    p.add_argument('--cases',required=True,type=Path);p.add_argument('--report',required=True,type=Path)
    p.add_argument('--authorized',action='store_true',help='Confirm permission for every supplied test address')
    a=p.parse_args()
    if not a.authorized:p.error('Explicit --authorized is required.')
    u=urllib.parse.urlsplit(a.url)
    if u.scheme!='https' or not u.hostname or u.username or u.password or u.query or u.fragment or u.path not in ('','/'):
        p.error('Use a dedicated HTTPS origin.')
    for path in (a.token_file,a.cases):
        if not path.is_file() or path.stat().st_mode&(stat.S_IRWXG|stat.S_IRWXO) or path.stat().st_size>65536:
            p.error('Inputs must be private files, mode 0600 or stricter, at most 64KB.')
    token=a.token_file.read_text().strip()
    if not 32<=len(token)<=256 or not all(33<=ord(c)<=126 for c in token):p.error('Invalid private token.')
    cases=json.loads(a.cases.read_text())
    if not isinstance(cases,list) or not 2<=len(cases)<=12:p.error('Supply 2 to 12 controlled cases.')
    for item in cases:
        if not isinstance(item,dict) or set(item)!={'email','expected'} or not isinstance(item['email'],str) or item['expected'] not in ('valid','invalid','risky'):
            p.error('Each case needs email and expected category.')
    if not {'valid','invalid'}.issubset({i['expected'] for i in cases}):p.error('Include expected valid and invalid cases.')
    # Default ProxyHandler preserves configured HTTP(S)_PROXY / NO_PROXY.
    opener=urllib.request.build_opener(NoRedirect())
    def call(path,data=None):
        req=urllib.request.Request(a.url.rstrip('/')+path,data=None if data is None else json.dumps(data).encode(),headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
        with opener.open(req,timeout=25) as response:
            raw=response.read(32769)
            if len(raw)>32768:raise RuntimeError('Oversized response.')
            return json.loads(raw)
    health=call('/v1/health')
    if health.get('engine')!='sendzad' or health.get('smtp_enabled') is not True or health.get('paid_fallback') is not False:
        raise RuntimeError('Service not ready.')
    rows=[]
    for number,item in enumerate(cases,1):
        r={}
        for attempt in range(3):
            d=call('/v1/verify',{'emails':[item['email']]});results=d.get('results')
            if d.get('engine')!='sendzad' or not isinstance(results,list) or len(results)!=1:raise RuntimeError('Invalid response.')
            r=results[0];local,domain=item['email'].strip().rsplit('@',1)
            if r.get('email')!=local+'@'+domain.lower() or r.get('engine')!='sendzad':raise RuntimeError('Mismatched identity.')
            if not r.get('retryable') or attempt==2:break
            delay=r.get('retry_after_seconds',60)
            if type(delay) is not int or not 1<=delay<=120:raise RuntimeError('Invalid retry delay.')
            time.sleep(delay)
        passed=r.get('category')==item['expected']
        if item['expected']=='valid':passed=passed and r.get('smtp')=='accepted' and r.get('catch_all') is False and r.get('reason')=='recipient_accepted_non_catch_all'
        rows.append({'case':number,'expected':item['expected'],'actual':r.get('category'),'reason':r.get('reason'),'passed':bool(passed)})
    report={'engine':'sendzad','version':health.get('engine_version'),'scope':'operator-supplied controlled mailboxes only','message_content_sent':False,'paid_fallback':False,'passed':all(x['passed'] for x in rows),'cases':rows}
    fd=os.open(a.report,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'w') as stream:json.dump(report,stream,indent=2);stream.write('\n')
    print('Controlled host acceptance: '+('PASS' if report['passed'] else 'FAIL; review private report'))
    return 0 if report['passed'] else 1
if __name__=='__main__':
    try:sys.exit(main())
    except Exception:
        print('Acceptance failed. Check private inputs and service access; no paid fallback was used.',file=sys.stderr)
        sys.exit(2)
