#!/usr/bin/env node
import { createHash } from "node:crypto";

try {
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdout.write("Ready for service-token JSON on stdin (input is hidden).\n");
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk.toString();
    if (raw.length > 32_768) throw new Error();
    if (raw.includes("\n")) break;
  }
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
  const { serviceToken } = JSON.parse(raw);
  if (typeof serviceToken !== "string" || serviceToken.length < 16 || serviceToken.length > 16_384 || /[\r\n]/.test(serviceToken)) throw new Error();
  process.stdout.write(JSON.stringify({ sha256: createHash("sha256").update(serviceToken, "utf8").digest("hex") }) + "\n");
} catch {
  process.stderr.write("Provide a JSON object containing a valid serviceToken through stdin.\n");
  process.exitCode = 1;
}
