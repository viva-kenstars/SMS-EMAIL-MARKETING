import { setTimeout as delay } from 'node:timers/promises';

export function schedulerConfig(env = process.env) {
  if (!env.TREZAD_SITE_URL) return null;
  let site;
  try { site = new URL(env.TREZAD_SITE_URL); } catch { throw new Error('TREZAD_SITE_URL must be an HTTPS origin.'); }
  if (site.protocol !== 'https:' || site.username || site.password || site.search || site.hash || site.pathname !== '/') throw new Error('TREZAD_SITE_URL must be an HTTPS origin.');
  if (!env.SITE_PLATFORM_TOKEN || !env.MARKETING_WORKER_TOKEN) throw new Error('The scheduler requires SITE_PLATFORM_TOKEN and MARKETING_WORKER_TOKEN.');
  return {siteUrl:site.origin,platformToken:env.SITE_PLATFORM_TOKEN,marketingToken:env.MARKETING_WORKER_TOKEN,emailToken:env.EMAIL_WORKER_TOKEN||'',intervalMs:Math.max(1000,Math.min(60000,Number(env.SCHEDULER_INTERVAL_MS)||1000))};
}

export async function runScheduler(config, {signal,fetcher=fetch,logger=console}={}) {
  if (!config) return;
  async function poll(path,tokenHeader,token,intervalMs,label) {
    let failures=0;
    while (!signal?.aborted) {
      try {
        // One request at a time per queue, with independent verification polling
        // so a long mailbox check cannot delay scheduled campaign messages.
        const response=await fetcher(`${config.siteUrl}${path}`,{
          method:'POST',redirect:'error',signal:AbortSignal.any([signal??new AbortController().signal,AbortSignal.timeout(120000)]),
          headers:{'Content-Type':'application/json','OAI-Sites-Authorization':`Bearer ${config.platformToken}`,[tokenHeader]:token},body:'{}'
        });
        if(!response.ok || !response.headers.get('content-type')?.includes('application/json')) { await response.body?.cancel();throw new Error('worker-http'); }
        const reader=response.body.getReader();let size=0;const parts=[];
        while(true) {const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>65536){await reader.cancel();throw new Error('worker-body');}parts.push(next.value);}
        const bytes=Buffer.concat(parts);const result=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
        if(!result || result.ok!==true)throw new Error('worker-result');
        failures=0;
      } catch {
        if (signal?.aborted) break;
        failures++;
        // Never log response bodies, headers or credential-bearing error objects.
        if(failures===1 || failures%20===0)logger.error(`${label} worker callback failed. Check Site access and worker credentials.`);
      }
      try {await delay(Math.min(60000,intervalMs*2**Math.min(failures,6)),null,{signal});}
      catch {break;}
    }
  }
  await Promise.all([
    poll('/api/marketing/worker','X-Marketing-Worker-Token',config.marketingToken,config.intervalMs,'Marketing'),
    ...(config.emailToken?[poll('/api/email/worker','X-Email-Worker-Token',config.emailToken,15000,'Email verification')]:[])
  ]);
}
