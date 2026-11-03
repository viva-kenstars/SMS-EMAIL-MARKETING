import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(import.meta.url);
let ts;try{ts=require('typescript');}catch{if(!process.env.SENDZAD_TEST_TYPESCRIPT)throw Error('Install development dependencies or set SENDZAD_TEST_TYPESCRIPT.');ts=require(process.env.SENDZAD_TEST_TYPESCRIPT);}
const out=join(root,'outputs','verifier-connection-test');await mkdir(out,{recursive:true});
for(const name of ['self-hosted','provider-router']){
 const input=await readFile(join(root,'app/lib/email',name+'.ts'),'utf8');
 const compiled=ts.transpileModule(input,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022},reportDiagnostics:true});
 assert.equal(compiled.diagnostics?.filter(d=>d.category===ts.DiagnosticCategory.Error).length||0,0);
 await writeFile(join(out,name+'.mjs'),compiled.outputText.replaceAll('./self-hosted.ts','./self-hosted.mjs'));
}
const {createVerificationRouter}=await import(pathToFileURL(join(out,'provider-router.mjs')));
const {validateSelfConfig,checkSelfHealth,validateSelfResults,verifySelf,selfConfigHash}=await import(pathToFileURL(join(out,'self-hosted.mjs')));
const config={url:'https://verify.example.test',token:'test-only-token-not-a-live-secret-123456'};
const health={engine:'sendzad',engine_version:'1.0.0',smtp_enabled:true,max_batch:4,paid_fallback:false,acceptance_tested:false};
const good=email=>({email,engine:'sendzad',engine_version:'1.0.0',category:'valid',reason:'recipient_accepted_non_catch_all',checked_at:Math.floor(Date.now()/1000),retryable:false,syntax:'valid',mail_route:'present',smtp:'accepted',catch_all:false,role_account:false,disposable:'not_assessed',spam_trap:'not_assessed',cached:false});
const response=results=>({engine:'sendzad',engine_version:'1.0.0',results});
const address='Member+tag@company.test';
for(const [label,input] of Object.entries({http:{...config,url:'http://verify.example.test'},path:{...config,url:config.url+'/unsafe'},credentials:{...config,url:'https://user:pass@verify.example.test'},ip:{...config,url:'https://127.0.0.1'},local:{...config,url:'https://host.local'},short:{...config,token:'short'},query:{...config,url:config.url+'?key=x'},port:{...config,url:config.url+':8095'},space:{...config,token:config.token+'\n'}}))test('configuration rejects '+label,()=>assert.throws(()=>validateSelfConfig(input)));
test('configuration canonicalizes origin and pins token',async()=>{assert.deepEqual(validateSelfConfig({...config,url:'https://VERIFY.example.test/'}),config);assert.notEqual(await selfConfigHash(config),await selfConfigHash({...config,token:config.token+'a'}));});
test('health uses authenticated server-to-server contract',async()=>{const r=await checkSelfHealth(config,async(url,init)=>{assert.equal(url,config.url+'/v1/health');assert.equal(init.headers.Authorization,'Bearer '+config.token);assert.equal(init.headers.Origin,undefined);assert.equal(init.redirect,'manual');return Response.json(health);});assert.equal(r.acceptanceTested,false);assert.equal(r.paidFallback,false);});
for(const [key,value] of [['smtp_enabled',false],['paid_fallback',true],['max_batch',100],['engine','other']])test('health rejects incompatible '+key,async()=>assert.rejects(()=>checkSelfHealth(config,async()=>Response.json({...health,[key]:value}))));
test('positive evidence and exact local-part identity accepted',()=>assert.equal(validateSelfResults(response([good(address)]),[address])[0].email,address));
for(const [label,mutate] of [
 ['catch all',r=>r.catch_all=true],['missing smtp',r=>delete r.smtp],['stale',r=>r.checked_at-=100000],['wrong identity',r=>r.email=r.email.toLowerCase()],['claimed spamtrap safety',r=>r.spam_trap='safe'],['retry contradiction',r=>r.retryable=true],['unsafe reason',r=>r.reason='<script>'],['invalid retry delay',r=>r.retry_after_seconds='NaN'],['missing cache flag',r=>delete r.cached],['bad invalid evidence',r=>{r.category='invalid';r.reason='timeout';}]
])test('result rejects '+label,()=>{const r=good(address);mutate(r);assert.throws(()=>validateSelfResults(response([r]),[address]));});
test('missing/duplicate/unexpected results reject entire batch',()=>{for(const results of [[],[good(address),good(address)],[good('other@company.test')]])assert.throws(()=>validateSelfResults(response(results),[address]));});
test('temporary unknown remains unknown',()=>{const r={...good(address),category:'unknown',reason:'temporary_failure',retryable:true};assert.equal(validateSelfResults(response([r]),[address])[0].category,'unknown');});
for(const status of [302,401,429,500])test('transport rejects HTTP '+status,async()=>assert.rejects(()=>verifySelf(config,[address],async()=>new Response('{}',{status,headers:{'Content-Type':'application/json'}}))));
test('transport rejects oversized results',async()=>assert.rejects(()=>verifySelf(config,[address],async()=>new Response(' '.repeat(32769),{headers:{'Content-Type':'application/json'}}))));
test('transport failure redacts exceptions and secret',async()=>{await assert.rejects(()=>verifySelf(config,[address],async()=>{throw Error(config.token);}),e=>!e.message.includes(config.token));});

