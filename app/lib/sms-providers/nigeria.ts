/**
 * Nigeria-focused SMS adapters. Credentials stay on the server.
 * Contracts reviewed 2026-10-22 against provider-owned documentation:
 * https://www.bulksmsnigeria.com/api
 * https://developer.smartsmssolutions.com/
 * https://sendchamp.readme.io/reference/send-sms-api
 * https://sendchamp.readme.io/reference/get-wallet-balance-api
 *
 * Provider acceptance is never treated as handset delivery. These adapters use
 * the promotional routes only; transactional/OTP routing requires a separate
 * sender and use-case approval and is not an automatic fallback.
 */
import { normalizePhone, segmentInfo } from "../sms.ts";
import type { DeliveryReport, ProviderOperation } from "../termii.ts";
import { invalidResponse, providerJson, recipientFailure, rejected } from "./transport.ts";
import type { SmsAdapter, SmsCredentials, SmsRecipientResult, SmsSendInput } from "./types.ts";

type JsonObject = Record<string, unknown>;
const BSNG = "BulkSMSNigeria";
const SMART = "SmartSMSSolutions";
const SENDCHAMP = "Sendchamp";
const BSNG_BASE = "https://www.bulksmsnigeria.com/api/v2";
const SMART_BASE = "https://app.smartsmssolutions.com/io/api/client/v1";
const SENDCHAMP_BASE = "https://api.sendchamp.com/api/v1";

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function amount(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value.trim()))) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function identifier(value: unknown): string | null {
  // Numeric JSON IDs can lose precision. These three contracts specify strings.
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(value) ? value : null;
}

function token(credentials: SmsCredentials, name: string, operation: ProviderOperation): string {
  const value = credentials.apiToken;
  if (typeof value !== "string" || !value.trim() || value.length > 4096 || /[\r\n]/.test(value)) {
    throw rejected(name, operation, `Enter the ${name} API token in provider settings.`);
  }
  return value.trim();
}

function validateInput(name: string, input: SmsSendInput, batchLimit: number, allowSpaces = true) {
  if (!Array.isArray(input.phones) || input.phones.length < 1 || input.phones.length > batchLimit
    || input.phones.some(phone => typeof phone !== "string" || !/^\+234[789]\d{9}$/.test(phone))
    || new Set(input.phones).size !== input.phones.length) {
    throw rejected(name, "sms_submit", `Use a valid batch of up to ${batchLimit} distinct Nigerian mobile numbers.`);
  }
  if (input.channel !== "generic") throw rejected(name, "sms_submit", `${name} is configured for promotional SMS. Select the standard SMS route.`);
  const senderPattern = allowSpaces ? /^[A-Za-z0-9 ]{3,11}$/ : /^[A-Za-z0-9]{1,11}$/;
  if (typeof input.senderId !== "string" || !senderPattern.test(input.senderId) || !/[A-Za-z]/.test(input.senderId)) {
    throw rejected(name, "sms_submit", allowSpaces
      ? "Use a sender ID with 3–11 letters, numbers or spaces, including at least one letter."
      : "Use a sender ID with 1–11 letters or numbers, including at least one letter. Spaces are not supported by this provider.");
  }
  if (typeof input.message !== "string" || !input.message.trim() || input.message.length > 1530) {
    throw rejected(name, "sms_submit", "Enter a message of 1–1,530 characters.");
  }
}

function bearer(value: string): Record<string, string> {
  return { Authorization: `Bearer ${value}`, Accept: "application/json" };
}

function unknownResult(phone: string, providerId: string | null, name: string): SmsRecipientResult {
  return { phone, providerId, status: "unknown", reason: `${name} did not confirm this recipient. Check its message history before sending again.` };
}

