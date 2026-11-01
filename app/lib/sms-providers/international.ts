/** Server-only adapters. Provider contracts reviewed 2026-10-22.
 * Twilio: https://www.twilio.com/docs/messaging/api/message-resource
 * Balance: https://help.twilio.com/articles/360025294494-Check-Your-Twilio-Account-Balance
 * Vonage: https://developer.vonage.com/en/api/sms
 * Balance: https://developer.vonage.com/en/api/account
 * Africa's Talking: https://github.com/AfricasTalkingLtd/africastalking-node.js
 * Response codes: https://help.africastalking.com/en/articles/16150386-messaging-error-codes
 * The official Africa's Talking SDK still uses the legacy form endpoint.
 */
import { segmentInfo, validateSenderId } from "../sms.ts";
import type { DeliveryReport, ProviderOperation } from "../termii.ts";
import type { SmsAdapter, SmsBalance, SmsCredentials, SmsRecipientResult, SmsSendInput } from "./types.ts";
import { invalidResponse, providerJson, recipientFailure, rejected } from "./transport.ts";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function numeric(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value.trim())) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function integer(value: unknown): number | undefined {
  const parsed = numeric(value);
  return parsed !== undefined && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function phoneFromResponse(value: unknown): string | undefined {
  return typeof value === "string" && /^\+?234[789]\d{9}$/.test(value) ? `+${value.replace(/^\+/, "")}` : undefined;
}

function stringId(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value) ? value : undefined;
}

function validateInput(name: string, input: SmsSendInput, maximumBatch: number, maximumLength: number, allowNumber = false) {
  if (!input || !Array.isArray(input.phones) || !input.phones.length || input.phones.length > maximumBatch
    || input.phones.some(phone => typeof phone !== "string" || !/^\+234[789]\d{9}$/.test(phone))
    || new Set(input.phones).size !== input.phones.length) {
    throw rejected(name, "sms_submit", `Use a batch of 1–${maximumBatch} distinct Nigerian mobile numbers in international format.`);
  }
  const numericSender = allowNumber && typeof input.senderId === "string" && /^\+[1-9]\d{6,14}$/.test(input.senderId);
  if (!validateSenderId(input.senderId) && !numericSender) throw rejected(name, "sms_submit", allowNumber
    ? "Enter a permitted branded sender ID or sending number in +international format."
    : "Enter a branded sender ID containing 3–11 letters, numbers, or spaces.");
  if (typeof input.message !== "string" || !input.message.trim() || input.message.length > maximumLength) {
    throw rejected(name, "sms_submit", `Enter a message containing up to ${maximumLength.toLocaleString("en-NG")} characters.`);
  }
  // These integrations use the provider's ordinary SMS account route. No flag
  // in these contracts can activate a Nigerian transactional/DND route.
  if (input.channel !== "generic") throw rejected(name, "sms_submit", "This provider integration uses the standard SMS route. Select Standard SMS and confirm the sender route with your provider.");
}

function credential(credentials: SmsCredentials, field: string, name: string, operation: ProviderOperation): string {
  const value = credentials?.[field];
  if (typeof value !== "string" || !value.trim() || value.length > 4096 || !/^[\x21-\x7e]+$/.test(value)) {
    throw rejected(name, operation, `Update the saved ${name} credentials and test the connection.`);
  }
  return value;
}

function twilioConfig(credentials: SmsCredentials, operation: ProviderOperation) {
  const accountSid = credential(credentials, "accountSid", "Twilio", operation);
  if (!/^AC[0-9a-fA-F]{32}$/.test(accountSid)) throw rejected("Twilio", operation, "Enter the Twilio Account SID beginning with AC, then test the connection.");
  const authToken = credential(credentials, "authToken", "Twilio", operation);
  return { accountSid, headers: { Accept: "application/json", Authorization: `Basic ${btoa(`${accountSid}:${authToken}`)}` } };
}

function vonageConfig(credentials: SmsCredentials, operation: ProviderOperation) {
  const apiKey = credential(credentials, "apiKey", "Vonage", operation);
  const apiSecret = credential(credentials, "apiSecret", "Vonage", operation);
  if (apiKey.includes(":")) throw rejected("Vonage", operation, "Enter the Vonage API key and API secret separately.");
  return { headers: { Accept: "application/json", Authorization: `Basic ${btoa(`${apiKey}:${apiSecret}`)}` } };
}

function africaConfig(credentials: SmsCredentials, operation: ProviderOperation) {
  const username = credential(credentials, "username", "Africa’s Talking", operation);
  const apiKey = credential(credentials, "apiKey", "Africa’s Talking", operation);
  if (username.length > 128 || username.toLowerCase() === "sandbox") {
    throw rejected("Africa’s Talking", operation, "Use your live Africa’s Talking application username. Sandbox balances and simulated sends are not supported here.");
  }
  return { username, headers: { Accept: "application/json", apiKey } };
}

