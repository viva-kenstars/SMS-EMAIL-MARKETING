import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

test("background runner follows the configured proxy without logging service credentials or replaying a request", async () => {
  let connections = 0;
  const proxy = createServer();
  proxy.on("connect", (request, socket) => {
    connections++;
    assert.equal(request.url, "private-mail-worker.example:443");
    socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const token = "synthetic-runner-service-token-never-sent";
  const address = `http://127.0.0.1:${proxy.address().port}`;
  const env = { ...process.env, HTTP_PROXY: address, HTTPS_PROXY: address, http_proxy: address, https_proxy: address, NO_PROXY: "", no_proxy: "" };
  delete env.NODE_USE_ENV_PROXY;
  const child = spawn(process.execPath, [fileURLToPath(new URL("../scripts/run-email-queue.mjs", import.meta.url))], { env, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", data => { output += data; });
  child.stderr.on("data", data => { output += data; });
  child.stdin.end(JSON.stringify({ siteUrl: "https://private-mail-worker.example/", serviceToken: token }) + "\n");
  const timeout = setTimeout(() => child.kill(), 10_000);
  try {
    const [code] = await once(child, "exit");
    assert.equal(code, 1);
    assert.equal(connections, 1);
    assert.match(output, /Email background processing could not finish/);
    assert.ok(!output.includes(token));
    assert.ok(!output.includes("OAI-Sites-Authorization"));
  } finally {
    clearTimeout(timeout);
    proxy.closeAllConnections();
    await new Promise(resolve => proxy.close(resolve));
  }
});