const bulkSmsNigeria: SmsAdapter = {
  async balance(credentials) {
    const response = object(await providerJson(BSNG, "balance", `${BSNG_BASE}/balance`, {
      headers: bearer(token(credentials, BSNG, "balance")),
    }));
    if (object(response?.data)?.status !== "success") throw invalidResponse(BSNG, "balance");
    const balance = amount(object(response?.balance)?.total_balance);
    if (balance === null) throw invalidResponse(BSNG, "balance");
    return { balance, currency: "NGN", unit: "money" };
  },

  async send(credentials, input) {
    validateInput(BSNG, input, 100, false);
    const response = object(await providerJson(BSNG, "sms_submit", `${BSNG_BASE}/sms`, {
      method: "POST", headers: { ...bearer(token(credentials, BSNG, "sms_submit")), "Content-Type": "application/json" },
      body: JSON.stringify({ from: input.senderId, to: input.phones.map(phone => phone.slice(1)).join(","),
        body: input.message, gateway: "direct-refund", unicode: true }),
    }));
    if (response?.status === "error" && typeof response.code === "string" && /^BSNG-\d{4}$/.test(response.code)) {
      throw rejected(BSNG, "sms_submit");
    }
    const data = object(response?.data);
    if (response?.status !== "success" || response.code !== "BSNG-0000" || !data) throw invalidResponse(BSNG, "sms_submit");
    const providerId = identifier(data.message_id);
    if (!providerId) throw invalidResponse(BSNG, "sms_submit");
    // A count mismatch or an unexpected gateway does not establish which
    // recipients were submitted; retain the ID for reconciliation, never retry.
    const confirmed = data.recipients_count === input.phones.length
      && data.gateway_used === "direct-refund"
      && (data.skipped_recipients === undefined || (Array.isArray(data.skipped_recipients) && data.skipped_recipients.length === 0))
      && (response.skipped_recipients === undefined || (Array.isArray(response.skipped_recipients) && response.skipped_recipients.length === 0));
    return input.phones.map(phone => confirmed ? { phone, providerId, status: "accepted" } : unknownResult(phone, providerId, BSNG));
  },

  async reports(credentials, providerId) {
    if (!identifier(providerId)) throw rejected(BSNG, "delivery_reports", "A valid provider message ID is required to refresh delivery reports.");
    const url = new URL(`${BSNG_BASE}/delivery-reports`);
    url.searchParams.set("message_id", providerId);
    url.searchParams.set("per_page", "1000");
    const response = object(await providerJson(BSNG, "delivery_reports", url, {
      headers: bearer(token(credentials, BSNG, "delivery_reports")),
    }));
    const data = object(response?.data);
    if (response?.status !== "success" || response.code !== "BSNG-0000" || data?.message_id !== providerId
      || !Array.isArray(data.reports) || data.reports.length > 1000) throw invalidResponse(BSNG, "delivery_reports");
    const seen = new Set<string>();
    const result: DeliveryReport[] = [];
    for (const item of data.reports) {
      const report = object(item);
      const phone = normalizePhone(report?.recipient);
      if (!phone || seen.has(phone) || typeof report?.delivery_status !== "string" || report.delivery_status.length > 100) {
        throw invalidResponse(BSNG, "delivery_reports");
      }
      seen.add(phone);
      const raw = report.delivery_status.trim().toLowerCase();
      const status = ["delivrd", "delivered", "success"].includes(raw) ? "delivered"
        : ["queued", "pending", "processing", "sent awaiting status", "sent", "enroute"].includes(raw) ? "accepted"
        : ["undeliv", "undelivrd", "expired", "rejectd", "failed", "rejected", "undelivered", "dnd"].includes(raw) ? "failed" : "unknown";
      result.push({ phone, providerId, status });
    }
    // A native app batch has <=100 recipients, below this request's page size.
    // Do not issue extra, unbounded pagination requests for unexpected results.
    return result;
  },
};

function phoneList(value: unknown, expected: Set<string>): Set<string> | null {
  if (typeof value !== "string" || value.length > 2000) return null;
  if (!value.trim()) return new Set();
  const result = new Set<string>();
  for (const item of value.split(",")) {
    const phone = normalizePhone(item.trim());
    if (!phone || !expected.has(phone) || result.has(phone)) return null;
    result.add(phone);
  }
  return result;
}

