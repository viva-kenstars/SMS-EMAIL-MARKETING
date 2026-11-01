export type MarketingStatus = "draft" | "queued" | "running" | "paused" | "completed" | "cancelled" | "needs_attention";
export type DeliveryStatus = "pending" | "sending" | "accepted" | "failed" | "unknown" | "suppressed";

export interface MarketingSettings {
  relayUrl: string; relayConfigured: boolean; relayVerifiedAt: number | null;
  postalAddress: string; revision: number; configurationAvailable: boolean;
}
export interface SmtpAccount {
  id: string; label: string; host: string; port: number; security: "tls" | "starttls";
  username: string; fromEmail: string; fromName: string; replyTo: string;
  configured: boolean; enabled: boolean; verifiedAt: number | null; revision: number;
  credentialRevision: number; dailyLimit: number; minIntervalSeconds: number;
  sentToday: number; nextAvailableAt: number | null; lastError: string | null;
  createdAt: number; updatedAt: number;
}
export interface EmailGroup { id: string; name: string; contactCount: number; createdAt: number; updatedAt: number }
export interface EmailContact { id: string; email: string; name: string; verifiedAt: number; suppressed: boolean }
export interface CampaignSummary { pending: number; sending: number; accepted: number; failed: number; unknown: number; suppressed: number }
export interface EmailCampaign {
  id: string; name: string; subject: string; preheader: string; html: string; text: string;
  status: MarketingStatus; revision: number; recipientCount: number; summary: CampaignSummary;
  groupIds: string[]; accountIds: string[]; intervalSeconds: number; scheduledAt: number | null;
  nextSendAt: number | null; startedAt: number | null; completedAt: number | null;
  lastError: string | null; createdAt: number; updatedAt: number;
}
export interface EmailDelivery {
  id: string; email: string; name: string; status: DeliveryStatus; accountId: string | null;
  messageId: string | null; error: string | null; updatedAt: number;
}
export interface MarketingRunner { configured: boolean; healthy: boolean; lastHeartbeatAt: number | null; message: string }
export interface VerificationJobChoice { id: string; name: string; status: string; validCount: number; totalRows: number; updatedAt: number }
export interface MarketingState {
  settings: MarketingSettings; accounts: SmtpAccount[]; groups: EmailGroup[]; campaigns: EmailCampaign[];
  verifierJobs: VerificationJobChoice[]; runner: MarketingRunner;
  accountsCursor: string | null; groupsCursor: string | null; campaignsCursor: string | null;
}
