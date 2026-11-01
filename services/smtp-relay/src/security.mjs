import { createHmac, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import ipaddr from 'ipaddr.js';

export class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code=code; }
}

export function string(value, name, max = 255, { optional = false, multiline = false } = {}) {
  if (optional && (value === undefined || value === null || value === '')) return '';
  if (typeof value !== 'string' || value.length > max || !value.trim() || /\0/.test(value) || (!multiline && /[\r\n]/.test(value))) {
    throw new HttpError(400, `Invalid ${name}.`);
  }
  return value.trim();
}

export function email(value, name = 'email') {
  const result = string(value, name, 254);
  const at = result.lastIndexOf('@');
  const local = result.slice(0, at);
  const domain = domainToASCII(result.slice(at + 1)).toLowerCase();
  if (at < 1 || local.length > 64 || !/^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~.]+$/.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..') || !validHostname(domain)) {
    throw new HttpError(400, `Invalid ${name}. Use one plain email address.`);
  }
  // Do not rewrite mailbox local parts or plus aliases.
  return `${local}@${domain}`;
}

export function validHostname(host) {
  return typeof host === 'string' && host.length <= 253 && host.includes('.') && !host.endsWith('.') && !isIP(host) && host.split('.').every(x => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(x));
}

export function publicIp(address) {
  try {
    const parsed = ipaddr.process(address);
    if (parsed.range() !== 'unicast') return false;
    // Only global IPv6 space; disallow transition mechanisms and documentation ranges.
    if (parsed.kind() === 'ipv6' && !parsed.match(ipaddr.parse('2000::'), 3)) return false;
    return true;
  } catch { return false; }
}

export async function resolvePublicHost(host, resolver = lookup) {
  if (!validHostname(host) || /(?:^|\.)(?:localhost|local|internal|home|invalid|test|example|onion)$/.test(host)) {
    throw new HttpError(400, 'Use a public SMTP hostname.');
  }
  let answers;
  try { answers = await resolver(host, { all: true, verbatim: true }); }
  catch { throw new HttpError(400, 'SMTP hostname could not be resolved.'); }
  if (!answers.length || answers.some(x => !publicIp(x.address))) throw new HttpError(400, 'SMTP host must resolve only to public IP addresses.');
  // Passing this literal IP to Nodemailer pins the verified DNS answer. The original
  // hostname is separately retained for SNI and TLS certificate verification.
  return answers.find(x => x.family === 4)?.address ?? answers[0].address;
}

export function validateAccount(input, allowedPorts = [465, 587, 2525]) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'SMTP account is required.');
  const host = domainToASCII(string(input.host, 'SMTP host', 253)).toLowerCase();
  if (!validHostname(host)) throw new HttpError(400, 'Use a public SMTP hostname without a scheme or port.');
  const port = Number(input.port);
  if (!Number.isInteger(port) || !allowedPorts.includes(port)) throw new HttpError(400, 'SMTP port is not enabled on this relay.');
  if (!['tls', 'starttls'].includes(input.security)) throw new HttpError(400, 'Choose TLS or STARTTLS.');
  if (port === 465 && input.security !== 'tls') throw new HttpError(400, 'Port 465 requires TLS.');
  if (port === 587 && input.security !== 'starttls') throw new HttpError(400, 'Port 587 requires STARTTLS.');
  const username = string(input.username, 'SMTP username', 512);
  // Passwords may intentionally contain surrounding whitespace; never trim them.
  if (typeof input.password !== 'string' || !input.password.length || input.password.length > 4096 || /[\r\n\0]/.test(input.password)) throw new HttpError(400, 'Invalid SMTP password.');
  return { host, port, security: input.security, username, password: input.password, fromEmail: email(input.fromEmail, 'From email'), fromName: string(input.fromName, 'From name', 160, {optional:true}), replyTo: input.replyTo ? email(input.replyTo, 'Reply-to email') : '' };
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function digest(value, key) { return createHmac('sha256', key).update(stableJson(value)).digest('hex'); }
export function constantEqual(a, b) {
  const left = Buffer.from(String(a)); const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}
export function authenticate(header, token) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ') || !constantEqual(header.slice(7), token)) throw new HttpError(401, 'Authentication required.');
}
export function signUnsubscribe(owner, address, key) {
  const payload = Buffer.from(JSON.stringify({v:1, owner, email:address})).toString('base64url');
  const signature = createHmac('sha256', key).update(`unsubscribe:${payload}`).digest('base64url');
  return `${payload}.${signature}`;
}
export function readUnsubscribe(token, key) {
  if (typeof token !== 'string' || token.length > 2048 || !/^[\w-]+\.[\w-]+$/.test(token)) throw new HttpError(400, 'Invalid unsubscribe link.');
  const [payload, signature] = token.split('.');
  const expected = createHmac('sha256', key).update(`unsubscribe:${payload}`).digest('base64url');
  if (!constantEqual(signature, expected)) throw new HttpError(400, 'Invalid unsubscribe link.');
  let parsed;
  try { parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); }
  catch { throw new HttpError(400, 'Invalid unsubscribe link.'); }
  if (parsed.v !== 1) throw new HttpError(400, 'Invalid unsubscribe link.');
  return {owner:string(parsed.owner, 'owner', 200), email:email(parsed.email)};
}
export function escapeHtml(value) { return String(value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])); }
