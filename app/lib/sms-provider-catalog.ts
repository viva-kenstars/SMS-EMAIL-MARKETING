/** Public metadata only. Credentials and provider HTTP clients remain server-side. */
export type SmsProviderId = "termii" | "bulksmsnigeria" | "smartsmssolutions" | "africastalking" | "twilio" | "vonage" | "sendchamp";
export type SmsProviderDefinition = {
  id: SmsProviderId; name: string; description: string; website: string; docsUrl: string;
  setupHelp: string; senderHelp: string;
  fields: { key: string; label: string; secret: boolean; placeholder?: string }[];
  senderType: "alphanumeric" | "flexible"; reports: "polling" | "dashboard";
  batchSize: number; maxMessageLength: number; supportsDnd: boolean;
};
export type SmsProviderState = SmsProviderDefinition & {
  configured: boolean; credentialsConfigured: Record<string, boolean>; publicValues: Record<string, string>;
  configurationAvailable: boolean; verifiedAt: number | null; revision: number; credentialRevision: number;
  senderId: string; senderApproved: boolean; ratePerSegment: number | null; transactionalEnabled: boolean;
  isActive: boolean; readiness: string[];
};
export type SmsProviderBalance = { providerId: SmsProviderId; balance: number; currency: string; unit: "money" | "credits"; fetchedAt: number; credentialRevision: number };

export const SMS_PROVIDERS: SmsProviderDefinition[] = [
  {
    id: "termii", name: "Termii", description: "Bulk SMS and your existing WhatsApp connection.",
    website: "https://termii.com", docsUrl: "https://developers.termii.com/messaging-api/",
    setupHelp: "Use the API key and account-specific base URL from your Termii dashboard. WhatsApp continues to use this connection independently of the active SMS provider.",
    senderHelp: "Select an active Nigerian sender ID from Termii, or confirm approval in the Termii setup below. Sender registration and DND route approval are separate.",
    fields: [{ key: "apiKey", label: "API key", secret: true }, { key: "baseUrl", label: "Account API base URL", secret: false, placeholder: "https://your-account.termii.com" }],
    senderType: "alphanumeric", reports: "polling", batchSize: 100, maxMessageLength: 2000, supportsDnd: true,
  },
  {
    id: "bulksmsnigeria", name: "BulkSMSNigeria", description: "Nigeria SMS with wallet balance and delivery reports.",
    website: "https://www.bulksmsnigeria.com", docsUrl: "https://www.bulksmsnigeria.com/api",
    setupHelp: "Paste the API token from your account. This integration uses the direct-refund route and preserves Unicode text. The displayed wallet balance is in naira.",
    senderHelp: "Use a sender name approved for your account and traffic. Sender names contain up to 11 letters or numbers, without spaces. Corporate and OTP routes are not enabled here.",
    fields: [{ key: "apiToken", label: "API token", secret: true }],
    senderType: "alphanumeric", reports: "polling", batchSize: 100, maxMessageLength: 1530, supportsDnd: false,
  },
  {
    id: "smartsmssolutions", name: "SmartSMSSolutions", description: "Nigeria bulk SMS with a separate credit balance.",
    website: "https://smartsmssolutions.com", docsUrl: "https://developer.smartsmssolutions.com/",
    setupHelp: "Generate an API token in your SmartSMSSolutions account. SMS uses the basic route. The balance API returns credit units without a currency, so the app displays credits.",
    senderHelp: "Register or whitelist your sender name with SmartSMSSolutions before activating. Check final delivery results in its dashboard.",
    fields: [{ key: "apiToken", label: "API token", secret: true }],
    senderType: "alphanumeric", reports: "dashboard", batchSize: 100, maxMessageLength: 1530, supportsDnd: false,
  },
  {
    id: "africastalking", name: "Africa’s Talking", description: "Bulk SMS with individual recipient acceptance results.",
    website: "https://africastalking.com", docsUrl: "https://developers.africastalking.com/docs/sms/sending",
    setupHelp: "Use your live application username and API key. Sandbox credentials are not accepted for this live provider. Balance uses the currency returned by the account API.",
    senderHelp: "Register a Nigerian sender ID with Africa’s Talking. Network and account restrictions still apply. Final delivery reports are available through the provider.",
    fields: [{ key: "username", label: "Application username", secret: false }, { key: "apiKey", label: "API key", secret: true }],
    senderType: "alphanumeric", reports: "dashboard", batchSize: 100, maxMessageLength: 2000, supportsDnd: false,
  },
  {
    id: "twilio", name: "Twilio", description: "SMS with account balance and message status lookup.",
    website: "https://www.twilio.com", docsUrl: "https://www.twilio.com/docs/messaging/api/message-resource",
    setupHelp: "Enter the Account SID and Auth Token for the same live account. Enable Nigeria in your messaging geographic permissions. Trial account restrictions still apply.",
    senderHelp: "Use a permitted alphanumeric sender ID or SMS-capable Twilio number in +international format. Confirm Nigerian sender requirements with Twilio before activating.",
    fields: [{ key: "accountSid", label: "Account SID", secret: false, placeholder: "AC…" }, { key: "authToken", label: "Auth Token", secret: true }],
    senderType: "flexible", reports: "polling", batchSize: 5, maxMessageLength: 1600, supportsDnd: false,
  },
  {
    id: "vonage", name: "Vonage", description: "SMS API with a euro-denominated account balance.",
    website: "https://www.vonage.com/communications-apis/sms/", docsUrl: "https://developer.vonage.com/en/api/sms",
    setupHelp: "Use your SMS API key and secret. Balance is returned in EUR. This integration uses the SMS API; final delivery status is available in the Vonage dashboard.",
    senderHelp: "Use a sender name or number permitted by Vonage for Nigeria. Destination and sender registration restrictions apply to the account.",
    fields: [{ key: "apiKey", label: "API key", secret: true }, { key: "apiSecret", label: "API secret", secret: true }],
    senderType: "flexible", reports: "dashboard", batchSize: 5, maxMessageLength: 2000, supportsDnd: false,
  },
  {
    id: "sendchamp", name: "Sendchamp", description: "SMS with a documented default sender and wallet balance.",
    website: "https://sendchamp.com", docsUrl: "https://sendchamp.readme.io/reference/send-sms-api",
    setupHelp: "Paste the live access token from Sendchamp. This integration uses its non-DND route. Balance uses the currency returned by your wallet API.",
    senderHelp: "Sendchamp documents Sendchamp as a default sender name. Use it only when permitted for your account and destination, or enter a custom sender approved by Sendchamp.",
    fields: [{ key: "apiToken", label: "Live access token", secret: true }],
    senderType: "alphanumeric", reports: "dashboard", batchSize: 5, maxMessageLength: 1530, supportsDnd: false,
  },
];

export function getSmsProviderDefinition(id: unknown): SmsProviderDefinition | undefined {
  return SMS_PROVIDERS.find(provider => provider.id === id);
}
export function validSmsSender(id: unknown, value: unknown): boolean {
  if (typeof value !== "string") return false;
  const provider = getSmsProviderDefinition(id);
  if (!provider) return false;
  if (provider.senderType === "flexible" && /^\+[1-9]\d{6,14}$/.test(value)) return true;
  if (id === "bulksmsnigeria") return /^(?=.*[A-Za-z])[A-Za-z0-9]{1,11}$/.test(value);
  return /^(?=.*[A-Za-z])[A-Za-z0-9 ]{3,11}$/.test(value);
}
