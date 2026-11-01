import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Ledger } from '../src/ledger.mjs';
import { createRelay, loadConfig } from '../src/relay.mjs';
import { createRelayServer } from '../src/server.mjs';
import { publicIp, resolvePublicHost, signUnsubscribe, readUnsubscribe } from '../src/security.mjs';

const config={token:'fake-test-token-00000000000000000000000000',signingKey:'fake-signing-key-11111111111111111111111',publicUrl:'https://relay.example.com',allowedPorts:[465,587,2525],maxConcurrent:5};
const account={host:'smtp.example.com',port:587,security:'starttls',username:'test-user',password:'fake-password',fromEmail:'sender@example.com',fromName:'Trezad Test'};
const payload=(id='delivery-1')=>({owner:'owner-1',deliveryId:id,account:{...account},message:{to:'receiver@example.net',subject:'Test',html:'<html><body><h1>Hello</h1></body></html>',text:'Hello'},postalAddress:'Test organisation address'});
function setup(options={}) {
  const ledger=new Ledger(':memory:');const messages=[];let opens=0;let verifies=0;
  const relay=createRelay({config,ledger,resolveHost:async()=> '203.1.2.3',createTransport:opts=>{
    opens++;
    assert.equal(opts.host,'203.1.2.3');assert.equal(opts.tls.servername,'smtp.example.com');
    assert.equal(opts.tls.rejectUnauthorized,true);assert.equal(opts.requireTLS,true);
    assert.equal(opts.disableFileAccess,true);assert.equal(opts.disableUrlAccess,true);
    return {verify:async()=>{verifies++;return true;},sendMail:async message=>{messages.push(message);return {accepted:['receiver@example.net']};},close(){}};
  },...options});
  return {ledger,relay,messages,get opens(){return opens;},get verifies(){return verifies;}};
}

