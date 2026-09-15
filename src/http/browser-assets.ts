import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CHARACTER_AVATAR_PATH } from "../app/default-character.js";

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
const twemojiApiEntry = require.resolve("@twemoji/api/dist/twemoji.min.js");
const twemojiSvgDirectory = dirname(require.resolve("twemoji-svg/1f600"));
const moduleDirectory = dirname(fileURLToPath(import.meta.url));

function projectAssetPath(...segments: string[]): string {
  const relativePath = join("assets", ...segments);
  const candidates = [
    resolve(process.cwd(), relativePath),
    resolve(moduleDirectory, "../../", relativePath),
    resolve(moduleDirectory, "../../../", relativePath),
  ];
  const match = candidates.find((candidate) => existsSync(candidate));
  if (!match) {
    throw new Error(`Missing browser asset: ${relativePath}`);
  }
  return match;
}

const assetPaths: Array<[pathname: string, path: string, contentType: string]> = [
  ["/assets/marked.umd.js", join(dirname(markedEntry), "marked.umd.js"), "text/javascript; charset=utf-8"],
  ["/assets/purify.min.js", join(dirname(domPurifyEntry), "purify.min.js"), "text/javascript; charset=utf-8"],
  ["/assets/lucide.min.js", resolve(dirname(lucideEntry), "../umd/lucide.min.js"), "text/javascript; charset=utf-8"],
  ["/assets/twemoji.min.js", twemojiApiEntry, "text/javascript; charset=utf-8"],
  ["/assets/noto-emoji/400.css", emojiCssEntry, "text/css; charset=utf-8"],
  ["/manifest.webmanifest", projectAssetPath("manifest.webmanifest"), "application/manifest+json; charset=utf-8"],
  ["/favicon.ico", projectAssetPath("icons", "favicon-32.png"), "image/png"],
  ["/assets/icons/favicon-32.png", projectAssetPath("icons", "favicon-32.png"), "image/png"],
  ["/assets/icons/apple-touch-icon-180.png", projectAssetPath("icons", "apple-touch-icon-180.png"), "image/png"],
  ["/assets/icons/app-icon-192.png", projectAssetPath("icons", "app-icon-192.png"), "image/png"],
  ["/assets/icons/app-icon-512.png", projectAssetPath("icons", "app-icon-512.png"), "image/png"],
  ["/assets/icons/app-icon-1024.png", projectAssetPath("icons", "app-icon-1024.png"), "image/png"],
  [DEFAULT_CHARACTER_AVATAR_PATH, projectAssetPath("default-characters", "kurisu-avatar.jpg"), "image/jpeg"],
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
  const fixedAsset = assets.get(pathname);
  if (fixedAsset) return fixedAsset;
  const twemojiMatch = /^\/assets\/twemoji\/svg\/([0-9a-f]+(?:-[0-9a-f]+)*)\.svg$/u.exec(pathname);
  if (!twemojiMatch) return undefined;
  const path = join(twemojiSvgDirectory, `${twemojiMatch[1]}.svg`);
  if (!existsSync(path)) return undefined;
  const asset = { body: readFileSync(path), contentType: "image/svg+xml; charset=utf-8" };
  assets.set(pathname, asset);
  return asset;
}
