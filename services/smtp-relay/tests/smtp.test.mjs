import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SMTPServer } from 'smtp-server';
import { createRelay } from '../src/relay.mjs';
import { Ledger } from '../src/ledger.mjs';

// These fixtures bind only localhost. DNS and CA injection exist only in test
// construction, never as API fields or production environment overrides.
const directory=mkdtempSync(join(tmpdir(),'trezad-smtp-fixture-'));
const keyPath=join(directory,'key.pem');const certPath=join(directory,'cert.pem');
execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-sha256','-days','1','-subj','/CN=smtp.fixture.example','-addext','subjectAltName=DNS:smtp.fixture.example','-keyout',keyPath,'-out',certPath],{stdio:'ignore'});
const key=readFileSync(keyPath);const cert=readFileSync(certPath);
test.after(()=>rmSync(directory,{recursive:true,force:true}));

async function fixture(t,options={}) {
  const messages=[];let authentications=0;
  const smtp=new SMTPServer({name:'smtp.fixture.example',key,cert,secure:options.secure||false,logger:false,disableReverseLookup:true,
    ...(options.noStarttls?{disabledCommands:['STARTTLS']}:{ }),
    onAuth(auth,session,callback){
      authentications++;
      if(!session.secure || auth.username!=='fixture-user' || auth.password!=='fixture-password')return callback(new Error('Fixture authentication failed'));
      callback(null,{user:'fixture-user'});
    },
    onRcptTo(address,session,callback){if(options.rejectRecipient)return callback(Object.assign(new Error('Fixture rejection'),{responseCode:550}));callback();},
    onData(stream,session,callback){let body='';stream.on('data',chunk=>body+=chunk);stream.on('end',()=>{messages.push(body);callback(null,'Fixture accepted');});}
  });
  smtp.on('error',()=>{}); // TLS-rejection fixture can report the expected peer error.
  await new Promise(resolve=>smtp.listen(0,'127.0.0.1',resolve));
  const port=smtp.server.address().port;
  const ledger=new Ledger(':memory:');
  const config={token:'fake-test-token-00000000000000000000000000',signingKey:'fake-signing-key-11111111111111111111111',publicUrl:'https://relay.example.com',allowedPorts:[port],maxConcurrent:5};
  const relay=createRelay({config,ledger,resolveHost:async()=> '127.0.0.1',...(options.untrusted?{}:{trustCa:cert}),timeoutMs:5000});
  const account={host:'smtp.fixture.example',port,security:options.secure?'tls':'starttls',username:'fixture-user',password:'fixture-password',fromEmail:'sender@example.com',fromName:'Fixture'};
  t.after(async()=>{await new Promise(resolve=>smtp.close(resolve));ledger.close();});
  return {relay,account,messages,get authentications(){return authentications;}};
}
const request=account=>({owner:'test-owner',deliveryId:'fixture-delivery',account,message:{to:'recipient@example.net',subject:'Local fixture only',html:'<p>Local test</p>',text:'Local test'}});

test('real STARTTLS handshake and authentication verify without DATA',async t=>{
  const f=await fixture(t);assert.deepEqual(await f.relay.check({account:f.account}),{ok:true});assert.equal(f.authentications,1);assert.equal(f.messages.length,0);
});
test('real STARTTLS submission includes unsubscribe MIME headers and cannot replay',async t=>{
  const f=await fixture(t);const req=request(f.account);const first=await f.relay.send(req);assert.equal(first.status,'accepted');assert.equal(f.messages.length,1);
  assert.match(f.messages[0],/List-Unsubscribe-Post: List-Unsubscribe=One-Click/i);assert.match(f.messages[0],/List-Unsubscribe:\s+<https:\/\/relay.example.com\//i);
  assert.deepEqual(await f.relay.send(req),first);assert.equal(f.messages.length,1);
});
test('real implicit TLS connection verifies with certificate validation',async t=>{
  const f=await fixture(t,{secure:true});assert.deepEqual(await f.relay.check({account:f.account}),{ok:true});assert.equal(f.messages.length,0);
});
test('real SMTP wrong password returns safe rejection without DATA',async t=>{
  const f=await fixture(t);await assert.rejects(f.relay.check({account:{...f.account,password:'incorrect-secret'}}),error=>error.status===400 && /authentication/.test(error.message) && !error.message.includes('incorrect-secret'));assert.equal(f.messages.length,0);
});
test('untrusted certificate is rejected; no insecure TLS fallback',async t=>{
  const f=await fixture(t,{untrusted:true});await assert.rejects(f.relay.check({account:f.account}),{status:400});assert.equal(f.messages.length,0);assert.equal(f.authentications,0);
});
test('server without STARTTLS cannot receive credentials or messages',async t=>{
  const f=await fixture(t,{noStarttls:true});await assert.rejects(f.relay.check({account:f.account}),{status:400});assert.equal(f.authentications,0);assert.equal(f.messages.length,0);
});
test('real recipient rejection is failed and never retried',async t=>{
  const f=await fixture(t,{rejectRecipient:true});const req=request(f.account);const first=await f.relay.send(req);assert.equal(first.status,'failed');assert.equal(first.code,'smtp_sender_or_recipient');assert.equal(first.scope,'recipient');assert.equal(f.messages.length,0);
  assert.deepEqual(await f.relay.send(req),first);assert.equal(f.authentications,1);
});