test('rejects private, reserved and transition IPs; accepts global unicast',()=>{
  for(const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','192.168.1.1','172.16.0.1','100.64.0.1','0.0.0.0','192.0.2.1','198.51.100.1','203.0.113.1','224.0.0.1','::1','fc00::1','fe80::1','::ffff:127.0.0.1','2001:db8::1','2002:7f00:1::1','64:ff9b::127.0.0.1'])assert.equal(publicIp(ip),false,ip);
  for(const ip of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111'])assert.equal(publicIp(ip),true,ip);
});
test('DNS is fail-closed for mixed public/private answers',async()=>{
  await assert.rejects(resolvePublicHost('smtp.example.com',async()=>[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}]),/public IP/);
  await assert.rejects(resolvePublicHost('internal.local',async()=>[{address:'8.8.8.8',family:4}]),/public SMTP/);
  assert.equal(await resolvePublicHost('smtp.example.com',async()=>[{address:'8.8.8.8',family:4}]),'8.8.8.8');
});
test('production config requires HTTPS and separate strong keys',()=>{
  const env={SMTP_RELAY_TOKEN:config.token,SMTP_RELAY_SIGNING_KEY:config.signingKey,SMTP_RELAY_PUBLIC_URL:config.publicUrl};
  assert.equal(loadConfig(env).publicUrl,config.publicUrl);
  assert.throws(()=>loadConfig({...env,SMTP_RELAY_PUBLIC_URL:'http://localhost'}),/HTTPS/);
  assert.throws(()=>loadConfig({...env,SMTP_RELAY_SIGNING_KEY:config.token}),/different/);
  assert.throws(()=>loadConfig({...env,SMTP_RELAY_TOKEN:'short'}),/32/);
});
test('connection verification does not submit mail',async()=>{
  const s=setup();assert.deepEqual(await s.relay.check({account}),{ok:true});assert.equal(s.verifies,1);assert.equal(s.messages.length,0);s.ledger.close();
});
test('mail has one explicit recipient, TLS, unsubscribe and stable message ID',async()=>{
  const s=setup();const result=await s.relay.send(payload());
  assert.equal(result.status,'accepted');assert.equal(s.messages.length,1);
  const msg=s.messages[0];assert.deepEqual(msg.envelope,{from:account.fromEmail,to:['receiver@example.net']});
  assert.equal(msg.headers['List-Unsubscribe-Post'],'List-Unsubscribe=One-Click');
  assert.match(msg.html,/Unsubscribe from these emails/);assert.match(msg.text,/Unsubscribe: https:\/\/relay.example.com/);
  assert.match(msg.html,/Test organisation address/);assert.equal(msg.messageId,result.messageId);s.ledger.close();
});
test('same delivery is returned without sending again; changed content rejects',async()=>{
  const s=setup();const first=await s.relay.send(payload());const second=await s.relay.send(payload());assert.deepEqual(second,first);assert.equal(s.messages.length,1);
  const changed=payload();changed.message.subject='Changed';await assert.rejects(s.relay.send(changed),{status:409});assert.equal(s.messages.length,1);s.ledger.close();
});
test('concurrent requests can claim only one delivery',async()=>{
  let sends=0;
  const s=setup({createTransport:()=>({verify:async()=>true,sendMail:async()=>{sends++;await new Promise(resolve=>setTimeout(resolve,10));return {accepted:['receiver@example.net']};},close(){}})});
  const outcomes=await Promise.all([s.relay.send(payload()),s.relay.send(payload())]);
  assert.equal(sends,1);assert.deepEqual(outcomes.map(x=>x.status).sort(),['accepted','unknown']);s.ledger.close();
});
test('ambiguous transport failures are durable unknown, never replayed',async()=>{
  let sends=0;
  const s=setup({createTransport:()=>({sendMail:async()=>{sends++;throw Object.assign(new Error('SECRET raw provider message'),{code:'ECONNRESET'});},close(){}})});
  const result=await s.relay.send(payload());assert.equal(result.status,'unknown');assert.equal(result.code,'smtp_unknown');assert.doesNotMatch(JSON.stringify(result),/SECRET/);
  assert.deepEqual(await s.relay.send(payload()),result);assert.equal(sends,1);s.ledger.close();
});
test('explicit SMTP rejection is failed and is not automatically replayed',async()=>{
  let sends=0;
  const s=setup({createTransport:()=>({sendMail:async()=>{sends++;throw Object.assign(new Error('SECRET password'),{responseCode:550,code:'EENVELOPE'});},close(){}})});
  const result=await s.relay.send(payload());assert.equal(result.status,'failed');assert.equal(result.code,'smtp_sender_or_recipient');assert.equal(result.scope,'account');assert.doesNotMatch(JSON.stringify(result),/SECRET/);await s.relay.send(payload());assert.equal(sends,1);s.ledger.close();
});
test('SMTP authentication and temporary rejection codes are preserved for account pausing',async()=>{
  for(const [error,code] of [[{code:'EAUTH'},'smtp_auth'],[{responseCode:451,code:'EMESSAGE'},'smtp_rate_limit']]){
    const s=setup({createTransport:()=>({sendMail:async()=>{throw Object.assign(new Error('private upstream text'),error);},close(){}})});
    const result=await s.relay.send(payload());assert.equal(result.status,'failed');assert.equal(result.code,code);assert.equal(result.scope,'account');assert.deepEqual(await s.relay.send(payload()),result);s.ledger.close();
  }
});
test('deadline closes transport and preserves unknown without retry',async()=>{
  let closes=0;let sends=0;
  const s=setup({timeoutMs:20,createTransport:()=>({sendMail:async()=>{sends++;await new Promise(resolve=>setTimeout(resolve,100));return {accepted:['receiver@example.net']};},close(){closes++;}})});
  assert.equal((await s.relay.send(payload())).status,'unknown');assert.equal((await s.relay.send(payload())).status,'unknown');assert.equal(sends,1);assert.ok(closes>=1);s.ledger.close();
});
test('interrupted durable intent remains unknown after restart without content or credentials stored',()=>{
  const directory=mkdtempSync(join(tmpdir(),'trezad-ledger-'));const file=join(directory,'relay.sqlite');
  let ledger=new Ledger(file);ledger.claim('owner-1','delivery-1','digest-value');ledger.close();ledger=new Ledger(file);
  const result=ledger.claim('owner-1','delivery-1','digest-value');assert.equal(result.claimed,false);assert.equal(result.result.status,'unknown');
  const columns=ledger.db.prepare('PRAGMA table_info(deliveries)').all().map(x=>x.name);for(const bad of ['password','html','body','text','username'])assert.ok(!columns.includes(bad));
  ledger.close();assert.ok(!readFileSync(file).includes(Buffer.from(account.password)));rmSync(directory,{recursive:true,force:true});
});
test('suppressed address is excluded before opening SMTP; suppression is owner scoped',async()=>{
  const s=setup();s.ledger.suppress('owner-1','receiver@example.net');assert.equal((await s.relay.send(payload())).status,'suppressed');assert.equal(s.opens,0);
  const other=payload('other');other.owner='owner-2';assert.equal((await s.relay.send(other)).status,'accepted');s.ledger.close();
});
test('suppression is rechecked after asynchronous host resolution',async()=>{
  const ledger=new Ledger(':memory:');let sends=0;
  const relay=createRelay({config,ledger,resolveHost:async()=>{ledger.suppress('owner-1','receiver@example.net');return '8.8.8.8';},createTransport:()=>({sendMail:()=>{sends++;},close(){}})});
  assert.equal((await relay.send(payload())).status,'suppressed');assert.equal(sends,0);ledger.close();
});
test('signed unsubscribe links cannot be altered',()=>{
  const token=signUnsubscribe('owner-1','receiver@example.net',config.signingKey);assert.deepEqual(readUnsubscribe(token,config.signingKey),{owner:'owner-1',email:'receiver@example.net'});
  assert.throws(()=>readUnsubscribe(`${token.slice(0,-1)}!`,config.signingKey));assert.throws(()=>readUnsubscribe(token,'wrong-key'));
});
test('single mailbox validation rejects recipient injection and plaintext SMTP',async()=>{
  const s=setup();
  for(const recipient of ['a@example.net,b@example.net','a@example.net\r\nBcc:b@example.net']){const req=payload();req.message.to=recipient;await assert.rejects(s.relay.send(req),{status:400});}
  await assert.rejects(s.relay.check({account:{...account,security:'none'}}),{status:400});
  await assert.rejects(s.relay.check({account:{...account,host:'127.0.0.1'}}),{status:400});assert.equal(s.opens,0);s.ledger.close();
});
test('HTTP API auth, safe GET unsubscribe, POST one-click and bounded suppression pages',async t=>{
  const s=setup();const server=createRelayServer({config,ledger:s.ledger,relay:s.relay});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();server.close();s.ledger.close();});
  const origin=`http://127.0.0.1:${server.address().port}`;const auth={Authorization:`Bearer ${config.token}`};
  assert.deepEqual(await (await fetch(`${origin}/health`)).json(),{ok:true,service:'trezad-smtp-relay'});
  assert.equal((await fetch(`${origin}/v1/health`)).status,401);assert.equal((await fetch(`${origin}/v1/health`,{headers:auth})).status,200);
  assert.equal((await fetch(`${origin}/v1/health`,{headers:{...auth,Origin:'https://example.com'}})).status,403);
  const link=`${origin}/unsubscribe/${signUnsubscribe('owner-1','receiver@example.net',config.signingKey)}`;
  assert.equal((await fetch(link)).status,200);assert.equal(s.ledger.suppressed('owner-1','receiver@example.net'),false);
  assert.equal((await fetch(link,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'List-Unsubscribe=One-Click'})).status,200);
  assert.equal(s.ledger.suppressed('owner-1','receiver@example.net'),true);
  s.ledger.suppress('owner-1','second@example.net');s.ledger.suppress('owner-2','hidden@example.net');
  const page1=await(await fetch(`${origin}/v1/suppressions?owner=owner-1&limit=1`,{headers:auth})).json();assert.equal(page1.items.length,1);assert.ok(page1.nextCursor);
  const page2=await(await fetch(`${origin}/v1/suppressions?owner=owner-1&limit=1&cursor=${page1.nextCursor}`,{headers:auth})).json();assert.equal(page2.items.length,1);assert.equal(page2.nextCursor,null);
  assert.equal((await fetch(`${origin}/v1/suppressions?owner=owner-1&limit=501`,{headers:auth})).status,400);
  assert.equal((await fetch(`${origin}/v1/check`,{method:'POST',headers:{...auth,'Content-Type':'application/json'},body:JSON.stringify({account})})).status,200);assert.equal(s.messages.length,0);
});
