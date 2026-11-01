import { sqliteTable, text, integer, real, index, uniqueIndex, primaryKey } from "drizzle-orm/sqlite-core";

export const settings = sqliteTable("settings", {
  owner: text("owner").primaryKey(),
  senderId: text("sender_id").notNull().default("Trezad"),
  senderApproved: integer("sender_approved").notNull().default(0),
  senderApprovalSource: text("sender_approval_source"),
  senderCredentialRevision: integer("sender_credential_revision"),
  senderVerifiedAt: integer("sender_verified_at"),
  ratePerSegment: real("rate_per_segment"),
  transactionalEnabled: integer("transactional_enabled").notNull().default(0),
  updatedAt: integer("updated_at").notNull(),
});

export const senderIdRequests = sqliteTable("sender_id_requests", {
  id: text("id").primaryKey(),
  owner: text("owner").notNull(),
  credentialRevision: integer("credential_revision").notNull(),
  senderId: text("sender_id").notNull(),
  senderKey: text("sender_key").notNull(),
  status: text("status").notNull(),
  reason: text("reason"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [uniqueIndex("sender_requests_owner_connection_name").on(table.owner, table.credentialRevision, table.senderKey)]);

export const providerSettings = sqliteTable("provider_settings", {
  owner: text("owner").primaryKey(),
  apiKeyCiphertext: text("api_key_ciphertext"),
  baseUrl: text("base_url").notNull().default(""),
  liveEnabled: integer("live_enabled").notNull().default(0),
  verifiedAt: integer("verified_at"),
  revision: integer("revision").notNull().default(1),
  credentialRevision: integer("credential_revision").notNull().default(1),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const whatsappSettings = sqliteTable("whatsapp_settings", {
  owner: text("owner").primaryKey(),
  deviceId: text("device_id").notNull().default(""),
  businessName: text("business_name").notNull().default(""),
  templateId: text("template_id").notNull().default(""),
  templateBody: text("template_body").notNull().default(""),
  category: text("category").notNull().default("marketing"),
  accountApproved: integer("account_approved").notNull().default(0),
  templateApproved: integer("template_approved").notNull().default(0),
  liveEnabled: integer("live_enabled").notNull().default(0),
  ratePerMessage: real("rate_per_message"),
  revision: integer("revision").notNull().default(1),
  providerRevision: integer("provider_revision").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const smsProviderAccounts = sqliteTable("sms_provider_accounts", {
  owner: text("owner").notNull(),
  provider: text("provider").notNull(),
  credentialsCiphertext: text("credentials_ciphertext"),
  publicValues: text("public_values").notNull().default("{}"),
  configuredFields: text("configured_fields").notNull().default("{}"),
  verifiedAt: integer("verified_at"),
  revision: integer("revision").notNull().default(1),
  credentialRevision: integer("credential_revision").notNull().default(1),
  senderId: text("sender_id").notNull().default(""),
  senderApproved: integer("sender_approved").notNull().default(0),
  ratePerSegment: real("rate_per_segment"),
  transactionalEnabled: integer("transactional_enabled").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, table => [uniqueIndex("sms_accounts_owner_provider").on(table.owner, table.provider)]);

export const smsRouting = sqliteTable("sms_routing", {
  owner: text("owner").primaryKey(),
  activeProvider: text("active_provider"),
  activeCredentialRevision: integer("active_credential_revision"),
  revision: integer("revision").notNull().default(1),
  updatedAt: integer("updated_at").notNull(),
});

export const contacts = sqliteTable("contacts", {
  id: text("id").primaryKey(), owner: text("owner").notNull(),
  name: text("name").notNull(), phone: text("phone").notNull(),
  groupName: text("group_name").notNull().default("General"),
  consent: integer("consent").notNull().default(0),
  suppressed: integer("suppressed").notNull().default(0),
  createdAt: integer("created_at").notNull(),
}, (table) => [uniqueIndex("contacts_owner_phone").on(table.owner, table.phone)]);

export const campaigns = sqliteTable("campaigns", {
  id: text("id").primaryKey(), owner: text("owner").notNull(),
  name: text("name").notNull(), message: text("message").notNull(),
  senderId: text("sender_id").notNull(), channel: text("channel").notNull(),
  mode: text("mode").notNull(), status: text("status").notNull(),
  audienceSource: text("audience_source").notNull().default("contacts"),
  directConsentAt: integer("direct_consent_at"),
  whatsappPayload: text("whatsapp_payload"),
  whatsappConsentAt: integer("whatsapp_consent_at"),
  smsProviderId: text("sms_provider_id").notNull().default("termii"),
  smsCredentialRevision: integer("sms_credential_revision"),
  recipientCount: integer("recipient_count").notNull(),
  segments: integer("segments").notNull(), encoding: text("encoding").notNull(),
  estimatedCost: real("estimated_cost"),
  createdAt: integer("created_at").notNull(), updatedAt: integer("updated_at").notNull(),
}, (table) => [index("campaigns_owner_date").on(table.owner, table.createdAt)]);

export const batches = sqliteTable("batches", {
  id: text("id").primaryKey(),
  campaignId: text("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  batchIndex: integer("batch_index").notNull(),
  status: text("status").notNull(), providerId: text("provider_id"), error: text("error"),
  createdAt: integer("created_at").notNull(), updatedAt: integer("updated_at").notNull(),
}, (table) => [index("batches_campaign").on(table.campaignId, table.batchIndex)]);

export const recipients = sqliteTable("recipients", {
  id: text("id").primaryKey(),
  campaignId: text("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  batchId: text("batch_id").notNull().references(() => batches.id, { onDelete: "cascade" }),
  // Direct recipients that have no saved contact use an empty ID. Their
  // campaign's audience_source and consent timestamp identify that path.
  contactId: text("contact_id").notNull(),
  name: text("name").notNull(), phone: text("phone").notNull(),
  status: text("status").notNull(), providerId: text("provider_id"), reason: text("reason"),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [index("recipients_campaign_status").on(table.campaignId, table.status), index("recipients_batch_status").on(table.batchId, table.status), uniqueIndex("recipients_campaign_phone").on(table.campaignId, table.phone)]);

export const emailSettings = sqliteTable("email_settings", {
  owner: text("owner").primaryKey(), apiKeyCiphertext: text("api_key_ciphertext"),
  revision: integer("revision").notNull().default(1), credentialRevision: integer("credential_revision").notNull().default(1),
  verifiedAt: integer("verified_at"), dailyCredits: integer("daily_credits"), instantCredits: integer("instant_credits"), balanceCheckedAt: integer("balance_checked_at"),
  updatedAt: integer("updated_at").notNull(),
});

export const emailJobs = sqliteTable("email_jobs", {
  id: text("id").primaryKey(), owner: text("owner").notNull(), name: text("name").notNull(), sourceName: text("source_name").notNull().default(""),
  status: text("status").notNull().default("uploading"), totalRows: integer("total_rows").notNull().default(0), nextChunkIndex: integer("next_chunk_index").notNull().default(0),
  pendingCount: integer("pending_count").notNull().default(0), processingCount: integer("processing_count").notNull().default(0), validCount: integer("valid_count").notNull().default(0), invalidCount: integer("invalid_count").notNull().default(0), riskyCount: integer("risky_count").notNull().default(0), unknownCount: integer("unknown_count").notNull().default(0), duplicateCount: integer("duplicate_count").notNull().default(0), eligibleCount: integer("eligible_count").notNull().default(0), invalidSyntaxCount: integer("invalid_syntax_count").notNull().default(0), pendingTargets: integer("pending_targets").notNull().default(0),
  sealedAt: integer("sealed_at"), startedAt: integer("started_at"), completedAt: integer("completed_at"), credentialRevision: integer("credential_revision"), credentialCiphertext: text("credential_ciphertext"),
  nextRunAt: integer("next_run_at"), leaseToken: text("lease_token"), leaseUntil: integer("lease_until"), error: text("error"),
  createdAt: integer("created_at").notNull(), updatedAt: integer("updated_at").notNull(),
}, table => [index("email_jobs_owner_created").on(table.owner, table.createdAt, table.id), index("email_jobs_queue").on(table.status, table.nextRunAt, table.leaseUntil)]);

export const emailChunks = sqliteTable("email_chunks", {
  jobId: text("job_id").notNull().references(() => emailJobs.id, { onDelete: "cascade" }), index: integer("chunk_index").notNull(), digest: text("digest").notNull(), rowCount: integer("row_count").notNull(), createdAt: integer("created_at").notNull(),
}, table => [uniqueIndex("email_chunks_job_index").on(table.jobId, table.index)]);

export const emailRows = sqliteTable("email_rows", {
  jobId: text("job_id").notNull().references(() => emailJobs.id, { onDelete: "cascade" }), position: integer("position").notNull(), sourceRow: text("source_row"), email: text("email").notNull(), normalizedEmail: text("normalized_email"), localStatus: text("local_status"), localReason: text("local_reason"),
}, table => [uniqueIndex("email_rows_job_position").on(table.jobId, table.position), index("email_rows_job_address").on(table.jobId, table.normalizedEmail)]);

export const emailTargets = sqliteTable("email_targets", {
  jobId: text("job_id").notNull().references(() => emailJobs.id, { onDelete: "cascade" }), email: text("email").notNull(), firstPosition: integer("first_position").notNull(), status: text("status").notNull().default("pending"), reason: text("reason").notNull().default(""), providerStatus: text("provider_status"), batchId: text("batch_id"), updatedAt: integer("updated_at").notNull(),
  occurrenceCount: integer("occurrence_count").notNull().default(1),
}, table => [uniqueIndex("email_targets_job_address").on(table.jobId, table.email), index("email_targets_job_pending").on(table.jobId, table.status, table.firstPosition), index("email_targets_batch").on(table.batchId)]);

export const emailBatches = sqliteTable("email_batches", {
  id: text("id").primaryKey(), jobId: text("job_id").notNull().references(() => emailJobs.id, { onDelete: "cascade" }), index: integer("batch_index").notNull(), mode: text("mode").notNull(), status: text("status").notNull(), taskId: text("task_id"), count: integer("count").notNull(), attempts: integer("attempts").notNull().default(0), nextPollAt: integer("next_poll_at"), error: text("error"), createdAt: integer("created_at").notNull(), updatedAt: integer("updated_at").notNull(),
}, table => [uniqueIndex("email_batches_job_index").on(table.jobId, table.index), index("email_batches_job_status").on(table.jobId, table.status)]);

export const emailWorkerState = sqliteTable("email_worker_state", {
  key: text("key").primaryKey(), lastRunAt: integer("last_run_at"), lastError: text("last_error"),
});

export const marketingSettings = sqliteTable("marketing_settings", {
  owner: text("owner").primaryKey(), relayUrl: text("relay_url").notNull().default(""), relayTokenCiphertext: text("relay_token_ciphertext"),
  revision: integer("revision").notNull().default(1), credentialRevision: integer("credential_revision").notNull().default(1), relayVerifiedAt: integer("relay_verified_at"), postalAddress: text("postal_address").notNull().default(""), updatedAt: integer("updated_at").notNull(),
});
export const smtpAccounts = sqliteTable("smtp_accounts", {
  id: text("id").primaryKey(), owner: text("owner").notNull(), label: text("label").notNull(), host: text("host").notNull(), port: integer("port").notNull(), security: text("security").notNull(), username: text("username").notNull(), passwordCiphertext: text("password_ciphertext").notNull(),
  fromEmail: text("from_email").notNull(), fromName: text("from_name").notNull().default(""), replyTo: text("reply_to").notNull().default(""), enabled: integer("enabled").notNull().default(0), verifiedAt: integer("verified_at"), revision: integer("revision").notNull().default(1), credentialRevision: integer("credential_revision").notNull().default(1),
  dailyLimit: integer("daily_limit").notNull().default(500), minIntervalSeconds: integer("min_interval_seconds").notNull().default(5), sentToday: integer("sent_today").notNull().default(0), sentDay: text("sent_day").notNull().default(""), nextAvailableAt: integer("next_available_at"), reservationToken: text("reservation_token"), sendLeaseUntil: integer("send_lease_until"), lastError: text("last_error"), deletedAt: integer("deleted_at"), createdAt: integer("created_at").notNull(), updatedAt: integer("updated_at").notNull(),
}, table => [index("smtp_accounts_owner_created").on(table.owner, table.createdAt, table.id)]);
export const marketingGroups = sqliteTable("marketing_groups", {
  id: text("id").primaryKey(), owner: text("owner").notNull(), name: text("name").notNull(), createdAt: integer("created_at").notNull(), updatedAt: integer("updated_at").notNull(),
}, table => [index("marketing_groups_owner_created").on(table.owner, table.createdAt, table.id), uniqueIndex("marketing_groups_owner_name").on(table.owner, table.name)]);
export const marketingContacts = sqliteTable("marketing_contacts", {
  id: text("id").primaryKey(), owner: text("owner").notNull(), email: text("email").notNull(), name: text("name").notNull().default(""), verifiedAt: integer("verified_at").notNull(), sourceJobId: text("source_job_id").notNull(), suppressed: integer("suppressed").notNull().default(0), createdAt: integer("created_at").notNull(), updatedAt: integer("updated_at").notNull(),
}, table => [uniqueIndex("marketing_contacts_owner_email").on(table.owner, table.email)]);
export const marketingGroupMembers = sqliteTable("marketing_group_members", {
  groupId: text("group_id").notNull().references(() => marketingGroups.id, { onDelete: "cascade" }), contactId: text("contact_id").notNull().references(() => marketingContacts.id, { onDelete: "cascade" }), createdAt: integer("created_at").notNull(),
}, table => [primaryKey({ columns: [table.groupId, table.contactId] })]);
export const marketingCampaigns = sqliteTable("marketing_campaigns", {
  id: text("id").primaryKey(), owner: text("owner").notNull(), name: text("name").notNull(), subject: text("subject").notNull(), preheader: text("preheader").notNull().default(""), html: text("html").notNull(), textContent: text("text_content").notNull().default(""), status: text("status").notNull().default("draft"), revision: integer("revision").notNull().default(1), recipientCount: integer("recipient_count").notNull().default(0),
  groupIds: text("group_ids").notNull().default("[]"), accountIds: text("account_ids").notNull().default("[]"), accountSnapshot: text("account_snapshot").notNull().default("[]"), relayRevision: integer("relay_revision"), postalAddress: text("postal_address").notNull().default(""), intervalSeconds: integer("interval_seconds").notNull().default(5), scheduledAt: integer("scheduled_at"), nextSendAt: integer("next_send_at"), rotationIndex: integer("rotation_index").notNull().default(0), launchToken: text("launch_token"), leaseToken: text("lease_token"), leaseUntil: integer("lease_until"), startedAt: integer("started_at"), completedAt: integer("completed_at"), lastError: text("last_error"), createdAt: integer("created_at").notNull(), updatedAt: integer("updated_at").notNull(),
}, table => [index("marketing_campaigns_owner_created").on(table.owner, table.createdAt, table.id), index("marketing_campaigns_queue").on(table.status, table.nextSendAt, table.leaseUntil)]);
export const marketingRecipients = sqliteTable("marketing_recipients", {
  id: text("id").primaryKey(), campaignId: text("campaign_id").notNull().references(() => marketingCampaigns.id, { onDelete: "cascade" }), contactId: text("contact_id").notNull().references(() => marketingContacts.id), email: text("email").notNull(), name: text("name").notNull().default(""), status: text("status").notNull().default("pending"), accountId: text("account_id"), accountRevision: integer("account_revision"), messageId: text("message_id"), error: text("error"), attemptedAt: integer("attempted_at"), updatedAt: integer("updated_at").notNull(),
}, table => [uniqueIndex("marketing_recipients_campaign_email").on(table.campaignId, table.email), index("marketing_recipients_campaign_status").on(table.campaignId, table.status, table.id)]);
export const marketingTests = sqliteTable("marketing_tests", {
  id: text("id").primaryKey(), owner: text("owner").notNull(), requestId: text("request_id").notNull(), requestDigest: text("request_digest").notNull(), email: text("email").notNull(), accountId: text("account_id").notNull(), status: text("status").notNull(), messageId: text("message_id"), error: text("error"), updatedAt: integer("updated_at").notNull(),
}, table => [uniqueIndex("marketing_tests_owner_request").on(table.owner, table.requestId)]);
export const marketingWorkerState = sqliteTable("marketing_worker_state", {
  key: text("key").primaryKey(), lastRunAt: integer("last_run_at"), lastError: text("last_error"),
});