const smartSms: SmsAdapter = {
  async balance(credentials) {
    const url = new URL(`${SMART_BASE}/balance/`);
    url.searchParams.set("token", token(credentials, SMART, "balance"));
    const response = await providerJson(SMART, "balance", url, { headers: { Accept: "application/json" } });
    const balance = amount(response);
    if (balance === null) throw invalidResponse(SMART, "balance");
    // The documented endpoint returns a scalar without a currency identifier.
    // Preserve it as provider credit units instead of assuming a naira wallet.
    return { balance, currency: "credits", unit: "credits" };
  },

  async send(credentials, input) {
    validateInput(SMART, input, 100);
    const form = new FormData();
    form.set("token", token(credentials, SMART, "sms_submit"));
    form.set("sender", input.senderId);
    form.set("to", input.phones.map(phone => phone.slice(1)).join(","));
    form.set("message", input.message);
    form.set("type", segmentInfo(input.message).encoding === "Unicode" ? "2" : "0");
    form.set("routing", "2");
    const response = object(await providerJson(SMART, "sms_submit", `${SMART_BASE}/sms/`, {
      method: "POST", headers: { Accept: "application/json" }, body: form,
    }));
    if (response?.code !== 1000) throw invalidResponse(SMART, "sms_submit");
    const expected = new Set(input.phones);
    const successes = phoneList(response.successful, expected);
    if (!successes) throw invalidResponse(SMART, "sms_submit");
    const providerId = identifier(response.message_id);
    if (successes.size > 0 && !providerId) throw invalidResponse(SMART, "sms_submit");
    const failures = new Map<string, string>();
    for (const [field, reason] of [
      ["failed", "The provider rejected this recipient."],
      ["flooding", "The provider blocked a duplicate or rate-limited recipient."],
      ["insufficient_unit", "The provider reported insufficient credit for this recipient."],
      ["invalid", "The provider reported an invalid recipient."],
      ["dnd_numbers", "This number is on DND and cannot receive messages on the promotional route."],
    ]) {
      if (response[field] === undefined) continue;
      const phones = phoneList(response[field], expected);
      if (!phones) throw invalidResponse(SMART, "sms_submit");
      for (const phone of phones) failures.set(phone, reason);
    }
    return input.phones.map(phone => {
      if (successes.has(phone) && failures.has(phone)) return unknownResult(phone, providerId, SMART);
      if (successes.has(phone)) return { phone, providerId, status: "accepted" };
      if (failures.has(phone)) return { phone, providerId: null, status: "failed", reason: failures.get(phone) };
      return unknownResult(phone, providerId, SMART);
    });
  },
};

const sendchamp: SmsAdapter = {
  async balance(credentials) {
    const response = object(await providerJson(SENDCHAMP, "balance", `${SENDCHAMP_BASE}/wallet/wallet_balance`, {
      method: "POST", headers: bearer(token(credentials, SENDCHAMP, "balance")),
    }));
    const data = object(response?.data);
    const balance = amount(data?.available_balance);
    if (response?.status !== "success" || String(response.code) !== "200" || balance === null
      || typeof data?.currency !== "string" || !/^[A-Z]{3}$/.test(data.currency)) throw invalidResponse(SENDCHAMP, "balance");
    return { balance, currency: data.currency, unit: "money" };
  },

  async send(credentials, input) {
    validateInput(SENDCHAMP, input, 5);
    const apiToken = token(credentials, SENDCHAMP, "sms_submit");
    // The send endpoint accepts arrays, but its published response schema only
    // identifies one phone. One request per phone preserves exact attribution.
    return Promise.all(input.phones.map(async phone => {
      try {
        const response = object(await providerJson(SENDCHAMP, "sms_submit", `${SENDCHAMP_BASE}/sms/send`, {
          method: "POST", headers: { ...bearer(apiToken), "Content-Type": "application/json" },
          body: JSON.stringify({ to: [phone.slice(1)], message: input.message, sender_name: input.senderId, route: "non_dnd" }),
        }));
        if ((response?.status === "failed" || response?.status === "error")
          && ["400", "401", "403", "422", "429"].includes(String(response.code))) throw rejected(SENDCHAMP, "sms_submit");
        const data = object(response?.data);
        const providerId = identifier(data?.id);
        if (response?.status !== "success" || String(response.code) !== "200" || !data || !providerId
          || normalizePhone(data.phone_number) !== phone
          || typeof data.status !== "string"
          || !["processing", "pending", "queued", "sent", "delivered"].includes(data.status.toLowerCase())) {
          throw invalidResponse(SENDCHAMP, "sms_submit");
        }
        return { phone, providerId, status: "accepted" as const };
      } catch (error) { return recipientFailure(phone, error); }
    }));
  },
};

export const nigeriaAdapters: Record<string, SmsAdapter> = {
  bulksmsnigeria: bulkSmsNigeria,
  smartsmssolutions: smartSms,
  sendchamp,
};
