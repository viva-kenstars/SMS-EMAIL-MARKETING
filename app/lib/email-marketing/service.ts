import { isEncryptionKeyReady } from "../secret-store";
import { validEmailWorkerToken } from "../email/runner";
import { accountDto, accountRow, deleteAccount, listAccounts, saveAccount, saveSettings, settingsDto, settingsRow, testAccount, testSettings, toggleAccount } from "./accounts";
import { campaignAction, campaignRow, detail, duplicateCampaign, launchCampaign, listCampaigns, recipientPage, saveCampaign, testCampaign } from "./campaigns";
import { bodyOf, json, MarketingError, type Context, type Row } from "./common";
import { createGroup, importVerified, listContacts, listGroups, suppressContact } from "./contacts";
import { advanceMarketingQueue } from "./queue";
import type { MarketingRunner, MarketingState } from "./types";

export { advanceMarketingQueue } from "./queue";
export type { Context as MarketingContext } from "./common";
type WorkerContext = { db: D1Database; masterKey?: string; workerTokenHash?: string; fetch?: typeof globalThis.fetch; appOrigin?: string };

export async function marketingRunnerStatus(context: WorkerContext): Promise<MarketingRunner> {
  const configured = !!context.workerTokenHash && /^[a-f0-9]{64}$/.test(context.workerTokenHash) && isEncryptionKeyReady(context.masterKey);
  const state = await context.db.prepare("SELECT last_run_at,last_error FROM marketing_worker_state WHERE key='queue'").first<Row>();
  const lastHeartbeatAt = state?.last_run_at || null;
  const healthy = configured && !!lastHeartbeatAt && lastHeartbeatAt <= Date.now() && Date.now() - lastHeartbeatAt < 120_000 && !state?.last_error;
  return { configured, healthy, lastHeartbeatAt, message: healthy ? "The background sender is connected. Launched campaigns can continue while this page is closed." : "The background sender has not checked in recently. Start the SMTP service scheduler for unattended sending; this page can advance launched campaigns while open." };
}
async function state(context: Context): Promise<MarketingState> {
  const [settings, accounts, groups, campaigns, jobs, runner] = await Promise.all([
    settingsRow(context), listAccounts(context), listGroups(context), listCampaigns(context),
    context.db.prepare("SELECT id,name,status,valid_count,total_rows,updated_at FROM email_jobs WHERE owner=? AND status='completed' AND valid_count>0 ORDER BY updated_at DESC,id DESC LIMIT 100").bind(context.owner).all<Row>(),
    marketingRunnerStatus(context),
  ]);
  return { settings: settingsDto(settings, context.masterKey), accounts: accounts.accounts, groups: groups.groups, campaigns: campaigns.campaigns,
    accountsCursor: accounts.nextCursor, groupsCursor: groups.nextCursor, campaignsCursor: campaigns.nextCursor,
    verifierJobs: jobs.results.map(job => ({ id: job.id, name: job.name, status: job.status, validCount: job.valid_count, totalRows: job.total_rows, updatedAt: job.updated_at })), runner };
}
export async function handleMarketingApi(request: Request, context: Context): Promise<Response | null> {
  const url = new URL(request.url), parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (parts[0] !== "api" || parts[1] !== "marketing") return null;
  try {
    if (!context.owner || typeof context.owner !== "string") throw new MarketingError("Sign in to your private workspace.", 401);
    const route = parts.slice(2), method = request.method, joined = route.join("/");
    const body = method === "GET" ? {} : await bodyOf(request, context.appOrigin);
    if (joined === "state" && method === "GET") return json(await state(context));
    if (joined === "settings" && method === "GET") return json({ settings: settingsDto(await settingsRow(context), context.masterKey) });
    if (joined === "settings" && method === "POST") return json(await saveSettings(context, body));
    if (joined === "settings/test" && method === "POST") return json(await testSettings(context));
    if (joined === "accounts") {
      if (method === "GET") return json(await listAccounts(context, url.searchParams.get("cursor")));
      if (method === "POST") return json(await saveAccount(context, body), body.id ? 200 : 201);
    }
    if (route[0] === "accounts" && route[1]) {
      if (route.length === 2 && method === "GET") return json({ account: accountDto(await accountRow(context, route[1]), context.masterKey) });
      if (route.length === 2 && method === "DELETE") return json(await deleteAccount(context, route[1], body));
      if (route.length === 3 && route[2] === "test" && method === "POST") return json(await testAccount(context, route[1]));
      if (route.length === 3 && route[2] === "toggle" && method === "POST") return json(await toggleAccount(context, route[1], body));
    }
    if (joined === "groups") {
      if (method === "GET") return json(await listGroups(context, url.searchParams.get("cursor")));
      if (method === "POST") return json(await createGroup(context, body), 201);
    }
    if (route[0] === "groups" && route[1]) {
      if (route.length === 3 && route[2] === "contacts" && method === "GET") return json(await listContacts(context, route[1], url.searchParams.get("cursor")));
      if (route.length === 3 && route[2] === "import-verified" && method === "POST") return json(await importVerified(context, route[1], body));
    }
    if (route[0] === "contacts" && route[1] && route[2] === "suppress" && route.length === 3 && method === "POST") return json(await suppressContact(context, route[1]));
    if (joined === "campaigns") {
      if (method === "GET") return json(await listCampaigns(context, url.searchParams.get("cursor")));
      if (method === "POST") return json(await saveCampaign(context, body), body.id ? 200 : 201);
    }
    if (route[0] === "campaigns" && route[1]) {
      const id = route[1];
      if (route.length === 2 && method === "GET") return json({ campaign: await detail(context, id), ...await recipientPage(context, id, url.searchParams.get("cursor")) });
      if (route.length === 3 && route[2] === "recipients" && method === "GET") return json(await recipientPage(context, id, url.searchParams.get("cursor")));
      if (route.length === 3 && method === "POST") {
        if (route[2] === "launch") return json(await launchCampaign(context, id, body));
        if (route[2] === "test") return json(await testCampaign(context, id, body));
        if (route[2] === "duplicate") return json(await duplicateCampaign(context, id), 201);
        if (["pause", "resume", "cancel"].includes(route[2])) return json(await campaignAction(context, id, route[2], body));
        if (route[2] === "advance") {
          await campaignRow(context, id);
          await advanceMarketingQueue(context.db, context.masterKey, { owner: context.owner, campaignId: id, fetch: context.fetch });
          return json({ campaign: await detail(context, id) });
        }
      }
    }
    if (joined === "advance" && method === "POST") return json({ ok: true, ...await advanceMarketingQueue(context.db, context.masterKey, { owner: context.owner, fetch: context.fetch }) });
    if (joined === "runner" && method === "GET") return json({ runner: await marketingRunnerStatus(context) });
    return json({ error: "This email marketing action is not available." }, 404);
  } catch (error) {
    if (error instanceof MarketingError) return json({ error: error.message, code: error.code }, error.status);
    return json({ error: "The email marketing operation could not finish. Reload the saved item before retrying. An uncertain message is never automatically resent." }, 500);
  }
}
/** Service access advances explicitly launched campaigns; it cannot create or launch them. */
export async function handleMarketingWorker(request: Request, context: WorkerContext): Promise<Response> {
  if (request.method !== "POST") return json({ error: "Use POST." }, 405);
  if (!await validEmailWorkerToken(request.headers.get("x-marketing-worker-token") || request.headers.get("x-email-worker-token"), context.workerTokenHash)) return json({ error: "Background sender access was not accepted." }, 401);
  try {
    const body = await bodyOf(request, context.appOrigin);
    if (Object.keys(body).length) throw new MarketingError("Use an empty JSON object.");
    const result = await advanceMarketingQueue(context.db, context.masterKey, { fetch: context.fetch });
    const checkedAt = Date.now();
    await context.db.prepare("INSERT INTO marketing_worker_state(key,last_run_at,last_error) VALUES('queue',?,NULL) ON CONFLICT(key) DO UPDATE SET last_run_at=excluded.last_run_at,last_error=NULL").bind(checkedAt).run();
    return json({ ok: true, ...result, checkedAt });
  } catch (error) {
    if (error instanceof MarketingError && error.status < 500) return json({ error: error.message }, error.status);
    try { await context.db.prepare("INSERT INTO marketing_worker_state(key,last_run_at,last_error) VALUES('queue',?,'The background sender could not complete its last step.') ON CONFLICT(key) DO UPDATE SET last_run_at=excluded.last_run_at,last_error=excluded.last_error").bind(Date.now()).run(); } catch { /* Database failure is not recoverable in its own heartbeat. */ }
    return json({ error: "The background sender could not finish this step. Saved progress has been retained." }, 503);
  }
}
