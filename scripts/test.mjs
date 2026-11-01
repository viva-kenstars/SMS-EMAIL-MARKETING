import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const filter = process.argv[2] ?? "";
const files = readdirSync(path.join(root, "tests")).filter(name => /\.test\.(ts|mjs)$/.test(name) && name.includes(filter)).sort();
if (!files.length) throw new Error("No matching test files.");
let failures = 0, countedTests = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, [...(file.endsWith(".ts") ? ["--experimental-strip-types"] : []), path.join("tests", file)], {
    cwd: root, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  const match = output.match(/(?:ℹ|#) tests (\d+)/);
  const count = match ? Number(match[1]) : null;
  countedTests += count ?? 0;
  if (result.status !== 0 || result.error) {
    failures++;
    process.stderr.write(`FAIL ${file}\n${output}\n`);
    if (result.error) process.stderr.write(`${result.error.message}\n`);
  } else process.stdout.write(`PASS ${file}${count === null ? "" : ` (${count} checks)`}\n`);
}
process.stdout.write(`${files.length - failures}/${files.length} test files passed; ${countedTests} individual checks reported.\n`);
process.exitCode = failures ? 1 : 0;
