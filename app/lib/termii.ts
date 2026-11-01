/**
 * Server-side Termii adapter. Never import this module into a client component.
 * Documentation reviewed 2026-10-22:
 * https://developers.termii.com/messaging-api/
 * https://developers.termii.com/balance
 * https://developers.termii.com/history
 * https://developers.termii.com/templates
 * https://developers.termii.com/sender-id/
 * https://developers.termii.com/error
 * The account's regional base URL must come from its Termii dashboard.
 */
import { validWhatsAppId } from "./whatsapp.ts";

export type TermiiConfig = { apiKey: string; baseUrl: string };
export type ProviderOutcome = "rejected" | "unknown";
export type ProviderOperation = "configuration" | "balance" | "delivery_reports" | "sms_submit" | "whatsapp_submit" | "sender_ids" | "sender_id_request";
export type ProviderReason = "validation" | "authentication" | "rate_limited" | "http_error" | "timeout" | "network_error" | "redirect" | "invalid_json" | "invalid_response";
export type ProviderContentType = "application/json" | "text/html" | "text/plain" | "other" | "missing";
export type ProviderDiagnostics = {
  operation: ProviderOperation;
  reason: ProviderReason;
  upstreamStatus?: number;
  contentType?: ProviderContentType;
};

export class ProviderError extends Error {
  readonly outcome: ProviderOutcome;
  readonly operation: ProviderOperation;
  readonly reason: ProviderReason;
  readonly upstreamStatus?: number;
  readonly contentType?: ProviderContentType;

  constructor(message: string, outcome: ProviderOutcome, diagnostics: ProviderDiagnostics) {
    super(message);
    this.name = "ProviderError";
    this.outcome = outcome;
    this.operation = diagnostics.operation;
    this.reason = diagnostics.reason;
    this.upstreamStatus = diagnostics.upstreamStatus;
    this.contentType = diagnostics.contentType;
  }
}

export type BulkMessage = {
  phones: string[];
  senderId: string;
  message: string;
  channel: "generic" | "dnd";
};

export type DeliveryReport = {
  phone: string;
  providerId: string;
  status: string;
  amount?: number;
};

export type WhatsAppTemplateMessage = {
  phone: string;
  deviceId: string;
  templateId: string;
  data: Record<string, string>;
};

export type SenderIdRecord = {
  senderId: string;
  country: string;
  status: "active" | "pending" | "blocked" | "unknown";
  createdAt: string | null;
};

export type SenderIdsResult = {
  senderIds: SenderIdRecord[];
  complete: boolean;
  total: number | null;
};

export type SenderIdRequest = {
  senderId: string;
  company: string;
  useCase: string;
};

const UNCONFIRMED = "The provider did not confirm the result. Check provider history before sending again.";
const INVALID_RESPONSE = "The provider returned an unrecognised response. Check provider history before sending again.";

