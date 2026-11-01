import { getBalance, getDeliveryReports, sendBulk } from "../termii";
import { getSmsProviderDefinition, validSmsSender, type SmsProviderId } from "../sms-provider-catalog";
import { nigeriaAdapters } from "./nigeria";
import { internationalAdapters } from "./international";
import { invalidResponse, rejected } from "./transport";
import type { SmsAdapter, SmsCredentials, SmsSendInput } from "./types";

const termii: SmsAdapter = {
  async balance(credentials) { return { ...await getBalance({ apiKey: credentials.apiKey, baseUrl: credentials.baseUrl }), unit: "money" }; },
  async send(credentials, input) {
    const result = await sendBulk({ apiKey: credentials.apiKey, baseUrl: credentials.baseUrl }, { ...input, phones: input.phones.map(phone => phone.replace(/^\+/, "")) });
    return input.phones.map(phone => ({ phone, status: "accepted", providerId: result.providerId }));
  },
  reports: (credentials, providerId) => getDeliveryReports({ apiKey: credentials.apiKey, baseUrl: credentials.baseUrl }, providerId),
};
const adapters: Record<string, SmsAdapter> = { termii, ...nigeriaAdapters, ...internationalAdapters };
export function smsAdapter(id: SmsProviderId): SmsAdapter {
  const adapter = adapters[id];
  if (!adapter) throw rejected("SMS provider", "configuration", "This SMS provider is not available.");
  return adapter;
}

export async function submitSms(id: SmsProviderId, credentials: SmsCredentials, input: SmsSendInput) {
  const definition = getSmsProviderDefinition(id)!;
  if (!definition || !validSmsSender(id, input.senderId) || !input.message.trim() || input.message.length > definition.maxMessageLength
    || input.phones.length < 1 || input.phones.length > definition.batchSize || new Set(input.phones).size !== input.phones.length || input.phones.some(phone => !/^\+234[789]\d{9}$/.test(phone))
    || input.channel === "dnd" && !definition.supportsDnd) throw rejected(definition?.name || "SMS provider", "sms_submit", "The campaign does not match this provider’s sender, message or route requirements. Review a new draft.");
  const results = await smsAdapter(id).send(credentials, input);
  const seen = new Set<string>();
  if (!Array.isArray(results) || results.length !== input.phones.length || results.some(result => {
    if (!result || !input.phones.includes(result.phone) || seen.has(result.phone) || !["accepted", "failed", "unknown"].includes(result.status)) return true;
    seen.add(result.phone);
    return result.status === "accepted" && (typeof result.providerId !== "string" || !result.providerId || result.providerId.length > 3000 || /[^\x20-\x7e]/.test(result.providerId));
  })) throw invalidResponse(definition.name, "sms_submit");
  return results;
}
