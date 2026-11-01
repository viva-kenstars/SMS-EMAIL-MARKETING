import nodemailer from 'nodemailer';
import { HttpError, validateAccount, resolvePublicHost, string, email, digest, signUnsubscribe, escapeHtml } from './security.mjs';

export function loadConfig(env = process.env) {
  const token = env.SMTP_RELAY_TOKEN;
  const signingKey = env.SMTP_RELAY_SIGNING_KEY;
  if (!token || token.length < 32 || /\s/.test(token)) throw new Error('SMTP_RELAY_TOKEN must contain at least 32 non-whitespace characters.');
  if (!signingKey || signingKey.length < 32 || /\s/.test(signingKey)) throw new Error('SMTP_RELAY_SIGNING_KEY must contain at least 32 non-whitespace characters.');
  if (token === signingKey) throw new Error('Use different relay authentication and unsubscribe signing keys.');
  let publicUrl;
  try { publicUrl = new URL(env.SMTP_RELAY_PUBLIC_URL); } catch { throw new Error('SMTP_RELAY_PUBLIC_URL must be an HTTPS origin.'); }
  if (publicUrl.protocol !== 'https:' || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash || publicUrl.pathname !== '/') throw new Error('SMTP_RELAY_PUBLIC_URL must be an HTTPS origin without credentials or a path.');
  const allowedPorts = (env.SMTP_ALLOWED_PORTS || '465,587,2525').split(',').map(Number);
  if (allowedPorts.some(x => !Number.isInteger(x) || x < 1 || x > 65535)) throw new Error('SMTP_ALLOWED_PORTS is invalid.');
  const port = Number(env.PORT || 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.');
  return { token, signingKey, publicUrl:publicUrl.origin, allowedPorts, port, host:env.BIND_HOST || '127.0.0.1', database:env.SMTP_RELAY_DATABASE || './data/relay.sqlite', maxConcurrent:Math.max(1,Math.min(32,Number(env.SMTP_MAX_CONCURRENT)||5)) };
}

function safeSmtpError(error, checking = false) {
  if (error?.code === 'EAUTH' || error?.code === 'ENOAUTH') return 'SMTP authentication failed. Check the username and app password.';
  if (error?.code === 'ETLS' || /CERT|TLS|SSL/.test(String(error?.code || ''))) return 'A secure SMTP connection could not be established. Check TLS settings and the server certificate.';
  if (error?.code === 'EENVELOPE') return 'The SMTP server rejected the sender or recipient.';
  if (Number(error?.responseCode) >= 400 && Number(error?.responseCode) < 600) return 'The SMTP server rejected this request. Review the provider account and sending limits.';
  return checking ? 'The SMTP connection could not be verified. Check the host, port, TLS settings and credentials.' : 'Delivery outcome is uncertain. Check the SMTP provider before any manual resend.';
}

function smtpFailureCode(error) {
  if(['EAUTH','ENOAUTH'].includes(error?.code))return 'smtp_auth';
  if(error?.code==='ETLS' || /CERT|TLS|SSL/.test(String(error?.code||'')))return 'smtp_tls';
  if([421,450,451,452,454].includes(Number(error?.responseCode)))return 'smtp_rate_limit';
  if(error?.code==='EENVELOPE')return 'smtp_sender_or_recipient';
  if(['EDNS','ECONFIG'].includes(error?.code))return 'smtp_config';
  if(Number(error?.responseCode)>=400 && Number(error?.responseCode)<600)return 'smtp_rejected';
  return 'smtp_unknown';
}

function definitelyRejected(error) {
  return ['EAUTH','ENOAUTH','ETLS','EENVELOPE','EDNS','ECONFIG'].includes(error?.code) || /CERT|TLS|SSL/.test(String(error?.code || '')) || (Number(error?.responseCode) >= 400 && Number(error?.responseCode) < 600);
}

async function withDeadline(transport, operation, timeoutMs = 45000) {
  let timer;
  try {
    return await Promise.race([operation(),new Promise((_,reject)=>{timer=setTimeout(()=>{transport.close();reject(Object.assign(new Error('SMTP deadline'),{code:'ETIMEDOUT'}));},timeoutMs);timer.unref?.();})]);
  } finally { clearTimeout(timer); transport.close(); }
}

export function createRelay({config,ledger,resolveHost=resolvePublicHost,createTransport=nodemailer.createTransport,trustCa,timeoutMs=45000}) {
  // resolveHost and trustCa are dependency-injection seams for local fixtures.
  // The production server never accepts or supplies overrides from requests/env.
  async function transport(account) {
    const address = await resolveHost(account.host);
    return createTransport({
      host:address, port:account.port, secure:account.security === 'tls',
      requireTLS:account.security === 'starttls', ignoreTLS:false, opportunisticTLS:false,
      tls:{servername:account.host,rejectUnauthorized:true,minVersion:'TLSv1.2',...(trustCa?{ca:trustCa}:{})},
      auth:{user:account.username,pass:account.password},
      connectionTimeout:10000,greetingTimeout:10000,socketTimeout:20000,
      pool:false,logger:false,debug:false,disableFileAccess:true,disableUrlAccess:true
    });
  }
  async function check(input) {
    const account = validateAccount(input?.account,config.allowedPorts);
    const smtp = await transport(account);
    try { await withDeadline(smtp,()=>smtp.verify(),timeoutMs); return {ok:true}; }
    catch(error) { throw new HttpError(400,safeSmtpError(error,true),smtpFailureCode(error)); }
  }
  async function send(input) {
    if (!input || typeof input !== 'object') throw new HttpError(400,'Send request is required.');
    const owner = string(input.owner,'owner',200);
    const deliveryId = string(input.deliveryId,'delivery ID',200);
    const account = validateAccount(input.account,config.allowedPorts);
    const message = input.message;
    if (!message || typeof message !== 'object') throw new HttpError(400,'Message is required.');
    const to = email(message.to,'recipient');
    const subject = string(message.subject,'subject',998);
    const html = string(message.html,'HTML body',512000,{optional:true,multiline:true});
    const text = string(message.text,'text body',512000,{optional:true,multiline:true});
    if (!html && !text) throw new HttpError(400,'An HTML or text body is required.');
    const replyTo = message.replyTo ? email(message.replyTo,'reply-to email') : account.replyTo;
    const postalAddress = string(input.postalAddress,'postal address',1000,{optional:true,multiline:true});
    const requestDigest = digest({owner,deliveryId,account,message:{to,subject,html,text,replyTo},postalAddress},config.signingKey);
    const claim = ledger.claim(owner,deliveryId,requestDigest);
    if (!claim.claimed) return claim.result;
    const finish = result => ledger.finish(owner,deliveryId,result);
    if (ledger.suppressed(owner,to)) return finish({status:'suppressed',code:'suppressed',error:'The recipient has unsubscribed.'});
    let smtp;
    try {
      smtp = await transport(account);
    } catch(error) {
      return finish({status:'failed',code:'smtp_config',scope:'account',error:error instanceof HttpError ? error.message : 'SMTP configuration could not be validated.'});
    }
    // DNS/TLS preparation may be asynchronous; check again immediately before SMTP.
    if (ledger.suppressed(owner,to)) { smtp.close(); return finish({status:'suppressed',code:'suppressed',error:'The recipient has unsubscribed.'}); }
    const token = signUnsubscribe(owner,to,config.signingKey);
    const unsubscribeUrl = `${config.publicUrl}/unsubscribe/${token}`;
    const footerHtml = `<div style="font:12px/1.6 Arial,sans-serif;color:#64748b;padding:24px 16px;text-align:center;border-top:1px solid #e2e8f0">${postalAddress?`<p>${escapeHtml(postalAddress).replace(/\n/g,'<br>')}</p>`:''}<p><a href="${escapeHtml(unsubscribeUrl)}" style="color:#475569;text-decoration:underline">Unsubscribe from these emails</a></p></div>`;
    const renderedHtml = html.replaceAll('{{unsubscribe_url}}',escapeHtml(unsubscribeUrl));
    const fullHtml = renderedHtml ? (/<\/body\s*>/i.test(renderedHtml)?renderedHtml.replace(/<\/body\s*>/i,`${footerHtml}</body>`):renderedHtml+footerHtml) : undefined;
    const fullText = `${text.replaceAll('{{unsubscribe_url}}',unsubscribeUrl)}\n\n${postalAddress?`${postalAddress}\n`:''}Unsubscribe: ${unsubscribeUrl}`;
    const messageId = `<${digest({owner,deliveryId},config.signingKey).slice(0,48)}@${account.fromEmail.split('@')[1]}>`;
    try {
      const info = await withDeadline(smtp,()=>smtp.sendMail({
        from:{name:account.fromName,address:account.fromEmail},to:[{address:to}],
        envelope:{from:account.fromEmail,to:[to]},subject,html:fullHtml,text:fullText,
        ...(replyTo?{replyTo:[{address:replyTo}]}:{}),messageId,
        headers:{'List-Unsubscribe':`<${unsubscribeUrl}>`,'List-Unsubscribe-Post':'List-Unsubscribe=One-Click'},
        disableFileAccess:true,disableUrlAccess:true,attachDataUrls:false
      }),timeoutMs);
      if (Array.isArray(info.accepted) && info.accepted.some(value=>(typeof value==='string'?value:value.address) === to)) return finish({status:'accepted',messageId});
      if (Array.isArray(info.rejected) && info.rejected.length) return finish({status:'failed',code:'smtp_sender_or_recipient',scope:'recipient',error:'The SMTP server rejected the recipient.'});
      return finish({status:'unknown',code:'smtp_unknown',error:'The SMTP server did not confirm acceptance. Check provider history before any manual resend.'});
    } catch(error) {
      const status=definitelyRejected(error)?'failed':'unknown';
      return finish({status,code:smtpFailureCode(error),...(status==='failed'?{scope:error?.command==='RCPT TO' && Number(error?.responseCode)>=500?'recipient':'account'}:{}),error:safeSmtpError(error)});
    }
  }
  return {check,send};
}
