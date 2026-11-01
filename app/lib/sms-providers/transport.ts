import { ProviderError, type ProviderOperation, type ProviderContentType } from "../termii.ts";
import type { SmsRecipientResult } from "./types.ts";

const submitting = (operation: ProviderOperation) => operation === "sms_submit" || operation === "whatsapp_submit" || operation === "sender_id_request";
export function invalidResponse(name: string, operation: ProviderOperation): ProviderError {
  return new ProviderError(submitting(operation)
    ? `${name} did not confirm the submission. Check its message history before sending again.`
    : `${name} returned an unrecognised response. Check the saved credentials and try refreshing.`,
  "unknown", { operation, reason: "invalid_response" });
}
export function rejected(name: string, operation: ProviderOperation, safeMessage?: string): ProviderError {
  // safeMessage must be a developer-authored string, never a raw provider value.
  return new ProviderError(safeMessage || `${name} rejected this request. Check the account balance, sender permissions and provider dashboard.`, "rejected", { operation, reason: "validation" });
}
export function recipientFailure(phone: string, error: unknown): SmsRecipientResult {
  return { phone, status: error instanceof ProviderError && error.outcome === "rejected" ? "failed" : "unknown", providerId: null,
    reason: error instanceof ProviderError ? error.message : "The submission could not be confirmed. Check provider history before sending again." };
}
function contentType(value: string | null): ProviderContentType {
  if (!value) return "missing";
  const mime = value.split(";")[0].trim().toLowerCase();
  return mime === "application/json" || mime === "text/html" || mime === "text/plain" ? mime : "other";
}

/** One request only: no redirect following, no submission retry, no raw response in errors. */
export async function providerJson(name: string, operation: ProviderOperation, url: string | URL, init: RequestInit = {}): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    let response: Response;
    try { response = await fetch(url, { ...init, redirect: "manual", signal: controller.signal }); }
    catch {
      const reason = controller.signal.aborted ? "timeout" : "network_error";
      throw new ProviderError(submitting(operation)
        ? `${name} did not confirm the submission. Check its message history before sending again.`
        : `${name} could not be reached. Check the connection and refresh the balance.`, "unknown", { operation, reason });
    }
    const diagnostic = { operation, upstreamStatus: response.status, contentType: contentType(response.headers.get("content-type")) };
    if (response.status >= 300 && response.status < 400) throw new ProviderError(`${name} redirected the API request. No redirect was followed; check the provider connection.`, "unknown", { ...diagnostic, reason: "redirect" });
    if (!response.ok) {
      const authentication = response.status === 401 || response.status === 403;
      const certain = response.status >= 400 && response.status < 500 && response.status !== 408;
      const rateLimited = response.status === 429;
      const fields = operation === "sms_submit" ? "phone numbers, approved sender, message and route"
        : operation === "whatsapp_submit" ? "phone number, approved device and template, and template variables"
        : operation === "sender_id_request" ? "sender ID, company and sample message"
        : "saved connection settings and the requested account resource";
      throw new ProviderError(rateLimited
        ? `${name} rate-limited this request (HTTP 429). Wait before trying again.${submitting(operation) ? " Review campaign results before resending." : " This check does not send messages."}`
        : response.status === 401 ? `${name} did not accept the saved API credentials. Check the credentials and account environment in the provider dashboard, then save them and test the connection.`
        : response.status === 403 ? `${name} denied permission for this request. Check account permissions and whether the messaging service or route is enabled in the provider dashboard.`
        : response.status === 400 || response.status === 422 ? `${name} rejected one or more request fields. Check the ${fields}.`
        : submitting(operation) && !certain ? `${name} did not confirm the submission. Check its message history before sending again.`
        : `${name} could not complete this request. Check the provider dashboard and account permissions.`, certain ? "rejected" : "unknown", { ...diagnostic, reason: rateLimited ? "rate_limited" : authentication ? "authentication" : "http_error" });
    }
    let value: unknown;
    try {
      const text = await response.text();
      if (text.length > 1_500_000) throw new Error("Response too large");
      value = JSON.parse(text);
    } catch {
      throw new ProviderError(submitting(operation) ? `${name} did not confirm the submission. Check its message history before sending again.` : `${name} returned an unreadable API response. Check your credentials and refresh.`, "unknown", { ...diagnostic, reason: controller.signal.aborted ? "timeout" : "invalid_json" });
    }
    return value;
  } finally { clearTimeout(timeout); }
}
