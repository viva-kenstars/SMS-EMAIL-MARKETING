/** Keep all existing channels intact; route every verifier request through provider pinning. */
import { env } from "cloudflare:workers";
import { handleApi as existingApi } from "./legacy-server";
import { handleEmailApi } from "./email/provider-service";
import { handleEmailWorker, emailRunnerStatus } from "./email/provider-runner";
const json = (data: unknown, status = 200) => Response.json(data, {
  status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
});
export async function handleApi(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/email/") && !url.pathname.startsWith("/api/email-v2/")) return existingApi(request);
  url.pathname = url.pathname.replace(/^\/api\/email-v2\//, "/api/email/");
  const routed = new Request(url, request);
  try {
    if (!env.DB) return json({ error: "The database is not configured." }, 503);
    const runner = { db: env.DB, masterKey: env.SMS_SETTINGS_ENCRYPTION_KEY, tokenHash: env.EMAIL_WORKER_TOKEN_SHA256 };
    // The existing protected worker authenticates its token and empty JSON payload.
    if (url.pathname === "/api/email/worker") return await handleEmailWorker(routed, runner);
    const owner = routed.headers.get("oai-authenticated-user-id");
    const email = routed.headers.get("oai-authenticated-user-email");
    if (!owner || !email) return json({ error: "Sign in to your private workspace." }, 401);
    if (url.pathname === "/api/email/runner" && routed.method === "GET") return json(await emailRunnerStatus(runner));
    return await handleEmailApi(routed, { db: env.DB, owner, masterKey: env.SMS_SETTINGS_ENCRYPTION_KEY, appOrigin: env.APP_ORIGIN })
      ?? json({ error: "Verification action not found." }, 404);
  } catch { return json({ error: "Verification setup needs attention. Saved progress is retained." }, 503); }
}
