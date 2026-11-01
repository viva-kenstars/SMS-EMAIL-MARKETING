import test from 'node:test';
import assert from 'node:assert/strict';
import { runScheduler,schedulerConfig } from '../src/scheduler.mjs';

test('scheduler requires both hosting and application credentials',()=>{
  assert.equal(schedulerConfig({}),null);
  assert.throws(()=>schedulerConfig({TREZAD_SITE_URL:'https://private.example.com'}),/requires/);
  assert.throws(()=>schedulerConfig({TREZAD_SITE_URL:'http://private.example.com'}),/HTTPS/);
});
test('worker callbacks are authenticated, serial and never send to a redirect',async()=>{
  const control=new AbortController();let inFlight=0;let peak=0;let calls=0;
  await runScheduler({siteUrl:'https://private.example.com',platformToken:'fake-platform',marketingToken:'fake-app',intervalMs:1},{signal:control.signal,
    fetcher:async(url,init)=>{
      assert.equal(url,'https://private.example.com/api/marketing/worker');assert.equal(init.headers['OAI-Sites-Authorization'],'Bearer fake-platform');assert.equal(init.headers['X-Marketing-Worker-Token'],'fake-app');assert.equal(init.redirect,'error');assert.equal(init.body,'{}');
      inFlight++;peak=Math.max(peak,inFlight);await new Promise(resolve=>setTimeout(resolve,5));inFlight--;calls++;if(calls===2)control.abort();return Response.json({ok:true,advanced:0});
    }});
  assert.equal(calls,2);assert.equal(peak,1);
});
test('verification worker does not block campaign ticks',async()=>{
  const control=new AbortController();let campaignCalls=0;let verificationCalls=0;
  await runScheduler({siteUrl:'https://private.example.com',platformToken:'fake-platform',marketingToken:'fake-app',emailToken:'fake-email',intervalMs:1},{signal:control.signal,
    fetcher:async(url,init)=>{
      if(url.endsWith('/api/email/worker')){verificationCalls++;assert.equal(init.headers['X-Email-Worker-Token'],'fake-email');await new Promise(resolve=>setTimeout(resolve,20));}
      else {campaignCalls++;if(campaignCalls===3)control.abort();}
      return Response.json({ok:true});
    }});
  assert.equal(campaignCalls,3);assert.equal(verificationCalls,1);
});
test('2xx JSON without ok:true is treated as a failed callback without leaking its body',async()=>{
  const control=new AbortController();const errors=[];
  await runScheduler({siteUrl:'https://private.example.com',platformToken:'fake-platform',marketingToken:'fake-app',intervalMs:1},{signal:control.signal,
    fetcher:async()=>Response.json({ok:false,secret:'must-not-log'}),
    logger:{error(message){errors.push(message);control.abort();}}
  });
  assert.equal(errors.length,1);assert.doesNotMatch(errors[0],/must-not-log|fake-platform|fake-app/);
});
