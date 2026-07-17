import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const includeRealModel = process.argv.includes("--real");
const steps = [
  ["Build", "npm", ["run", "build"]],
  ["Backup contract syntax", "node", ["--check", "scripts/backup-contract.mjs"]],
  ["Restore contract syntax", "node", ["--check", "scripts/restore-state.mjs"]],
  ["Unit and integration tests", "npm", ["test"]],
  ["Browser visual tests", "npm", ["run", "test:browser"]],
  ["Sensitive information scan", "npm", ["run", "scan:sensitive"]],
  ["Diff whitespace check", "git", ["diff", "--check"]],
];
if (includeRealModel) {
  steps.push([
    "Real-model pre-release evaluation (3 runs)",
    "npm",
    ["run", "eval:real-model", "--", "--runs", "3"],
  ]);
}

for (const [label, command, args] of steps) {
  console.log(`\n==> ${label}`);
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    console.error(`Release gate stopped at: ${label}`);
    process.exit(result.status ?? 1);
  }
}

console.log(`\nRelease gate passed${includeRealModel ? " with real-model evaluation" : ""}.`);