const base=`PRAGMA foreign_keys=ON;
CREATE TABLE email_jobs(id TEXT PRIMARY KEY,owner TEXT,name TEXT,source_name TEXT,status TEXT DEFAULT 'uploading',created_at INTEGER,updated_at INTEGER,started_at INTEGER,sealed_at INTEGER,completed_at INTEGER,next_run_at INTEGER,lease_token TEXT,lease_until INTEGER,error TEXT,pending_count INTEGER DEFAULT 0,processing_count INTEGER DEFAULT 0,valid_count INTEGER DEFAULT 0,invalid_count INTEGER DEFAULT 0,risky_count INTEGER DEFAULT 0,unknown_count INTEGER DEFAULT 0,pending_targets INTEGER DEFAULT 0);
CREATE TABLE email_targets(job_id TEXT REFERENCES email_jobs(id),email TEXT,first_position INTEGER,status TEXT DEFAULT 'pending',occurrence_count INTEGER DEFAULT 1,reason TEXT DEFAULT '',provider_status TEXT,updated_at INTEGER,PRIMARY KEY(job_id,email));
CREATE TABLE campaigns(id TEXT PRIMARY KEY,status TEXT);INSERT INTO campaigns VALUES('do-not-touch','draft');`;
const migration=await readFile(join(root,'drizzle/0011_sendzad_verifier.sql'),'utf8');
class Statement{
 constructor(db,sql,args=[]){Object.assign(this,{db,sql,args});}bind(...args){return new Statement(this.db,this.sql,args);}
 async first(){return this.db.sql.prepare(this.sql).get(...this.args)||null;}
 async all(){return {results:this.db.sql.prepare(this.sql).all(...this.args),success:true};}
 async run(){return this.execute();}execute(){const r=this.db.sql.prepare(this.sql).run(...this.args);return {meta:{changes:Number(r.changes)},success:true};}
}
class DB{
 constructor(){this.sql=new DatabaseSync(':memory:');this.sql.exec(base);this.sql.exec(migration);}prepare(s){return new Statement(this,s);}
 async batch(ops){this.sql.exec('BEGIN');try{const r=ops.map(s=>s.execute());this.sql.exec('COMMIT');return r;}catch(e){this.sql.exec('ROLLBACK');throw e;}}
}
function fixture(t){
 const db=new DB(),calls=[],legacy=[],c={db,owner:'alice'},state={config:{...config},respond:emails=>response(emails.map(good))};
 const legacyApi=async(req,ctx)=>{legacy.push(new URL(req.url).pathname);const id=new URL(req.url).pathname.split('/')[4];
  if(req.method==='GET'&&id){const j=db.sql.prepare('SELECT * FROM email_jobs WHERE id=? AND owner=?').get(id,ctx.owner);return Response.json({job:j,attentionBatches:[]});}
  return Response.json({delegated:true});};
 const legacyQueue=async(_db,_key,o)=>{legacy.push('queue:'+o.jobId);return {advanced:1};};
 c.fetch=async(url,init)=>{calls.push({url,init});assert.equal(new URL(url).origin,config.url);if(url.endsWith('/v1/health'))return Response.json(health);const emails=JSON.parse(init.body).emails;return Response.json(await state.respond(emails));};
 const router=createVerificationRouter({legacyApi,legacyQueue,connection:()=>state.config});
 const api=async(path,body,owner='alice',headers={})=>{const request=new Request('https://workspace.test/api/email/'+path,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},body:body===undefined?undefined:JSON.stringify(body)});const r=await router.handleEmailApi(request,{...c,owner});return {status:r.status,data:await r.json()};};
 const seed=async(emails=[address],weights=[],engine='sendzad')=>{const r=await api('jobs',{name:'Test',provider:engine});assert.equal(r.status,201);const id=r.data.job.id;db.sql.prepare("UPDATE email_jobs SET status='ready',sealed_at=1,pending_count=?,pending_targets=? WHERE id=?").run(emails.reduce((n,_,i)=>n+(weights[i]||1),0),emails.length,id);for(let i=0;i<emails.length;i++)db.sql.prepare('INSERT INTO email_targets(job_id,email,first_position,occurrence_count) VALUES(?,?,?,?)').run(id,emails[i],i+1,weights[i]||1);return id;};
 const start=id=>api(`jobs/${id}/start`,{confirmed:true});
 const advance=id=>router.advanceEmailQueue(db,undefined,{owner:'alice',jobId:id,fetch:c.fetch});
 const row=id=>db.sql.prepare('SELECT * FROM email_jobs WHERE id=?').get(id);
 const due=id=>{db.sql.prepare('UPDATE email_jobs SET next_run_at=0 WHERE id=?').run(id);db.sql.prepare('UPDATE email_self_results SET next_at=0 WHERE job_id=?').run(id);};
 t.after(()=>{assert.equal(db.sql.prepare('SELECT status FROM campaigns').get().status,'draft');db.sql.close();});
 return {db,c,api,seed,start,advance,row,due,calls,legacy,state,router};
}
test('default new job is Sendzad and creation never calls provider',async t=>{const f=fixture(t),r=await f.api('jobs',{name:'Default'});assert.equal(r.status,201);assert.equal(r.data.job.engine,'sendzad');assert.equal(f.calls.length,0);});
test('explicit secondary keeps Reoon',async t=>{const f=fixture(t),id=await f.seed([address],[],'reoon');assert.equal((await f.api(`jobs/${id}/start`,{acknowledgeProvider:true})).data.delegated,true);assert.equal(f.calls.length,0);});
test('unauthenticated and cross-origin writes denied',async t=>{const f=fixture(t);assert.equal((await f.api('jobs',{name:'x'},'')).status,401);assert.equal((await f.api('jobs',{name:'x'},'alice',{Origin:'https://evil.test'})).status,403);assert.equal(f.db.sql.prepare('SELECT COUNT(*) n FROM email_jobs').get().n,0);});
test('settings returns no token',async t=>{const f=fixture(t),r=await f.api('self/settings');assert.equal(r.data.configured,true);assert.ok(!JSON.stringify(r).includes(config.token));});
test('consent required before start',async t=>{const f=fixture(t),id=await f.seed();assert.equal((await f.api(`jobs/${id}/start`,{})).status,409);assert.equal(f.row(id).status,'ready');assert.equal(f.calls.length,0);});
test('self start and queue persist weighted results without paid calls',async t=>{const f=fixture(t),id=await f.seed([address],[3]);assert.equal((await f.start(id)).status,200);assert.equal((await f.advance(id)).advanced,1);const j=f.row(id);assert.equal(j.status,'completed');assert.equal(j.pending_count,0);assert.equal(j.valid_count,3);assert.equal(j.pending_targets,0);assert.equal(j.next_run_at,null);assert.ok(!f.legacy.some(x=>x.startsWith('queue:')));});
test('bounded batch only handles four targets',async t=>{const f=fixture(t),id=await f.seed(Array.from({length:7},(_,i)=>`user${i}@company.test`));await f.start(id);await f.advance(id);assert.equal(f.row(id).valid_count,4);assert.equal(f.row(id).pending_targets,3);assert.equal(f.row(id).status,'running');});
test('invalid response preserves all pending work and pauses',async t=>{const f=fixture(t),id=await f.seed();await f.start(id);f.state.respond=()=>response([]);await f.advance(id);assert.equal(f.row(id).status,'needs_attention');assert.equal(f.row(id).pending_count,1);assert.equal(f.row(id).valid_count,0);assert.ok(!f.legacy.some(x=>x.startsWith('queue:')));});
test('temporary errors retry three times then complete unknown',async t=>{const f=fixture(t),id=await f.seed();await f.start(id);f.state.respond=emails=>response(emails.map(email=>({...good(email),category:'unknown',reason:'temporary_failure',retryable:true,retry_after_seconds:60})));for(let n=0;n<3;n++){f.due(id);await f.advance(id);}assert.equal(f.row(id).status,'completed');assert.equal(f.row(id).unknown_count,1);assert.equal(f.row(id).invalid_count,0);});
test('cooldown deferrals are bounded independently',async t=>{const f=fixture(t),id=await f.seed();await f.start(id);f.state.respond=emails=>response(emails.map(email=>({...good(email),category:'unknown',reason:'provider_cooldown',retryable:true,retry_after_seconds:60})));for(let n=0;n<30;n++){f.due(id);await f.advance(id);}assert.equal(f.row(id).unknown_count,1);assert.equal(f.db.sql.prepare('SELECT attempts FROM email_self_results').get().attempts,0);});
test('configuration changes retain pending and do not fallback',async t=>{const f=fixture(t),id=await f.seed();await f.start(id);f.state.config.token+='x';await f.advance(id);assert.equal(f.row(id).status,'needs_attention');assert.equal(f.row(id).pending_count,1);assert.equal(f.calls.filter(x=>x.url.endsWith('/v1/verify')).length,0);});
test('cross-owner advance is rejected',async t=>{const f=fixture(t),id=await f.seed();await f.start(id);assert.equal((await f.api(`jobs/${id}/advance`,{},'bob')).status,404);assert.equal(f.calls.length,1);});
test('cancel during remote call prevents result writes',async t=>{const f=fixture(t),id=await f.seed();await f.start(id);f.state.respond=emails=>{f.db.sql.prepare("UPDATE email_jobs SET status='cancelled',unknown_count=pending_count,pending_count=0,pending_targets=0 WHERE id=?").run(id);return response(emails.map(good));};await f.advance(id);assert.equal(f.row(id).status,'cancelled');assert.equal(f.row(id).valid_count,0);assert.equal(f.db.sql.prepare('SELECT COUNT(*) n FROM email_self_results').get().n,0);});
test('pause during response preserves completed evidence without advancing remainder',async t=>{const f=fixture(t),id=await f.seed(Array.from({length:5},(_,i)=>`p${i}@company.test`));await f.start(id);f.state.respond=emails=>{f.db.sql.prepare("UPDATE email_jobs SET status='paused' WHERE id=?").run(id);return response(emails.map(good));};await f.advance(id);assert.equal(f.row(id).status,'paused');assert.equal(f.row(id).valid_count,4);assert.equal(f.row(id).next_run_at,null);});
test('old unbound jobs keep their original provider',async t=>{const f=fixture(t),id=crypto.randomUUID();f.db.sql.prepare("INSERT INTO email_jobs(id,owner,name,status,started_at,created_at,updated_at) VALUES(?,'alice','Existing','running',1,1,1)").run(id);await f.advance(id);assert.ok(f.legacy.includes('queue:'+id));assert.equal(f.calls.length,0);});
test('lease prevents overlapping self probes',async t=>{const f=fixture(t),id=await f.seed();await f.start(id);let release,entered;const enteredPromise=new Promise(r=>entered=r);f.state.respond=emails=>new Promise(r=>{release=()=>r(response(emails.map(good)));entered();});const first=f.advance(id);await enteredPromise;assert.equal((await f.advance(id)).advanced,0);release();await first;assert.equal(f.row(id).valid_count,1);});
test('missing configuration blocks start without changing saved provider',async t=>{const f=fixture(t),id=await f.seed();f.state.config.token='';assert.equal((await f.start(id)).status,503);assert.equal(f.row(id).status,'ready');assert.equal(f.calls.length,0);});
test('resume rejects a different connection and active leases',async t=>{const f=fixture(t),id=await f.seed();await f.start(id);f.db.sql.prepare("UPDATE email_jobs SET status='paused' WHERE id=?").run(id);f.state.config.token+='x';assert.equal((await f.api(`jobs/${id}/action`,{action:'resume'})).status,409);f.state.config={...config};f.db.sql.prepare('UPDATE email_jobs SET lease_until=? WHERE id=?').run(Date.now()+10000,id);assert.equal((await f.api(`jobs/${id}/action`,{action:'resume'})).status,409);});

