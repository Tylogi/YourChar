import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

export type BrowserAsset = {
  body: Buffer;
  contentType: string;
};

const require = createRequire(import.meta.url);
const markedEntry = require.resolve("marked");
const domPurifyEntry = require.resolve("dompurify");
const lucideEntry = require.resolve("lucide");

const assetPaths = new Map<string, string>([
  ["/assets/marked.umd.js", join(dirname(markedEntry), "marked.umd.js")],
  ["/assets/purify.min.js", join(dirname(domPurifyEntry), "purify.min.js")],
  ["/assets/lucide.min.js", resolve(dirname(lucideEntry), "../umd/lucide.min.js")],
]);

const assets = new Map<string, BrowserAsset>(
  [...assetPaths].map(([pathname, path]) => [
    pathname,
    { body: readFileSync(path), contentType: "text/javascript; charset=utf-8" },
  ]),
);

export function browserAsset(pathname: string): BrowserAsset | undefined {
  return assets.get(pathname);
}
