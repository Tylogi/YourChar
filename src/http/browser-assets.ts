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
const emojiCssEntry = require.resolve("@fontsource/noto-emoji/400.css");
const emojiPackageDirectory = dirname(emojiCssEntry);

const assetPaths: Array<[pathname: string, path: string, contentType: string]> = [
  ["/assets/marked.umd.js", join(dirname(markedEntry), "marked.umd.js"), "text/javascript; charset=utf-8"],
  ["/assets/purify.min.js", join(dirname(domPurifyEntry), "purify.min.js"), "text/javascript; charset=utf-8"],
  ["/assets/lucide.min.js", resolve(dirname(lucideEntry), "../umd/lucide.min.js"), "text/javascript; charset=utf-8"],
  ["/assets/noto-emoji/400.css", emojiCssEntry, "text/css; charset=utf-8"],
  ...Array.from({ length: 10 }, (_, index): [string, string, string] => [
    `/assets/noto-emoji/files/noto-emoji-${index}-400-normal.woff2`,
    join(emojiPackageDirectory, "files", `noto-emoji-${index}-400-normal.woff2`),
    "font/woff2",
  ]),
];

const assets = new Map<string, BrowserAsset>(
  assetPaths.map(([pathname, path, contentType]) => [
    pathname,
    { body: readFileSync(path), contentType },
  ]),
);

export function browserAsset(pathname: string): BrowserAsset | undefined {
  return assets.get(pathname);
}
