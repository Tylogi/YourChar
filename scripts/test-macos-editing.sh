#!/usr/bin/env bash
set -euo pipefail
if [[ "$(uname -s)" != Darwin ]]; then
  echo 'Native editing tests require macOS.' >&2
  exit 1
fi
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/yourchar-editing-tests.XXXXXX")"
trap 'rm -rf -- "$test_root"' EXIT
test_app="$test_root/YourChar Editing Tests.app"
mkdir -p "$test_app/Contents/MacOS"
cat > "$test_app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>ai.tylogi.yourchar.editing-tests</string>
  <key>CFBundleName</key><string>YourChar Editing Tests</string>
  <key>CFBundleExecutable</key><string>YourCharEditingTests</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>NSPrincipalClass</key><string>NSApplication</string>
</dict></plist>
PLIST
/usr/bin/swiftc -swift-version 5 -parse-as-library -framework AppKit -framework WebKit \
  "$repo_root/packaging/macos/EditingMenu.swift" \
  "$repo_root/packaging/macos/tests/EditingMenuTests.swift" \
  -o "$test_app/Contents/MacOS/YourCharEditingTests"
if [[ -n "${MACOS_SIGN_IDENTITY:-}" ]]; then
  /usr/bin/codesign --force --sign "$MACOS_SIGN_IDENTITY" --options runtime --timestamp "$test_app"
fi
/usr/bin/open -n -W -o "$test_root/stdout" --stderr "$test_root/stderr" "$test_app" --args "$test_root/result" -AppleLanguages '(en)'
cat "$test_root/stdout" "$test_root/stderr"
[[ "$(cat "$test_root/result")" == 0 ]]
