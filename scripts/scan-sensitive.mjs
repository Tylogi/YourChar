import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const listed = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: root, encoding: "utf8" },
).split("\0").filter(Boolean);
const textExtensions = new Set([
  "", ".cjs", ".css", ".html", ".js", ".json", ".md", ".mjs", ".npmrc",
  ".sh", ".ts", ".txt", ".yaml", ".yml",
]);
const patterns = [
  ["private key", /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g],
  ["OpenAI-style key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g],
  ["Tavily key", /\btvly-[A-Za-z0-9_-]{24,}\b/g],
  ["GitHub token", /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/g],
  ["Google API key", /\bAIza[A-Za-z0-9_-]{30,}\b/g],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g],
  ["hard-coded bearer token", /\bBearer\s+[A-Za-z0-9._-]{32,}\b/g],
];
const findings = [];
let scanned = 0;
for (const relative of listed) {
  const path = join(root, relative);
  if (!existsSync(path) || !statSync(path).isFile() || !textExtensions.has(extname(path))) continue;
  const content = readFileSync(path, "utf8");
  if (content.includes("\0")) continue;
  scanned += 1;
  for (const [label, pattern] of patterns) {
    pattern.lastIndex = 0;
    for (const match of content.matchAll(pattern)) {
      findings.push(`${relative}:${lineNumber(content, match.index ?? 0)} ${label}`);
    }
  }
}

const artifactDir = join(root, "eval-artifacts");
if (existsSync(artifactDir)) {
  for (const name of readdirSync(artifactDir).filter((entry) => entry.endsWith(".json"))) {
    const content = readFileSync(join(artifactDir, name), "utf8");
    if (/"(?:apiKey|baseUrl)"\s*:/.test(content)) {
      findings.push(`eval-artifacts/${name}: report contains a forbidden credential or endpoint field`);
    }
  }
}

if (findings.length) {
  console.error(`Sensitive information scan failed (${findings.length} finding(s)):`);
  for (const finding of findings) console.error(`- ${finding}`);
  process.exitCode = 1;
} else {
  console.log(`Sensitive information scan passed (${scanned} source files checked).`);
}

function lineNumber(content, index) {
  return content.slice(0, index).split("\n").length;
}
