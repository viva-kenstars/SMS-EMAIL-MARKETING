export type EmailCategory = "valid" | "invalid" | "risky" | "unknown";
export type EmailRowStatus = "pending" | "processing" | EmailCategory;
export type EmailJobStatus = "uploading" | "ready" | "running" | "paused" | "waiting_credits" | "needs_attention" | "completed" | "cancelled";
export type EmailBatchStatus = "submitting" | "submitted" | "completed" | "unknown" | "rejected" | "cancelled";
export type EmailBalance = { dailyCredits: number; instantCredits: number; availableCredits: number; checkedAt: number; credentialRevision: number };
export type EmailSettings = { configured: boolean; configurationAvailable: boolean; verifiedAt: number | null; revision: number; credentialRevision: number; balance: EmailBalance | null };
export type EmailCounts = { total: number; pending: number; processing: number; valid: number; invalid: number; risky: number; unknown: number; duplicates: number };
export type EmailJob = {
  id: string; name: string; sourceName: string; status: EmailJobStatus; counts: EmailCounts;
  importedChunks: number; nextChunkIndex: number; totalRows: number; sealed: boolean;
  eligibleCount: number; invalidSyntaxCount: number; credentialRevision: number | null;
  createdAt: number; updatedAt: number; startedAt: number | null; completedAt: number | null;
  processedRows: number; progressPercent: number; nextRunAt: number | null; error: string | null;
};
export type EmailBatch = {
  id: string; index: number; mode: "bulk" | "single"; status: EmailBatchStatus;
  taskId: string | null; count: number; attempts: number; nextPollAt: number | null;
  createdAt: number; updatedAt: number; error: string | null;
};
export type EmailResultRow = {
  position: number; sourceRow: string | null; email: string; normalizedEmail: string | null;
  status: EmailRowStatus; category: EmailCategory | null; reason: string;
  providerStatus: string | null; duplicateOf: number | null; checkedAt: number | null;
};
export type EmailInputRow = { email: string; sourceRow?: string | number };