/** Only an HTTPS origin on Termii-owned domains is accepted, including no explicit port. */
export function validateBaseUrl(input: string, operation: ProviderOperation = "configuration"): string {
  const invalid = () => new ProviderError(operation === "sender_ids"
    ? "Enter the HTTPS API base URL from your Termii dashboard for the sender-ID check. This check does not send messages."
    : operation === "sender_id_request"
      ? "Enter the HTTPS API base URL from your Termii dashboard before the sender-ID approval submission. This request does not send messages."
      : "Enter the HTTPS API base URL from your Termii dashboard.", "rejected", { operation, reason: "validation" });
  if (typeof input !== "string") throw invalid();
  const value = input.trim();
  // Reject path normalization, backslashes, credentials, empty query/fragment, and explicit ports.
  if (!/^https:\/\/[^/?#\\]+\/?$/i.test(value)) throw invalid();
  let url: URL;
  try { url = new URL(value); } catch { throw invalid(); }
  const authority = value.replace(/^https:\/\//i, "").replace(/\/$/, "");
  const host = url.hostname;
  const allowed = host === "termii.com" || host.endsWith(".termii.com") || host === "termii.ai" || host.endsWith(".termii.ai");
  const validDns = host.length <= 253 && host.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
  if (!allowed || !validDns || authority.includes(":") || authority.includes("@") || url.username || url.password || url.search || url.hash || url.pathname !== "/" || url.port || url.protocol !== "https:") throw invalid();
  return url.origin;
}

function endpoint(config: TermiiConfig, path: string, operation: ProviderOperation): URL {
  if (!config || typeof config.apiKey !== "string" || !config.apiKey.trim()) {
    throw new ProviderError(operation === "sender_ids"
      ? "Configure your Termii API key before the sender-ID check. This check does not send messages."
      : operation === "sender_id_request"
        ? "Configure your Termii API key before the sender-ID approval submission. This request does not send messages."
        : "Configure your Termii API key before connecting.", "rejected", { operation, reason: "validation" });
  }
  return new URL(path, validateBaseUrl(config.baseUrl, operation));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function numeric(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value.trim())) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** Never stringify an unsafe numeric identifier: JSON parsing may already have rounded it. */
function identifier(value: unknown): string | undefined {
  if (typeof value === "string" && value.length <= 256 && /^[A-Za-z0-9_-]+$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return undefined;
}

function responseIdentifier(data: Record<string, unknown>): string | undefined {
  // The string representation is authoritative for Termii's long numeric IDs.
  const stringId = typeof data.message_id_str === "string" ? identifier(data.message_id_str) : undefined;
  return stringId ?? identifier(data.message_id);
}

type RequestOperation = Exclude<ProviderOperation, "configuration">;
type ResponseDetails = Pick<ProviderDiagnostics, "upstreamStatus" | "contentType">;

/** Classify the header; never retain arbitrary upstream header values. */
function responseDetails(response: Response): ResponseDetails {
  const mediaType = response.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase();
  const contentType: ProviderContentType = !mediaType ? "missing"
    : mediaType === "application/json" || /^application\/[a-z0-9.+_-]+\+json$/.test(mediaType) ? "application/json"
    : mediaType === "text/html" ? "text/html"
    : mediaType === "text/plain" ? "text/plain" : "other";
  const status = response.status;
  return { ...(Number.isInteger(status) && status >= 100 && status <= 599 ? { upstreamStatus: status } : {}), contentType };
}

function requestFailure(operation: RequestOperation, reason: ProviderReason, outcome: ProviderOutcome = "unknown", details: ResponseDetails = {}): ProviderError {
  let message: string;
  if (operation === "balance" || operation === "delivery_reports" || operation === "sender_ids") {
    const check = operation === "balance" ? "balance check" : operation === "sender_ids" ? "sender-ID check" : "delivery-report check";
    const retry = operation === "balance" ? "Try the connection test again." : operation === "sender_ids" ? "Try refreshing the sender IDs again." : "Try refreshing the reports again.";
    if (reason === "rate_limited") message = `Termii rate-limited the ${check} (HTTP 429). Wait before trying this check again.`;
    else if (reason === "authentication") message = details.upstreamStatus === 403
      ? `Termii denied permission for the ${check}. Check account permissions and whether this service is enabled in Termii.`
      : `Termii did not accept authentication for the ${check}. Check your API key and the account-specific HTTPS API base URL in your Termii dashboard.`;
    else if (details.upstreamStatus === 400 || details.upstreamStatus === 422) message = `Termii rejected request fields for the ${check}. Check the saved API connection settings and account-specific API base URL.`;
    else if (reason === "redirect") message = `Termii redirected the ${check}. Check the account-specific API base URL.`;
    else if (reason === "timeout") message = `The Termii ${check} timed out. ${retry}`;
    else if (reason === "network_error") message = `The Termii ${check} could not connect. Check the account-specific API base URL. ${retry}`;
    else if (reason === "invalid_json" || reason === "invalid_response") message = `Termii did not return a valid response to the ${check}. Check the account-specific API base URL. ${retry}`;
    else if (outcome === "rejected") message = `Termii rejected the ${check}. Check your API base URL and account access.`;
    else message = `Termii could not complete the ${check}. ${retry}`;
    message += " This check does not send messages.";
  } else if (operation === "sender_id_request") {
    if (reason === "rate_limited") message = "Termii rate-limited the sender-ID approval submission (HTTP 429). Wait before trying again and check the sender-ID list for an existing request.";
    else if (reason === "authentication") message = details.upstreamStatus === 403
      ? "Termii denied permission for the sender-ID approval submission. Check account permissions and whether sender-ID registration is enabled in Termii."
      : "Termii did not accept authentication for the sender-ID approval submission. Check your API key and the account-specific HTTPS API base URL in your Termii dashboard.";
    else if (outcome === "rejected") message = "Termii rejected the sender-ID approval submission. Check the requested sender ID, company, and sample message fields.";
    else message = "Termii did not confirm the sender-ID approval submission. Check the sender-ID list before retrying the approval request.";
    message += " This request does not send messages.";
  } else if (reason === "rate_limited") {
    message = "Termii rejected this submission because its API request rate was exceeded (HTTP 429). Wait before trying again and review campaign results before resending.";
  } else if (reason === "authentication") {
    message = details.upstreamStatus === 403
      ? "Termii denied permission for this submission. Check account permissions and whether the selected messaging service or route is enabled in Termii."
      : "Termii did not accept the API credentials. Check your API key and the account-specific HTTPS API base URL in your Termii dashboard, then test the connection.";
  } else if (details.upstreamStatus === 400 || details.upstreamStatus === 422) {
    message = operation === "whatsapp_submit"
      ? "Termii rejected one or more WhatsApp request fields. Check the phone number, approved device and template IDs, and template variables."
      : "Termii rejected one or more SMS request fields. Check the phone numbers, approved sender ID, message, and selected route.";
  } else if (outcome === "rejected") {
    message = operation === "whatsapp_submit"
      ? "The provider rejected the WhatsApp request. Check your account balance, approved device and template, and message settings."
      : "The provider rejected the request. Check your account balance, sender ID, and message settings.";
  } else {
    message = reason === "invalid_response" ? INVALID_RESPONSE : UNCONFIRMED;
  }
  return new ProviderError(message, outcome, { operation, reason, ...details });
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

async function requestJson(url: URL, operation: RequestOperation, init: RequestInit = {}): Promise<{ data: unknown; details: ResponseDetails }> {
  let response: Response;
  try {
    response = await fetch(url.toString(), {
      ...init,
      headers: { Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}) },
      signal: AbortSignal.timeout(15_000),
      // Workers supports only follow/manual. Inspect redirects without following
      // them, forwarding credentials, or replaying a submission POST.
      redirect: "manual",
    });
  } catch (error) {
    // Do not retain raw exceptions: they can contain URLs and credentials.
    throw requestFailure(operation, isTimeout(error) ? "timeout" : "network_error");
  }
  const details = responseDetails(response);
  if (response.status >= 300 && response.status < 400) {
    throw requestFailure(operation, "redirect", "unknown", details);
  }
  if (!response.ok) {
    const rejected = response.status >= 400 && response.status < 500 && response.status !== 408;
    const reason = response.status === 429 ? "rate_limited"
      : response.status === 401 || response.status === 403 ? "authentication" : "http_error";
    throw requestFailure(operation, reason, rejected ? "rejected" : "unknown", details);
  }
  try {
    return { data: await response.json(), details };
  } catch (error) {
    // Parsing failures never establish a safe-to-retry submission outcome.
    throw requestFailure(operation, isTimeout(error) ? "timeout" : "invalid_json", "unknown", details);
  }
}

export async function getBalance(config: TermiiConfig): Promise<{ balance: number; currency: string }> {
  const url = endpoint(config, "/api/get-balance", "balance");
  url.searchParams.set("api_key", config.apiKey);
  const response = await requestJson(url, "balance");
  const data = asRecord(response.data);
  const balance = numeric(data?.balance);
  const currency = data?.currency;
  if (balance === undefined || typeof currency !== "string" || !/^[A-Za-z]{3}$/.test(currency)) {
    throw requestFailure("balance", "invalid_response", "unknown", response.details);
  }
  return { balance, currency: currency.toUpperCase() };
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const MESSAGE_CONTROL_CHARACTERS = /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const MAX_SENDER_ID_ROWS = 1_000;

/** Read only the documented first response; pagination request parameters are undocumented. */
export async function getSenderIds(config: TermiiConfig): Promise<SenderIdsResult> {
  const url = endpoint(config, "/api/sender-id", "sender_ids");
  url.searchParams.set("api_key", config.apiKey);
  const response = await requestJson(url, "sender_ids");
  const data = asRecord(response.data);
  const invalid = () => requestFailure("sender_ids", "invalid_response", "unknown", response.details);
  if (!data || !Array.isArray(data.content) || data.content.length > MAX_SENDER_ID_ROWS) throw invalid();

  function text(value: unknown, maxLength: number): string {
    if (typeof value !== "string" || !value.trim() || value.length > maxLength || CONTROL_CHARACTERS.test(value)) throw invalid();
    return value.trim();
  }

  const senderIds: SenderIdRecord[] = data.content.map(value => {
    const row = asRecord(value);
    if (!row) throw invalid();
    const senderId = text(row.sender_id, 64);
    const country = text(row.country, 100);
    const rawStatus = text(row.status, 64).toLowerCase();
    const status: SenderIdRecord["status"] = rawStatus === "active" || rawStatus === "pending" || rawStatus === "blocked" ? rawStatus : "unknown";
    const createdAt = row.createdAt === undefined || row.createdAt === null ? null : text(row.createdAt, 64);
    return { senderId, country, status, createdAt };
  });

  // Validate present metadata instead of coercing strings such as "false".
  function count(record: Record<string, unknown>, key: string): number | undefined {
    const value = record[key];
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw invalid();
    return value;
  }
  function flag(record: Record<string, unknown>, key: string): boolean | undefined {
    const value = record[key];
    if (value === undefined) return undefined;
    if (typeof value !== "boolean") throw invalid();
    return value;
  }
  const pageable = data.pageable === undefined ? {} : asRecord(data.pageable);
  if (!pageable) throw invalid();
  const total = count(data, "totalElements");
  const totalPages = count(data, "totalPages");
  const number = count(data, "number");
  const pageNumber = count(pageable, "pageNumber");
  const offset = count(pageable, "offset");
  const size = count(data, "size");
  const pageSize = count(pageable, "pageSize");
  const numberOfElements = count(data, "numberOfElements");
  const first = flag(data, "first");
  const last = flag(data, "last");
  const empty = flag(data, "empty");
  const paged = flag(pageable, "paged");
  const unpaged = flag(pageable, "unpaged");
  const length = senderIds.length;
  const inconsistentOrPartial = first === false || last === false
    || (number !== undefined && number !== 0) || (pageNumber !== undefined && pageNumber !== 0)
    || (offset !== undefined && offset !== 0) || (totalPages !== undefined && totalPages > 1)
    || (total !== undefined && total !== length)
    || (numberOfElements !== undefined && numberOfElements !== length)
    || (size !== undefined && size < length) || (pageSize !== undefined && pageSize < length)
    || (size !== undefined && pageSize !== undefined && size !== pageSize)
    || (empty !== undefined && empty !== (length === 0))
    || (totalPages === 0 && length > 0) || (paged !== undefined && unpaged !== undefined && paged === unpaged);
  const startsAtBeginning = first === true || number === 0 || pageNumber === 0 || offset === 0;
  const endsHere = last === true || (totalPages !== undefined && totalPages <= 1);
  const complete = !inconsistentOrPartial
    && (total === length || unpaged === true || (startsAtBeginning && endsHere));
  return { senderIds, complete, total: total ?? null };
}

/** App limits for an approval request, independent of approval or route activation. */
export function validateSenderIdRequest(input: unknown): SenderIdRequest {
  const invalid = (message: string) => new ProviderError(message, "rejected", { operation: "sender_id_request", reason: "validation" });
  const record = asRecord(input);
  if (!record) throw invalid("Enter a sender ID, company name, and sample message for the approval request.");
  function field(key: string): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    return descriptor?.enumerable && "value" in descriptor ? descriptor.value : undefined;
  }
  const rawSenderId = field("senderId");
  const rawCompany = field("company");
  const rawUseCase = field("useCase");
  if (typeof rawSenderId !== "string" || CONTROL_CHARACTERS.test(rawSenderId)
    || !/^[A-Za-z0-9]{3,11}$/.test(rawSenderId.trim()) || !/[A-Za-z]/.test(rawSenderId)) {
    throw invalid("For sender-ID approval, use 3 to 11 letters and numbers with at least one letter.");
  }
  if (typeof rawCompany !== "string" || CONTROL_CHARACTERS.test(rawCompany) || /[\u2028\u2029]/.test(rawCompany)
    || rawCompany.trim().length < 2 || rawCompany.trim().length > 200) {
    throw invalid("For sender-ID approval, enter a company name between 2 and 200 characters without control characters.");
  }
  if (typeof rawUseCase !== "string" || MESSAGE_CONTROL_CHARACTERS.test(rawUseCase)
    || rawUseCase.trim().length < 10 || rawUseCase.trim().length > 2_000) {
    throw invalid("For sender-ID approval, enter a sample message between 10 and 2,000 characters. Line breaks are allowed; other control characters are not.");
  }
  return { senderId: rawSenderId.trim(), company: rawCompany.trim(), useCase: rawUseCase.trim() };
}

/** Submits for provider review; acknowledgement never establishes sender approval. */
export async function requestSenderId(config: TermiiConfig, input: unknown): Promise<{ submitted: true }> {
  const value = validateSenderIdRequest(input);
  const url = endpoint(config, "/api/sender-id/request", "sender_id_request");
  const response = await requestJson(url, "sender_id_request", {
    method: "POST",
    body: JSON.stringify({ api_key: config.apiKey, sender_id: value.senderId, use_case: value.useCase, company: value.company }),
  });
  const data = asRecord(response.data);
  if (data?.code !== "ok") throw requestFailure("sender_id_request", "invalid_response", "unknown", response.details);
  return { submitted: true };
}

export async function sendBulk(config: TermiiConfig, message: BulkMessage): Promise<{ providerId: string; balance?: number }> {
  if (!message || !Array.isArray(message.phones) || message.phones.length < 1 || message.phones.length > 100) {
    throw new ProviderError("Each provider batch must contain between 1 and 100 recipients.", "rejected", { operation: "sms_submit", reason: "validation" });
  }
  if (message.phones.some(phone => typeof phone !== "string" || !/^[1-9]\d{6,14}$/.test(phone))) {
    throw new ProviderError("Recipients must use international phone numbers containing digits only.", "rejected", { operation: "sms_submit", reason: "validation" });
  }
  if (typeof message.senderId !== "string" || !/^[A-Za-z0-9 ]{3,11}$/.test(message.senderId) || !message.senderId.trim()) {
    throw new ProviderError("Use an approved sender ID containing 3 to 11 letters, numbers, or spaces.", "rejected", { operation: "sms_submit", reason: "validation" });
  }
  if (typeof message.message !== "string" || !message.message.trim() || !["generic", "dnd"].includes(message.channel)) {
    throw new ProviderError("Enter a message and select a valid messaging route.", "rejected", { operation: "sms_submit", reason: "validation" });
  }
  const url = endpoint(config, "/api/sms/send/bulk", "sms_submit");
  const response = await requestJson(url, "sms_submit", {
    method: "POST",
    body: JSON.stringify({
      api_key: config.apiKey,
      to: message.phones,
      from: message.senderId,
      sms: message.message,
      type: "plain",
      channel: message.channel,
    }),
  });
  const data = asRecord(response.data);
  const providerId = data ? responseIdentifier(data) : undefined;
  if (data?.code !== "ok" || !providerId) throw requestFailure("sms_submit", "invalid_response", "unknown", response.details);
  const balance = numeric(data.balance);
  return { providerId, ...(balance !== undefined ? { balance } : {}) };
}

/** Copy only bounded, own, flat string variables into a safe request object. */
function whatsappVariables(input: unknown): Record<string, string> {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error();
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) throw new Error();
    const keys = Reflect.ownKeys(input);
    if (keys.length > 20) throw new Error();
    const values: Record<string, string> = {};
    for (const key of keys) {
      if (typeof key !== "string" || !/^[A-Za-z0-9_]{1,64}$/.test(key) || key === "prototype" || Object.hasOwn(Object.prototype, key)) {
        throw new Error();
      }
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw new Error();
      const value: unknown = descriptor.value;
      if (typeof value !== "string" || !value.trim() || value.length > 1500 || /[{}]/.test(value)) throw new Error();
      values[key] = value;
    }
    return values;
  } catch {
    throw new ProviderError("Use up to 20 valid WhatsApp template variables with nonempty text values of at most 1,500 characters.", "rejected", { operation: "whatsapp_submit", reason: "validation" });
  }
}

/** Send one pre-approved WhatsApp text template; this does not verify approval. */
export async function sendWhatsAppTemplate(config: TermiiConfig, message: WhatsAppTemplateMessage): Promise<{ providerId: string; balance?: number }> {
  if (!message || Array.isArray(message) || typeof message.phone !== "string" || !/^[1-9]\d{6,14}$/.test(message.phone)) {
    throw new ProviderError("A WhatsApp template request must contain one international phone number using digits only.", "rejected", { operation: "whatsapp_submit", reason: "validation" });
  }
  if (!validWhatsAppId(message.deviceId) || !validWhatsAppId(message.templateId)) {
    throw new ProviderError("Enter valid WhatsApp device and template IDs from your Termii dashboard.", "rejected", { operation: "whatsapp_submit", reason: "validation" });
  }
  const variables = whatsappVariables(message.data);
  const url = endpoint(config, "/api/send/template", "whatsapp_submit");
  const response = await requestJson(url, "whatsapp_submit", {
    method: "POST",
    body: JSON.stringify({
      api_key: config.apiKey,
      phone_number: message.phone,
      device_id: message.deviceId,
      template_id: message.templateId,
      data: variables,
    }),
  });
  const data = asRecord(response.data);
  const providerId = data ? responseIdentifier(data) : undefined;
  if (data?.code !== "ok" || !providerId) throw requestFailure("whatsapp_submit", "invalid_response", "unknown", response.details);
  const balance = numeric(data.balance);
  return { providerId, ...(balance !== undefined ? { balance } : {}) };
}

export async function getDeliveryReports(config: TermiiConfig, providerId: string): Promise<DeliveryReport[]> {
  if (typeof providerId !== "string" || !identifier(providerId)) {
    throw new ProviderError("A valid provider message ID is required to refresh delivery reports.", "rejected", { operation: "delivery_reports", reason: "validation" });
  }
  const url = endpoint(config, "/api/sms/inbox", "delivery_reports");
  url.searchParams.set("api_key", config.apiKey);
  url.searchParams.set("message_id", providerId);
  const response = await requestJson(url, "delivery_reports");
  const data = response.data;
  if (!Array.isArray(data)) throw requestFailure("delivery_reports", "invalid_response", "unknown", response.details);
  const reports: DeliveryReport[] = [];
  for (const value of data) {
    const row = asRecord(value);
    const id = row ? responseIdentifier(row) : undefined;
    if (!row || !id) throw requestFailure("delivery_reports", "invalid_response", "unknown", response.details);
    // Never apply an unrelated report even if the provider ignores the query scope.
    if (id !== providerId) continue;
    const phone = typeof row.receiver === "string" ? row.receiver.replace(/^\+/, "") : "";
    if (!/^[1-9]\d{6,14}$/.test(phone) || typeof row.status !== "string" || !row.status.trim() || row.status.length > 160) {
      throw requestFailure("delivery_reports", "invalid_response", "unknown", response.details);
    }
    const amount = numeric(row.amount);
    if (row.amount !== undefined && row.amount !== null && amount === undefined) {
      throw requestFailure("delivery_reports", "invalid_response", "unknown", response.details);
    }
    reports.push({ phone, providerId: id, status: row.status, ...(amount !== undefined ? { amount } : {}) });
  }
  return reports;
}
