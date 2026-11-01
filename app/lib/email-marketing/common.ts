import { isEncryptionKeyReady } from "../secret-store";
import { normalizeEmailIdentity } from "../email/reoon";

export type Row = Record<string, any>;
export type Context = { db: D1Database; owner: string; masterKey?: string; fetch?: typeof globalThis.fetch; workerTokenHash?: string; appOrigin?: string };
export class MarketingError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "marketing_request_failed") { super(message); }
}
export const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
export const conflict = () => new MarketingError("This item changed in another session. Reload it before saving again.", 409, "marketing_revision_conflict");
export function assertKey(key?: string): asserts key is string {
  if (!isEncryptionKeyReady(key)) throw new MarketingError("Secure credential storage is unavailable. Contact the administrator.", 503);
}
export function text(value: unknown, label: string, max = 200, fallback = "") {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new MarketingError(`Enter a valid ${label} of at most ${max} characters.`);
  return value.trim();
}
export function integer(value: unknown, label: string, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new MarketingError(`Enter a valid ${label} between ${min} and ${max}.`);
  return value;
}
export function email(value: unknown, label = "email address") {
  if (typeof value !== "string" || value.length > 254) throw new MarketingError(`Enter a valid ${label}.`);
  const normalized = normalizeEmailIdentity(value.trim());
  if (!normalized) throw new MarketingError(`Enter a valid ${label}.`);
  return normalized;
}
export function publicHost(value: unknown, label: string) {
  const host = text(value, label, 253).toLowerCase();
  if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host)
    || /(^|\.)(localhost|local|internal|lan|home|invalid|test)$/.test(host)) throw new MarketingError(`Use a public domain name for ${label}. Private addresses and IP literals are not supported.`);
  return host;
}
export function relayOrigin(value: unknown) {
  if (typeof value !== "string" || value.length > 300) throw new MarketingError("Enter the HTTPS SMTP service origin.");
  let url: URL;
  try { url = new URL(value); } catch { throw new MarketingError("Enter the HTTPS SMTP service origin."); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/" || url.port && url.port !== "443") throw new MarketingError("Use the HTTPS SMTP service origin without credentials, a custom port, path, query or fragment.");
  publicHost(url.hostname, "SMTP service");
  return url.origin;
}
export async function bodyOf(request: Request, appOrigin?: string): Promise<Row> {
  const origin = request.headers.get("origin");
  if (request.headers.get("sec-fetch-site") === "cross-site" || origin && origin !== new URL(request.url).origin && origin !== appOrigin) throw new MarketingError("Open this action from your workspace.", 403);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new MarketingError("Use a JSON request.", 415);
  const reader = request.body?.getReader();
  if (!reader) throw new MarketingError("Use a JSON object.");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let raw = "", bytes = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 1_048_576) { await reader.cancel(); throw new MarketingError("This request is too large. Use a template smaller than 512 KB.", 413); }
      raw += decoder.decode(part.value, { stream: true });
    }
    raw += decoder.decode();
  } catch (error) { if (error instanceof MarketingError) throw error; throw new MarketingError("Use valid UTF-8 JSON."); }
  finally { reader.releaseLock(); }
  try { const value = JSON.parse(raw); if (value && typeof value === "object" && !Array.isArray(value)) return value; } catch { /* Return safe validation below. */ }
  throw new MarketingError("Use a JSON object.");
}
export const emptySummary = () => ({ pending: 0, sending: 0, accepted: 0, failed: 0, unknown: 0, suppressed: 0 });
export const accountContext = (owner: string, id: string, revision: number) => JSON.stringify(["trezad-marketing", "smtp", owner, id, revision]);
export const relayContext = (owner: string, revision: number) => JSON.stringify(["trezad-marketing", "relay", owner, revision]);
export const day = () => new Date().toISOString().slice(0, 10);
export const nextDay = () => Date.parse(`${day()}T00:00:00Z`) + 86_400_000;
export function cursorValue(raw: string | null) {
  if (!raw) return null;
  try { const value = JSON.parse(atob(raw)); if (Number.isSafeInteger(value.t) && typeof value.id === "string" && /^[a-f0-9-]{32,36}$/.test(value.id)) return value as { t: number; id: string }; } catch { /* Invalid cursor below. */ }
  throw new MarketingError("This page cursor is invalid.");
}
export const cursorFor = (row: Row) => btoa(JSON.stringify({ t: row.created_at, id: row.id }));
export async function digest(value: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), b => b.toString(16).padStart(2, "0")).join("");
}
