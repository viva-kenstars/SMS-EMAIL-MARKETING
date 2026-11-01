import { validWhatsAppId, whatsappTemplateKeys } from "./whatsapp";

type Row = Record<string, any>;
type ProviderState = { configured: boolean; verifiedAt: number | null; revision: number; credentialRevision: number };
export type WhatsAppPayload = {
  deviceId: string; businessName: string; templateId: string; templateBody: string;
  category: "marketing" | "utility"; data: Record<string, string>;
};

export class WhatsAppSettingsError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status = 400, code?: string) { super(message); this.status = status; this.code = code; }
}

const conflict = () => new WhatsAppSettingsError("WhatsApp settings changed in another session. Refresh, review the latest values and save again.", 409, "whatsapp_revision_conflict");

function publicState(row: Row | null, provider: ProviderState) {
  const deviceId = row?.device_id || "";
  const businessName = row?.business_name || "";
  const templateId = row?.template_id || "";
  const templateBody = row?.template_body || "";
  const category = row?.category === "utility" ? "utility" as const : "marketing" as const;
  let templateKeys: string[] = [], bodyValid = false;
  try { templateKeys = whatsappTemplateKeys(templateBody); bodyValid = true; } catch { /* An incomplete setup is safe to display. */ }
  const configured = validWhatsAppId(deviceId) && validWhatsAppId(templateId) && !!businessName && bodyValid;
  const accountApproved = !!row?.account_approved, templateApproved = !!row?.template_approved;
  const providerRevision = row?.provider_revision ?? 0;
  const providerReady = provider.configured && !!provider.verifiedAt;
  const liveEnabled = configured && providerReady && accountApproved && templateApproved && !!row?.live_enabled && providerRevision === provider.credentialRevision;
  const readiness: string[] = [];
  if (!providerReady) readiness.push("Save and test the shared Termii API connection.");
  if (!validWhatsAppId(deviceId)) readiness.push("Copy the WhatsApp device ID from Termii.");
  if (!businessName) readiness.push("Enter the approved business display name.");
  if (!validWhatsAppId(templateId) || !bodyValid) readiness.push("Copy the approved text-template ID and its reference text from Termii.");
  if (!accountApproved) readiness.push("Confirm that Termii has activated this WhatsApp business account and device.");
  if (!templateApproved) readiness.push("Confirm that this exact template is approved in Termii.");
  if (row?.live_enabled && providerRevision !== provider.credentialRevision) readiness.push("The shared API key or base URL changed. Review the connection and enable WhatsApp again.");
  if (!liveEnabled) readiness.push("Enable WhatsApp live sending after completing setup.");
  return { deviceId, businessName, templateId, templateBody, category, accountApproved, templateApproved, liveEnabled,
    ratePerMessage: row?.rate_per_message ?? null, revision: row?.revision ?? 0,
    configured, readiness, providerRevision, templateKeys };
}

export async function getWhatsAppSettings(db: D1Database, owner: string, provider: ProviderState) {
  const row = await db.prepare("SELECT * FROM whatsapp_settings WHERE owner = ?").bind(owner).first<Row>();
  return publicState(row, provider);
}

export async function saveWhatsAppSettings(db: D1Database, owner: string, body: Row, provider: ProviderState) {
  const row = await db.prepare("SELECT * FROM whatsapp_settings WHERE owner = ?").bind(owner).first<Row>();
  const previous = publicState(row, provider);
  if (!Number.isSafeInteger(body.revision) || body.revision !== previous.revision) throw conflict();
  for (const key of ["deviceId", "businessName", "templateId", "templateBody", "category"]) {
    if (body[key] !== undefined && typeof body[key] !== "string") throw new WhatsAppSettingsError("Enter valid WhatsApp account and template settings.");
  }
  for (const key of ["accountApproved", "templateApproved", "liveEnabled"]) {
    if (body[key] !== undefined && typeof body[key] !== "boolean") throw new WhatsAppSettingsError("Choose the WhatsApp approval and live sending options.");
  }
  const deviceId = body.deviceId === undefined ? previous.deviceId : body.deviceId.trim();
  const templateId = body.templateId === undefined ? previous.templateId : body.templateId.trim();
  const businessName = body.businessName === undefined ? previous.businessName : body.businessName.trim();
  const templateBody = body.templateBody === undefined ? previous.templateBody : body.templateBody;
  const category = body.category ?? previous.category;
  if ((deviceId && !validWhatsAppId(deviceId)) || (templateId && !validWhatsAppId(templateId))) throw new WhatsAppSettingsError("Use the device and template IDs copied from Termii, with up to 128 letters, digits, dots, underscores or hyphens.");
  if (businessName.length > 120 || /[\x00-\x1F\x7F]/.test(businessName)) throw new WhatsAppSettingsError("Enter a business display name of up to 120 characters without line breaks.");
  if (templateBody) {
    try { whatsappTemplateKeys(templateBody); }
    catch (error) { throw new WhatsAppSettingsError(error instanceof Error ? error.message : "Check the template reference text."); }
  }
  if (category !== "marketing" && category !== "utility") throw new WhatsAppSettingsError("Choose the approved marketing or utility template category.");
  const rate = body.ratePerMessage === "" || body.ratePerMessage === null ? null : body.ratePerMessage ?? previous.ratePerMessage;
  if (rate !== null && (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0 || rate > 100000)) throw new WhatsAppSettingsError("Enter a valid naira rate per WhatsApp template message, or leave it blank.");
  const accountChanged = deviceId !== previous.deviceId || businessName !== previous.businessName;
  const templateChanged = accountChanged || templateId !== previous.templateId || templateBody !== previous.templateBody || category !== previous.category;
  const accountApproved = body.accountApproved ?? (!accountChanged && previous.accountApproved);
  const templateApproved = body.templateApproved ?? (!templateChanged && previous.templateApproved);
  let liveEnabled = templateChanged ? false : body.liveEnabled ?? previous.liveEnabled;
  // A config save cannot also activate changed IDs/text. Review the saved setup first.
  if (!accountApproved || !templateApproved) liveEnabled = false;
  if (!templateChanged && body.liveEnabled === true) {
    if (!provider.configured || !provider.verifiedAt) throw new WhatsAppSettingsError("Save and successfully test the shared Termii API connection before enabling WhatsApp.", 409);
    if (!deviceId || !businessName || !templateId || !templateBody || !accountApproved || !templateApproved) throw new WhatsAppSettingsError("Complete the WhatsApp account and exact-template approval confirmations before enabling live sending.", 409);
    liveEnabled = true;
  }
  const now = Date.now(), revision = previous.revision + 1;
  const providerRevision = liveEnabled ? provider.credentialRevision : previous.providerRevision;
  const values = [deviceId, businessName, templateId, templateBody, category, Number(accountApproved), Number(templateApproved), Number(liveEnabled), rate, revision, providerRevision, now];
  const result = row
    ? await db.prepare("UPDATE whatsapp_settings SET device_id = ?, business_name = ?, template_id = ?, template_body = ?, category = ?, account_approved = ?, template_approved = ?, live_enabled = ?, rate_per_message = ?, revision = ?, provider_revision = ?, updated_at = ? WHERE owner = ? AND revision = ?").bind(...values, owner, previous.revision).run()
    : await db.prepare("INSERT INTO whatsapp_settings (device_id,business_name,template_id,template_body,category,account_approved,template_approved,live_enabled,rate_per_message,revision,provider_revision,updated_at,owner,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner) DO NOTHING").bind(...values, owner, now).run();
  if (result.meta.changes !== 1) throw conflict();
  return { whatsapp: await getWhatsAppSettings(db, owner, provider) };
}
