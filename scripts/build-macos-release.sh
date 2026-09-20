#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

usage() {
  cat <<'EOF'
Build a self-contained YourChar release for Apple Silicon macOS.

Usage:
  npm run package:macos
  scripts/build-macos-release.sh

Environment:
  MACOS_OUTPUT_DIR       Artifact directory (default: ./release)
  MACOS_NODE_CACHE_DIR   Cache for the verified Node archive
  MACOS_RUN_FULL_TESTS=1 Run the full suite in addition to the native macOS gate
  MACOS_SKIP_TESTS=1     Build without tests (local iteration only, not for release)

The output is ad-hoc signed and not notarized. Run this command on arm64 macOS.
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi
if (($# != 0)); then
  usage >&2
  exit 2
fi

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "macOS packaging requires an Apple Silicon Mac." >&2
  exit 1
fi

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
if [[ -n "$(git -C "$repo_root" status --porcelain=v1)" ]]; then
  echo "Refusing to package a dirty working tree; commit or stash all changes first." >&2
  exit 1
fi

node_version="$(tr -d '[:space:]' < "$repo_root/.nvmrc")"
if [[ ! "$node_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Invalid Node version in .nvmrc: $node_version" >&2
  exit 1
fi
version="$(/usr/bin/plutil -extract version raw -o - "$repo_root/package.json")"
commit="$(git -C "$repo_root" rev-parse HEAD)"
build_number="$(git -C "$repo_root" rev-list --count HEAD)"
artifact_stem="YourChar-${version}-macos-arm64"

output_dir="${MACOS_OUTPUT_DIR:-$repo_root/release}"
if [[ "$output_dir" != /* ]]; then
  output_dir="$repo_root/$output_dir"
fi
node_cache_dir="${MACOS_NODE_CACHE_DIR:-${TMPDIR:-/tmp}/yourchar-node-release-cache}"
node_archive_name="node-v${node_version}-darwin-arm64.tar.gz"
node_archive="$node_cache_dir/$node_archive_name"
node_shasums="$node_cache_dir/SHASUMS256-v${node_version}.txt"
node_base_url="https://nodejs.org/dist/v${node_version}"

mkdir -p "$node_cache_dir"
if [[ ! -f "$node_archive" ]]; then
  /usr/bin/curl --fail --location --show-error --output "$node_archive" "$node_base_url/$node_archive_name"
fi
/usr/bin/curl --fail --location --show-error --output "$node_shasums" "$node_base_url/SHASUMS256.txt"
expected_node_sha="$(awk -v name="$node_archive_name" '$2 == name { print $1 }' "$node_shasums")"
actual_node_sha="$(/usr/bin/shasum -a 256 "$node_archive" | awk '{ print $1 }')"
if [[ -z "$expected_node_sha" || "$actual_node_sha" != "$expected_node_sha" ]]; then
  echo "Node archive checksum verification failed." >&2
  exit 1
fi

build_root="$(mktemp -d "${TMPDIR:-/tmp}/yourchar-macos-release.XXXXXX")"
build_root="$(cd "$build_root" && pwd -P)"
smoke_pid=""
cleanup() {
  if [[ -n "$smoke_pid" ]] && kill -0 "$smoke_pid" 2>/dev/null; then
    kill -TERM "$smoke_pid" 2>/dev/null || true
    wait "$smoke_pid" 2>/dev/null || true
  fi
  rm -rf -- "$build_root"
}
trap cleanup EXIT INT TERM

node_unpack="$build_root/node"
source_root="$build_root/source"
app_bundle="$build_root/YourChar.app"
contents="$app_bundle/Contents"
resources="$contents/Resources"
application_root="$resources/app"
runtime_root="$resources/runtime"
mkdir -p "$node_unpack" "$source_root" "$contents/MacOS" "$application_root" "$runtime_root/bin"
/usr/bin/tar -xzf "$node_archive" -C "$node_unpack"
node_distribution="$node_unpack/node-v${node_version}-darwin-arm64"
runtime_node="$runtime_root/bin/node"
/usr/bin/ditto "$node_distribution/bin/node" "$runtime_node"
/usr/bin/ditto "$node_distribution/LICENSE" "$runtime_root/LICENSE"
chmod 755 "$runtime_node"

git -C "$repo_root" archive --format=tar HEAD | /usr/bin/tar -xf - -C "$source_root"
export YOURCHAR_BUILD_UV="${YOURCHAR_BUILD_UV:-$(command -v uv)}"
export PATH="$node_distribution/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export npm_config_audit=false
export npm_config_fund=false
(
  cd "$source_root"
  npm ci
  npm run bundle:markitdown
  if [[ "${MACOS_SKIP_TESTS:-0}" == "1" ]]; then
    npm run build
  else
    npm run test:macos
    if [[ "${MACOS_RUN_FULL_TESTS:-0}" == "1" ]]; then
      npm test
    fi
  fi
  npm prune --omit=dev
  npm ls --omit=dev --depth=0
)
(
  cd "$repo_root"
  "$node_distribution/bin/node" scripts/scan-sensitive.mjs
)

for path in dist assets skills services/markitdown; do
  /usr/bin/ditto "$source_root/$path" "$application_root/$path"
done
for path in package.json package-lock.json LICENSE THIRD_PARTY_NOTICES.md README.md README.zh-CN.md; do
  /usr/bin/ditto "$source_root/$path" "$application_root/$path"
done
/usr/bin/ditto "$source_root/node_modules" "$application_root/node_modules"
/usr/bin/ditto "$source_root/packaging/macos/README.txt" "$resources/README.txt"

/usr/bin/ditto "$source_root/packaging/macos/Info.plist" "$contents/Info.plist"
/usr/bin/plutil -replace CFBundleShortVersionString -string "$version" "$contents/Info.plist"
/usr/bin/plutil -replace CFBundleVersion -string "$build_number" "$contents/Info.plist"
/usr/bin/plutil -lint "$contents/Info.plist"

iconset="$build_root/YourChar.iconset"
mkdir -p "$iconset"
icon_source="$source_root/assets/icons/app-icon-1024.png"
for size in 16 32 128 256 512; do
  double_size=$((size * 2))
  /usr/bin/sips -z "$size" "$size" "$icon_source" --out "$iconset/icon_${size}x${size}.png" >/dev/null
  /usr/bin/sips -z "$double_size" "$double_size" "$icon_source" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done
/usr/bin/iconutil -c icns "$iconset" -o "$resources/YourChar.icns"

/usr/bin/swiftc \
  -swift-version 5 \
  -parse-as-library \
  -O \
  -whole-module-optimization \
  -target arm64-apple-macos13.0 \
  -framework AppKit \
  -framework WebKit \
  "$source_root/packaging/macos/YourCharLauncher.swift" \
  -o "$contents/MacOS/YourChar"
chmod 755 "$contents/MacOS/YourChar"

{
  printf 'YourChar version: %s\n' "$version"
  printf 'Source commit: %s\n' "$commit"
  printf 'Architecture: arm64\n'
  printf 'Embedded Node.js: %s\n' "$node_version"
  printf 'Signing: ad-hoc (not notarized)\n'
} > "$resources/BUILD-INFO.txt"

/usr/bin/codesign --force --deep --sign - "$app_bundle"
/usr/bin/codesign --verify --deep --strict --verbose=2 "$app_bundle"
[[ "$(/usr/bin/lipo -archs "$contents/MacOS/YourChar")" == "arm64" ]]
[[ "$(/usr/bin/lipo -archs "$runtime_node")" == "arm64" ]]

# Re-test the relocated, pruned and signed payload, not just the build tree.
(
  cd "$application_root"
  YOURCHAR_REQUIRE_WORKERS=1 "$runtime_node" --disable-warning=ExperimentalWarning \
    --test --test-concurrency=1 \
    --test-name-pattern='real MarkItDown worker|bundled TypeScript LSP resolves' \
    dist/test/document-reader.test.js dist/test/lsp-navigation.test.js
)

smoke_port="$($runtime_node -e 'const net=require("node:net");const server=net.createServer();server.listen(0,"127.0.0.1",()=>{console.log(server.address().port);server.close();});')"
smoke_state="$build_root/smoke-state"
smoke_log="$build_root/smoke.log"
smoke_response="$build_root/smoke-readiness.json"
smoke_characters="$build_root/smoke-characters.json"
smoke_avatar="$build_root/smoke-avatar.png"
mkdir -p "$smoke_state"
YOURCHAR_STATE_DIR="$smoke_state" \
YOURCHAR_IM_RUNTIME_MODE=off \
HOST=127.0.0.1 \
PORT="$smoke_port" \
"$runtime_node" --disable-warning=ExperimentalWarning "$application_root/dist/src/server.js" >"$smoke_log" 2>&1 &
smoke_pid="$!"
smoke_ready=0
for _ in {1..120}; do
  if /usr/bin/curl --fail --silent --max-time 1 --output "$smoke_response" \
    "http://127.0.0.1:${smoke_port}/api/v1/readiness" &&
    "$runtime_node" -e 'const fs=require("node:fs");try{const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.exit(value.status==="ready"&&value.database==="ok"&&value.markitdownAvailable===true?0:1);}catch{process.exit(1);}' "$smoke_response"
  then
    smoke_ready=1
    break
  fi
  sleep 0.25
done
if [[ "$smoke_ready" != "1" ]]; then
  echo "Packaged runtime did not become ready:" >&2
  tail -80 "$smoke_log" >&2
  exit 1
fi
if ! /usr/bin/curl --fail --silent --max-time 2 --output "$smoke_characters" \
  "http://127.0.0.1:${smoke_port}/api/v1/characters"
then
  echo "Packaged runtime did not return its default character:" >&2
  tail -80 "$smoke_log" >&2
  exit 1
fi
if ! "$runtime_node" -e '
  const fs = require("node:fs");
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const character = Array.isArray(value.characters) && value.characters.length === 1
    ? value.characters[0]
    : undefined;
  if (
    character?.name !== "红莉栖" ||
    !character?.soulMarkdown?.includes("牧濑红莉栖") ||
    character?.avatarUrl !== "/assets/default-characters/kurisu-avatar-crop.png"
  ) process.exit(1);
' "$smoke_characters"
then
  echo "Packaged runtime did not seed the expected default character." >&2
  tail -80 "$smoke_log" >&2
  exit 1
fi
if ! /usr/bin/curl --fail --silent --max-time 2 --output "$smoke_avatar" \
  "http://127.0.0.1:${smoke_port}/assets/default-characters/kurisu-avatar-crop.png"
then
  echo "Packaged runtime did not serve the bundled default avatar." >&2
  tail -80 "$smoke_log" >&2
  exit 1
fi
if [[ "$(/usr/bin/shasum -a 256 "$smoke_avatar" | awk '{ print $1 }')" != \
  "0a76ba7859de879edeec379e0c9b29d4a19aacdb817aa493893c5ec7d008f4c3" ]]
then
  echo "Packaged default avatar checksum did not match the release source." >&2
  exit 1
fi
kill -TERM "$smoke_pid"
wait "$smoke_pid"
smoke_pid=""
"$runtime_node" -e 'const fs=require("node:fs");const log=fs.readFileSync(process.argv[1],"utf8");if(!log.includes("YourChar listening on")||!log.includes("YourChar stopped."))process.exit(1);' "$smoke_log"

mkdir -p "$output_dir"
zip_path="$output_dir/${artifact_stem}.zip"
dmg_path="$output_dir/${artifact_stem}.dmg"
checksum_path="$output_dir/SHA256SUMS.txt"
rm -f -- "$zip_path" "$dmg_path" "$checksum_path"
/usr/bin/ditto -c -k --sequesterRsrc --keepParent "$app_bundle" "$zip_path"
dmg_source="$build_root/dmg"
mkdir -p "$dmg_source"
/usr/bin/ditto "$app_bundle" "$dmg_source/YourChar.app"
ln -s /Applications "$dmg_source/Applications"
/usr/bin/hdiutil create -quiet -volname "YourChar ${version}" -srcfolder "$dmg_source" -ov -format UDZO "$dmg_path"
(
  cd "$output_dir"
  /usr/bin/shasum -a 256 "$(basename "$zip_path")" "$(basename "$dmg_path")" > "$(basename "$checksum_path")"
)

printf '\nYourChar macOS release created:\n'
printf '  %s\n' "$zip_path" "$dmg_path" "$checksum_path"
printf '  Version %s, commit %s, Node %s, arm64, ad-hoc signed\n' "$version" "$commit" "$node_version"
