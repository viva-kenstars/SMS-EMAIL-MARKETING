#!/usr/bin/env node
/**
 * Bounded scheduler client. JSON arrives on hidden stdin; credentials never
 * appear in argv, source files, error output or logs. Obtain service access
 * through Sites get_site immediately before a run.
 */
import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Node's fetch does not use HTTP(S)_PROXY unless explicitly enabled. Keep the
// configured network path when this runner is launched by a cloud scheduler.
// Re-exec before reading stdin so service credentials never reach argv or disk.
const hasProxy = !!(process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy);
if (hasProxy && process.env.NODE_USE_ENV_PROXY !== "1" && !process.execArgv.includes("--use-env-proxy")) {
  if (!process.allowedNodeEnvironmentFlags.has("--use-env-proxy")) {
    process.stderr.write("Provide Node.js 24.5 or newer for a configured HTTP proxy.\n");
    process.exit(1);
  }
  const child = spawn(process.execPath, ["--use-env-proxy", fileURLToPath(import.meta.url)], { stdio: "inherit" });
  child.on("error", () => { process.stderr.write("Email background processing could not start.\n"); process.exit(1); });
  child.on("exit", (code) => process.exit(code ?? 1));
  await new Promise(() => {});
}

async function input() {
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdout.write("Ready for email worker JSON on stdin (input is hidden).\n");
  let raw = "";
  for await (const chunk of process.stdin) {
    const text = chunk.toString();
    if (text.includes("\u0003")) throw new Error("Cancelled.");
    raw += text;
    if (raw.length > 32_768) throw new Error("Worker input is too large.");
    if (raw.includes("\n")) break;
  }
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
  try { return JSON.parse(raw); } catch { throw new Error("Provide one JSON object on stdin."); }
}

try {
  const config = await input();
  const origin = new URL(config.siteUrl);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") throw new Error("Use the HTTPS Site origin without a path.");
  if (typeof config.serviceToken !== "string" || config.serviceToken.length < 16 || config.serviceToken.length > 16_384 || /[\r\n]/.test(config.serviceToken)) throw new Error("Provide current Site service access.");
  const started = Date.now();
  let requests = 0, advanced = 0, nextDueAt = null;
  while (requests < 6 && Date.now() - started < 150_000) {
    const response = await fetch(new URL("/api/email/worker", origin), {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(120_000),
      headers: { "Content-Type": "application/json", "OAI-Sites-Authorization": `Bearer ${config.serviceToken}`, "X-Email-Worker-Token": config.serviceToken },
      body: "{}",
    });
    if (!response.ok || !response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
      await response.body?.cancel();
      throw new Error(`Email worker returned HTTP ${response.status}. No task submission was retried.`);
    }
    const result = await response.json();
    if (result.ok !== true || !Number.isSafeInteger(result.advanced) || result.advanced < 0) throw new Error("Email worker returned an unrecognized acknowledgement.");
    requests++; advanced += result.advanced;
    nextDueAt = typeof result.nextDueAt === "number" && Number.isFinite(result.nextDueAt) ? result.nextDueAt : null;
    if (result.advanced === 0 || nextDueAt === null) break;
    const wait = Math.max(100, nextDueAt - Date.now());
    if (wait > 15_000 || Date.now() - started + wait >= 150_000) break;
    await delay(wait);
  }
  process.stdout.write(JSON.stringify({ ok: true, requests, advanced, nextDueAt }) + "\n");
} catch (error) {
  // Never print a raw networking exception: it may include URLs or headers.
  const message = error instanceof Error && /^(Use the HTTPS|Provide |Worker input|Cancelled|Email worker returned)/.test(error.message)
    ? error.message : "Email background processing could not finish this run. Saved progress can be checked in the app.";
  process.stderr.write(message + "\n");
  process.exitCode = 1;
}