async function perRecipient(phones: string[], submit: (phone: string) => Promise<SmsRecipientResult>): Promise<SmsRecipientResult[]> {
  // A caller supplies at most five. Each request is attempted once and each
  // result is preserved even when another recipient fails or times out.
  const outcomes = await Promise.allSettled(phones.map(submit));
  return outcomes.map((outcome, index) => outcome.status === "fulfilled" ? outcome.value : recipientFailure(phones[index], outcome.reason));
}

const TWILIO_ACCEPTED = new Set(["accepted", "queued", "sending", "sent", "delivered"]);
const TWILIO_FAILED = new Set(["failed", "undelivered", "canceled"]);
const TWILIO_SID = /^SM[0-9a-fA-F]{32}$/;
const VONAGE_REJECTED_CODES = new Set([1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 14, 15, 17, 22, 23, 29, 32, 33]);

const twilio: SmsAdapter = {
  async balance(credentials): Promise<SmsBalance> {
    const config = twilioConfig(credentials, "balance");
    const data = record(await providerJson("Twilio", "balance", `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Balance.json`, { headers: config.headers }));
    const balance = numeric(data?.balance);
    const currency = typeof data?.currency === "string" ? data.currency.toUpperCase() : "";
    if (!data || data.account_sid !== config.accountSid || balance === undefined || !/^[A-Z]{3}$/.test(currency)) throw invalidResponse("Twilio", "balance");
    return { balance, currency, unit: "money" };
  },
  async send(credentials, input) {
    validateInput("Twilio", input, 5, 1600, true);
    const config = twilioConfig(credentials, "sms_submit");
    return perRecipient(input.phones, async phone => {
      const data = record(await providerJson("Twilio", "sms_submit", `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Messages.json`, {
        method: "POST",
        headers: { ...config.headers, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ To: phone, From: input.senderId, Body: input.message }).toString(),
      }));
      const sid = typeof data?.sid === "string" && TWILIO_SID.test(data.sid) ? data.sid : undefined;
      if (!data || !sid || data.account_sid !== config.accountSid || phoneFromResponse(data.to) !== phone || typeof data.status !== "string") throw invalidResponse("Twilio", "sms_submit");
      if (TWILIO_FAILED.has(data.status)) return { phone, status: "failed", providerId: sid, reason: "Twilio reported that this message failed. Check its messaging log for details." };
      if (!TWILIO_ACCEPTED.has(data.status)) return { phone, status: "unknown", providerId: sid, reason: "Twilio returned an unrecognised submission state. Check its messaging log before sending again." };
      return { phone, status: "accepted", providerId: sid };
    });
  },
  async reports(credentials, providerId): Promise<DeliveryReport[]> {
    if (typeof providerId !== "string" || !TWILIO_SID.test(providerId)) throw rejected("Twilio", "delivery_reports", "A valid Twilio message ID is required to refresh this report.");
    const config = twilioConfig(credentials, "delivery_reports");
    const data = record(await providerJson("Twilio", "delivery_reports", `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Messages/${providerId}.json`, { headers: config.headers }));
    const phone = phoneFromResponse(data?.to);
    if (!data || data.sid !== providerId || data.account_sid !== config.accountSid || !phone || typeof data.status !== "string"
      || (!TWILIO_ACCEPTED.has(data.status) && !TWILIO_FAILED.has(data.status))) throw invalidResponse("Twilio", "delivery_reports");
    return [{ phone, providerId, status: data.status === "canceled" ? "failed" : data.status }];
  },
};