// Execute the real entrypoint and protected-worker source with inert dependency fixtures.
const fixturePath=join(out,'entry-fixture.mjs');
await writeFile(fixturePath,`export const env={}; export const calls=[];
export async function handleApi(r){calls.push('legacy:'+new URL(r.url).pathname);return Response.json({legacy:true});}
export async function handleEmailApi(r,c){calls.push('provider:'+new URL(r.url).pathname);return Response.json({owner:c.owner});}
export async function advanceEmailQueue(){calls.push('worker');return {advanced:0,jobIds:[],nextDueAt:null};}
export const isEncryptionKeyReady=k=>typeof k==='string'&&Buffer.from(k,'base64').length===32;
`);
for(const [relative,name,replacements] of [
 ['app/lib/email/provider-runner.ts','provider-runner',{'./provider-service':'./entry-fixture.mjs','../secret-store':'./entry-fixture.mjs'}],
 ['app/lib/server.ts','entrypoint',{'cloudflare:workers':'./entry-fixture.mjs','./legacy-server':'./entry-fixture.mjs','./email/provider-service':'./entry-fixture.mjs','./email/provider-runner':'./provider-runner.mjs'}]
]){
 let input=await readFile(join(root,relative),'utf8');let compiled=ts.transpileModule(input,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
 for(const [from,to]of Object.entries(replacements))compiled=compiled.replaceAll('"'+from+'"','"'+to+'"');
 await writeFile(join(out,name+'.mjs'),compiled);
}
const entry=await import(pathToFileURL(join(out,'entrypoint.mjs'))),entryFixture=await import(pathToFileURL(fixturePath));
const workerToken='unit-only-worker-token',tokenHash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(workerToken))).toString('hex');
Object.assign(entryFixture.env,{DB:{prepare(){return {bind(){return this;},async run(){return {meta:{changes:1}};},async first(){return null;}};}},SMS_SETTINGS_ENCRYPTION_KEY:Buffer.alloc(32,17).toString('base64'),EMAIL_WORKER_TOKEN_SHA256:tokenHash});
async function entryCall(path,{method='GET',body,headers={}}={}){return entry.handleApi(new Request('https://workspace.test'+path,{method,headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},body:body===undefined?undefined:JSON.stringify(body)}));}
test('real API entrypoint rejects missing identity',async()=>assert.equal((await entryCall('/api/email/jobs')).status,401));
test('compatibility URL uses same authenticated provider route',async()=>{const r=await entryCall('/api/email-v2/jobs',{headers:{'oai-authenticated-user-id':'alice','oai-authenticated-user-email':'alice@example.test'}});assert.equal(r.status,200);assert.ok(entryFixture.calls.includes('provider:/api/email/jobs'));});
test('non-verifier channels retain the original API implementation',async()=>{await entryCall('/api/marketing/campaigns');assert.ok(entryFixture.calls.includes('legacy:/api/marketing/campaigns'));});
for(const [label,options,status]of [
 ['GET',{method:'GET'},405],['no token',{method:'POST',body:{}},401],['bad token',{method:'POST',body:{},headers:{'x-email-worker-token':'wrong'}},401],['cross site',{method:'POST',body:{},headers:{'x-email-worker-token':workerToken,Origin:'https://other.test'}},403],['nonempty payload',{method:'POST',body:{launch:true},headers:{'x-email-worker-token':workerToken}},400],['oversized payload',{method:'POST',body:{x:'x'.repeat(2500)},headers:{'x-email-worker-token':workerToken}},400]
])test('protected new worker rejects '+label,async()=>{const n=entryFixture.calls.filter(x=>x==='worker').length;assert.equal((await entryCall('/api/email/worker',options)).status,status);assert.equal(entryFixture.calls.filter(x=>x==='worker').length,n);});
test('valid protected worker invokes routed queue exactly once',async()=>{const n=entryFixture.calls.filter(x=>x==='worker').length;const r=await entryCall('/api/email/worker',{method:'POST',body:{},headers:{'x-email-worker-token':workerToken}});assert.equal(r.status,200);assert.equal(entryFixture.calls.filter(x=>x==='worker').length,n+1);});
