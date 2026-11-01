import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { Ledger } from './ledger.mjs';
import { createRelay, loadConfig } from './relay.mjs';
import { HttpError, authenticate, readUnsubscribe, escapeHtml, string } from './security.mjs';
import { schedulerConfig, runScheduler } from './scheduler.mjs';

const HEADERS = {
  'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
  'Referrer-Policy':'no-referrer','X-Frame-Options':'DENY',
  'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
};
function respond(res,status,value,type='application/json; charset=utf-8') {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status,{...HEADERS,'Content-Type':type});
  res.end(type.startsWith('application/json')?JSON.stringify(value):value);
}
async function readBody(req,max) {
  if (Number(req.headers['content-length'])>max) throw new HttpError(413,'Request body is too large.');
  const pieces=[]; let size=0;
  for await(const chunk of req) { size+=chunk.length; if(size>max) throw new HttpError(413,'Request body is too large.'); pieces.push(chunk); }
  return Buffer.concat(pieces).toString('utf8');
}
async function jsonBody(req) {
  if (!(req.headers['content-type']||'').toLowerCase().startsWith('application/json')) throw new HttpError(415,'Send JSON content.');
  try {
    const data=JSON.parse(await readBody(req,1500000));
    if(!data || typeof data!=='object' || Array.isArray(data)) throw new Error();
    return data;
  } catch(error) { if(error instanceof HttpError) throw error; throw new HttpError(400,'Invalid JSON request.'); }
}
function page(title,body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font:16px/1.6 system-ui,sans-serif;background:#f1f5f9;color:#0f172a;margin:0;padding:64px 20px}main{max-width:520px;margin:auto;padding:32px;background:white;border-radius:16px}h1{font-size:26px}button{font:inherit;padding:12px 20px;background:#0f766e;color:white;border:0;border-radius:8px;cursor:pointer}p{overflow-wrap:anywhere}</style></head><body><main><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`;
}

export function createRelayServer({config,ledger,relay=createRelay({config,ledger})}) {
  let active=0;
  const server=createServer(async(req,res)=>{
    let occupied=false;
    try {
      const url=new URL(req.url,'http://relay.local');
      if(req.method==='GET' && url.pathname==='/health') return respond(res,200,{ok:true,service:'trezad-smtp-relay'});
      const match=url.pathname.match(/^\/unsubscribe\/([A-Za-z0-9_.-]+)$/);
      if(match && ['GET','POST'].includes(req.method)) {
        const identity=readUnsubscribe(match[1],config.signingKey);
        if(req.method==='GET') return respond(res,200,page('Unsubscribe',`<p>Confirm below to stop future campaign emails from this sender.</p><form method="post"><button name="confirm" value="yes" type="submit">Unsubscribe</button></form>`),'text/html; charset=utf-8');
        const contentType=String(req.headers['content-type']||'').toLowerCase();
        const body=await readBody(req,16384);
        let form;
        if(contentType.startsWith('application/x-www-form-urlencoded')) form=new URLSearchParams(body);
        else if(contentType.startsWith('multipart/form-data')) {
          try { form=await new Request('https://relay.invalid/',{method:'POST',headers:{'Content-Type':req.headers['content-type']},body}).formData(); }
          catch { throw new HttpError(400,'Invalid unsubscribe request.'); }
        } else throw new HttpError(415,'Use an unsubscribe form.');
        if(form.get('confirm')!=='yes' && form.get('List-Unsubscribe')!=='One-Click') throw new HttpError(400,'Confirm the unsubscribe request.');
        ledger.suppress(identity.owner,identity.email);
        return respond(res,200,page('You are unsubscribed','<p>This address will be excluded from future campaign emails from this sender. Emails already submitted cannot be recalled.</p>'),'text/html; charset=utf-8');
      }
      if(!url.pathname.startsWith('/v1/')) throw new HttpError(404,'Not found.');
      authenticate(req.headers.authorization,config.token);
      // Relay credentials belong only on the server, never in a browser request.
      if(req.headers.origin) throw new HttpError(403,'Direct browser access is not enabled.');
      if(req.method==='GET' && url.pathname==='/v1/health') return respond(res,200,{ok:true,service:'trezad-smtp-relay'});
      if(req.method==='GET' && url.pathname==='/v1/suppressions') {
        const owner=string(url.searchParams.get('owner'),'owner',200);
        return respond(res,200,ledger.listSuppressions(owner,url.searchParams.get('cursor')||'0',Number(url.searchParams.get('limit')||100)));
      }
      if(req.method!=='POST' || !['/v1/check','/v1/send'].includes(url.pathname)) throw new HttpError(404,'Not found.');
      if(active>=config.maxConcurrent) throw new HttpError(429,'The relay is busy. No new SMTP operation was started.');
      active++;occupied=true;
      const input=await jsonBody(req);
      const output=url.pathname==='/v1/check'?await relay.check(input):await relay.send(input);
      respond(res,200,output);
    } catch(error) {
      respond(res,error instanceof HttpError?error.status:500,{error:error instanceof HttpError?error.message:'The relay could not finish the request. Check delivery history before retrying.',...(error instanceof HttpError && error.code?{code:error.code}:{})});
    } finally { if(occupied)active--; }
  });
  server.requestTimeout=60000;
  server.headersTimeout=15000;
  server.keepAliveTimeout=5000;
  server.maxHeadersCount=40;
  return server;
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  let config;let schedule;
  try {config=loadConfig();schedule=schedulerConfig();}
  catch(error) {console.error(error.message);process.exit(1);}
  const ledger=new Ledger(config.database);
  const server=createRelayServer({config,ledger});
  const abort=new AbortController();
  server.listen(config.port,config.host,()=>{console.log('Trezad SMTP relay is listening.');});
  server.on('error',()=>{console.error('The relay listener could not start.');abort.abort();process.exitCode=1;});
  void runScheduler(schedule,{signal:abort.signal});
  let stopping=false;
  const stop=()=>{
    if(stopping)return;stopping=true;abort.abort();
    server.close(()=>{ledger.close();process.exit(0);});
    const timer=setTimeout(()=>{process.exit(1);},50000);timer.unref();
  };
  process.on('SIGTERM',stop);process.on('SIGINT',stop);
}