const vonage: SmsAdapter = {
  async balance(credentials): Promise<SmsBalance> {
    const config = vonageConfig(credentials, "balance");
    const data = record(await providerJson("Vonage", "balance", "https://rest.nexmo.com/account/get-balance", { headers: config.headers }));
    const balance = numeric(data?.value);
    if (!data || balance === undefined) throw invalidResponse("Vonage", "balance");
    // The Account API documents value in EUR, without a currency response field.
    return { balance, currency: "EUR", unit: "money" };
  },
  async send(credentials, input) {
    validateInput("Vonage", input, 5, 2000, true);
    const config = vonageConfig(credentials, "sms_submit");
    const type = segmentInfo(input.message).encoding === "GSM-7" ? "text" : "unicode";
    return perRecipient(input.phones, async phone => {
      const data = record(await providerJson("Vonage", "sms_submit", "https://rest.nexmo.com/sms/json", {
        method: "POST",
        headers: { ...config.headers, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ from: input.senderId.replace(/^\+/, ""), to: phone.slice(1), text: input.message, type }).toString(),
      }));
      const rows = data?.messages;
      const count = integer(data?.["message-count"]);
      if (!Array.isArray(rows) || !rows.length || rows.length > 50 || count !== rows.length) throw invalidResponse("Vonage", "sms_submit");
      const states: ("accepted" | "failed" | "unknown")[] = [];
      const ids: string[] = [];
      for (const value of rows) {
        const row = record(value);
        const code = integer(row?.status);
        if (!row || code === undefined || (row.to !== undefined && phoneFromResponse(row.to) !== phone)) throw invalidResponse("Vonage", "sms_submit");
        const id = stringId(row["message-id"]);
        if (code === 0) {
          if (!id || phoneFromResponse(row.to) !== phone) throw invalidResponse("Vonage", "sms_submit");
          ids.push(id);
          states.push("accepted");
        } else {
          // A documented error status is a submission rejection. Upstream
          // messages are deliberately excluded because they may echo content.
          states.push(VONAGE_REJECTED_CODES.has(code) ? "failed" : "unknown");
          if (id) ids.push(id);
        }
      }
      const providerId = ids.length ? Array.from(new Set(ids)).join(",") : null;
      if (providerId && providerId.length > 2500) throw invalidResponse("Vonage", "sms_submit");
      if (states.every(state => state === "accepted")) return { phone, status: "accepted", providerId };
      if (states.every(state => state === "failed")) return { phone, status: "failed", providerId, reason: "Vonage rejected this message. Check your balance, sender permissions, and messaging log." };
      // Some parts may already have been accepted. Never classify a partially
      // accepted concatenated message as safe to send again.
      return { phone, status: "unknown", providerId, reason: "Vonage did not confirm every message part. Check its messaging log before sending again." };
    });
  },
};

const africastalking: SmsAdapter = {
  async balance(credentials): Promise<SmsBalance> {
    const config = africaConfig(credentials, "balance");
    const url = new URL("https://api.africastalking.com/version1/user");
    url.searchParams.set("username", config.username);
    const data = record(await providerJson("Africa’s Talking", "balance", url.toString(), { headers: config.headers }));
    const user = record(data?.UserData);
    const match = typeof user?.balance === "string" ? /^([A-Za-z]{3})\s+(-?\d+(?:\.\d+)?)$/.exec(user.balance.trim()) : null;
    const balance = match ? numeric(match[2]) : undefined;
    if (!match || balance === undefined) throw invalidResponse("Africa’s Talking", "balance");
    return { balance, currency: match[1].toUpperCase(), unit: "money" };
  },
  async send(credentials, input) {
    validateInput("Africa’s Talking", input, 100, 2000);
    const config = africaConfig(credentials, "sms_submit");
    let data: Record<string, unknown> | undefined;
    try {
      data = record(await providerJson("Africa’s Talking", "sms_submit", "https://api.africastalking.com/version1/messaging", {
        method: "POST",
        headers: { ...config.headers, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ username: config.username, to: input.phones.join(","), from: input.senderId, message: input.message, bulkSMSMode: "1", enqueue: "1" }).toString(),
      }));
    } catch (error) {
      return input.phones.map(phone => recipientFailure(phone, error));
    }
    const envelope = record(data?.SMSMessageData);
    const rows = envelope?.Recipients;
    if (!Array.isArray(rows) || rows.length > input.phones.length) return input.phones.map(phone => recipientFailure(phone, invalidResponse("Africa’s Talking", "sms_submit")));
    const recipients = new Set(input.phones);
    const grouped = new Map<string, Record<string, unknown>[]>();
    for (const value of rows) {
      const row = record(value);
      const phone = phoneFromResponse(row?.number);
      if (!row || !phone || !recipients.has(phone)) return input.phones.map(recipient => recipientFailure(recipient, invalidResponse("Africa’s Talking", "sms_submit")));
      grouped.set(phone, [...(grouped.get(phone) ?? []), row]);
    }
    return input.phones.map(phone => {
      const matches = grouped.get(phone);
      if (!matches || matches.length !== 1) return recipientFailure(phone, invalidResponse("Africa’s Talking", "sms_submit"));
      const row = matches[0];
      const code = integer(row.statusCode);
      const providerId = stringId(row.messageId) ?? null;
      if (code !== undefined && [100, 101, 102].includes(code) && providerId) return { phone, status: "accepted", providerId };
      if (code !== undefined && [401, 402, 403, 404, 405, 406, 407, 502].includes(code)) return { phone, status: "failed", providerId, reason: "Africa’s Talking rejected this recipient. Check the sender approval, balance, and messaging log." };
      return { phone, status: "unknown", providerId, reason: "Africa’s Talking did not confirm this recipient’s submission. Check its messaging log before sending again." };
    });
  },
};

export const internationalAdapters: Record<string, SmsAdapter> = { twilio, vonage, africastalking };
