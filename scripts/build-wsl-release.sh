#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

# Build the distributable YourChar runtime for Windows users: a self-contained
# WSL2 distribution (Linux userspace + Node + Bubblewrap + bundled CPython with
# MarkItDown/Magika/ONNX Runtime) plus the application payload.
#
# The end user installs none of that: importing the archive into WSL2 is the
# whole setup. uv is a build-time tool only and is never shipped.

usage() {
  cat <<'EOF'
Build a distributable YourChar runtime + application payload for Windows/WSL2.

Usage:
  npm run package:windows
  scripts/build-wsl-release.sh [--keep-build]

Outputs (default ./release):
  YourChar-<version>-wsl-amd64.tar.gz       full WSL2 distribution (wsl --import)
  YourChar-<version>-wsl-amd64-app.tar.gz   application payload only (updates)
  SHA256SUMS.txt                            integrity manifest for both

Environment:
  YOURCHAR_WSL_OUTPUT_DIR    Artifact directory (default: ./release)
  YOURCHAR_WSL_CACHE_DIR     Download/build cache (default: ~/.cache/yourchar-wsl-release)
  YOURCHAR_WSL_APT_MIRROR    Ubuntu mirror used inside the rootfs
                             (default: http://archive.ubuntu.com/ubuntu)
  YOURCHAR_WSL_UBUNTU_BASE   Base rootfs URL (default: pinned 26.04.1 amd64)
  YOURCHAR_WSL_UBUNTU_SHA256 Expected sha256 of the base rootfs
  YOURCHAR_BUILD_UV          uv executable used to bundle MarkItDown
                             (default: first uv on PATH)

Requires root, or a sudo that can elevate, because the rootfs is assembled with
chroot. Nothing is written to the source checkout: all staging happens in a
temporary directory, so a failed build leaves the repository untouched.
EOF
}

keep_build=0
for argument in "$@"; do
  case "$argument" in
    -h|--help) usage; exit 0 ;;
    --keep-build) keep_build=1 ;;
    *) echo "Unknown argument: $argument" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "This builder assembles a Linux rootfs and must run inside Linux or WSL2." >&2
  exit 1
fi
if [[ "$(uname -m)" != "x86_64" ]]; then
  echo "Only x86_64 Windows hosts are supported today (found $(uname -m))." >&2
  exit 1
fi
if ((EUID != 0)); then
  if command -v sudo >/dev/null 2>&1; then
    echo "Elevating with sudo to assemble the rootfs..."
    exec sudo -E bash -- "${BASH_SOURCE[0]}" "$@"
  fi
  echo "Run this script as root (chroot is required to assemble the rootfs)." >&2
  exit 1
fi

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
ubuntu_base_url="${YOURCHAR_WSL_UBUNTU_BASE:-https://cdimage.ubuntu.com/ubuntu-base/releases/26.04/release/ubuntu-base-26.04.1-base-amd64.tar.gz}"
ubuntu_base_sha="${YOURCHAR_WSL_UBUNTU_SHA256:-a496a960472ce474a59590b8987d3a1135d3cbef1991f3b1abe8cacfea8bf85a}"
apt_mirror="${YOURCHAR_WSL_APT_MIRROR:-http://archive.ubuntu.com/ubuntu}"
cache_dir="${YOURCHAR_WSL_CACHE_DIR:-/root/.cache/yourchar-wsl-release}"
output_dir="${YOURCHAR_WSL_OUTPUT_DIR:-$repo_root/release}"
node_version="$(tr -d '[:space:]' < "$repo_root/.nvmrc")"
if [[ ! "$node_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Invalid Node version in .nvmrc: $node_version" >&2
  exit 1
fi
python_version="3.13.5"
markitdown_address_space_bytes=4294967296

version="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$repo_root/package.json")"
# Running through sudo makes the checkout look foreign to git, which would
# otherwise refuse to read it.
git_repo() { git -c safe.directory="$repo_root" -C "$repo_root" "$@"; }
commit="$(git_repo rev-parse HEAD)"
commit_time="$(git_repo show -s --format=%ct HEAD)"
if [[ -n "$(git_repo status --porcelain=v1)" ]]; then
  dirty_tree="yes"
else
  dirty_tree="no"
fi
artifact_stem="YourChar-${version}-wsl-amd64"

# The payload ships the verified address-space bound for the document worker.
if ! grep -q "RLIMIT_AS, (${markitdown_address_space_bytes}, ${markitdown_address_space_bytes})" \
  "$repo_root/services/markitdown/worker.py"; then
  echo "services/markitdown/worker.py does not carry the verified ${markitdown_address_space_bytes}-byte RLIMIT_AS." >&2
  echo "The document worker would fail nondeterministically; refusing to build." >&2
  exit 1
fi

if [[ "$output_dir" != /* ]]; then
  output_dir="$repo_root/$output_dir"
fi
mkdir -p "$cache_dir" "$output_dir"

echo "== Fetching verified build inputs =="
ubuntu_base_archive="$cache_dir/$(basename "$ubuntu_base_url")"
if [[ ! -f "$ubuntu_base_archive" ]]; then
  curl --fail --location --show-error --output "$ubuntu_base_archive.part" "$ubuntu_base_url"
  mv -- "$ubuntu_base_archive.part" "$ubuntu_base_archive"
fi
if [[ "$(sha256sum "$ubuntu_base_archive" | awk '{ print $1 }')" != "$ubuntu_base_sha" ]]; then
  echo "Ubuntu base rootfs checksum verification failed." >&2
  exit 1
fi

node_archive="$cache_dir/node-v${node_version}-linux-x64.tar.xz"
node_shasums="$cache_dir/SHASUMS256-v${node_version}.txt"
node_base_url="https://nodejs.org/dist/v${node_version}"
if [[ ! -f "$node_archive" ]]; then
  curl --fail --location --show-error --output "$node_archive.part" "$node_base_url/$(basename "$node_archive")"
  mv -- "$node_archive.part" "$node_archive"
fi
curl --fail --location --show-error --output "$node_shasums" "$node_base_url/SHASUMS256.txt"
expected_node_sha="$(awk -v name="$(basename "$node_archive")" '$2 == name { print $1 }' "$node_shasums")"
if [[ -z "$expected_node_sha" || "$(sha256sum "$node_archive" | awk '{ print $1 }')" != "$expected_node_sha" ]]; then
  echo "Node archive checksum verification failed." >&2
  exit 1
fi

build_root="$(mktemp -d /tmp/yourchar-wsl-release.XXXXXX)"
rootfs="$build_root/rootfs"
source_root="$build_root/source"
payload_root="$build_root/payload"
mounted=()
cleanup() {
  for ((index = ${#mounted[@]} - 1; index >= 0; index -= 1)); do
    umount "${mounted[index]}" 2>/dev/null || true
  done
  if ((keep_build == 1)); then
    echo "Keeping build directory: $build_root"
    return
  fi
  rm -rf -- "$build_root"
}
trap cleanup EXIT INT TERM

echo "== Unpacking Ubuntu base rootfs =="
mkdir -p "$rootfs"
tar -xzf "$ubuntu_base_archive" -C "$rootfs"
suite="$(. "$rootfs/etc/os-release" && printf '%s' "${VERSION_CODENAME:-}")"
if [[ -z "$suite" ]]; then
  echo "Could not determine the Ubuntu suite from the base rootfs." >&2
  exit 1
fi

cat > "$rootfs/etc/apt/sources.list" <<EOF
deb $apt_mirror $suite main universe
deb $apt_mirror $suite-updates main universe
deb $apt_mirror $suite-security main universe
EOF
rm -f "$rootfs/etc/apt/sources.list.d/"*.sources "$rootfs/etc/apt/sources.list.d/"*.list

install -d "$rootfs/usr/local/bin" "$rootfs/opt/yourchar/node" "$rootfs/var/lib/yourchar"
install -m 644 "$repo_root/packaging/windows/wsl.conf" "$rootfs/etc/wsl.conf"
# Copy the resolved configuration, not a host symlink that dangles inside the rootfs.
rm -f "$rootfs/etc/resolv.conf"
cp -L /etc/resolv.conf "$rootfs/etc/resolv.conf"

echo "== Installing Linux userspace (Node-adjacent runtime dependencies) =="
for directory in proc sys dev dev/pts; do
  install -d "$rootfs/$directory"
  mount --bind "/$directory" "$rootfs/$directory"
  mounted+=("$rootfs/$directory")
done
export DEBIAN_FRONTEND=noninteractive
chroot "$rootfs" /bin/bash -euo pipefail -c '
  apt-get update
  apt-get install --yes --no-install-recommends \
    bubblewrap ca-certificates curl git libgomp1 libstdc++6 passwd util-linux
  apt-get clean
  rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb
  useradd --create-home --uid 1000 --shell /bin/bash yourchar
'
for ((index = ${#mounted[@]} - 1; index >= 0; index -= 1)); do
  umount "${mounted[index]}"
done
unset mounted
mounted=()

echo "== Installing Node.js $node_version =="
tar -xJf "$node_archive" -C "$rootfs/opt/yourchar/node" --strip-components=1
rm -rf "$rootfs/opt/yourchar/node/include" "$rootfs/opt/yourchar/node/share"
ln -sf /opt/yourchar/node/bin/node "$rootfs/usr/local/bin/node"
ln -sf /opt/yourchar/node/bin/npm "$rootfs/usr/local/bin/npm"
ln -sf /opt/yourchar/node/bin/npx "$rootfs/usr/local/bin/npx"

echo "== Building application payload =="
mkdir -p "$source_root"
tar -C "$repo_root" \
  --exclude=./.git --exclude=./node_modules --exclude=./release --exclude=./dist \
  --exclude='./services/markitdown/runtime' --exclude='./services/markitdown/.venv' \
  --exclude='./services/markitdown/.bundle-*' \
  -cf - . | tar -C "$source_root" -xf -

# Build with the Node runtime that ships in the image, not the host's.
export PATH="$rootfs/opt/yourchar/node/bin:$PATH"
export npm_config_audit=false
export npm_config_fund=false
export npm_config_cache="$cache_dir/npm"
export UV_CACHE_DIR="${UV_CACHE_DIR:-$cache_dir/uv}"
export YOURCHAR_BUILD_UV="${YOURCHAR_BUILD_UV:-$(command -v uv || true)}"
if [[ -z "$YOURCHAR_BUILD_UV" ]]; then
  echo "uv is required at build time to bundle MarkItDown; set YOURCHAR_BUILD_UV." >&2
  exit 1
fi
(
  cd "$source_root"
  npm ci
  npm run bundle:markitdown
  npm run build
  npm prune --omit=dev
  npm ls --omit=dev --depth=0 >/dev/null
)

echo "== Assembling payload =="
mkdir -p "$payload_root/bin" "$payload_root/scripts"
for path in dist assets skills node_modules package.json LICENSE THIRD_PARTY_NOTICES.md services/markitdown; do
  if [[ -e "$source_root/$path" ]]; then
    mkdir -p "$(dirname "$payload_root/$path")"
    cp -a "$source_root/$path" "$payload_root/$path"
  fi
done
cp -a "$repo_root/scripts/start-wsl-backend.sh" "$payload_root/scripts/start-wsl-backend.sh"
install -m 755 "$repo_root/packaging/windows/bin/yourchar-backend" "$payload_root/bin/yourchar-backend"
rm -rf "$payload_root/services/markitdown/.venv" "$payload_root/services/markitdown/.bundle-"*

cat > "$payload_root/BUILD-INFO.txt" <<EOF
YourChar version: $version
Source commit: $commit (dirty working tree: $dirty_tree)
Architecture: amd64
Ubuntu base: $(basename "$ubuntu_base_archive")
Ubuntu base sha256: $ubuntu_base_sha
Embedded Node.js: $node_version
Bundled CPython: $python_version
Document worker RLIMIT_AS: $markitdown_address_space_bytes bytes
State directory: /var/lib/yourchar
EOF

cp -a "$payload_root/." "$rootfs/opt/yourchar/"
chown -R root:root "$rootfs/opt/yourchar"
chown -R 1000:1000 "$rootfs/var/lib/yourchar" "$rootfs/home/yourchar"
chmod 700 "$rootfs/var/lib/yourchar"

echo "== Packaging =="
rm -f "$output_dir/$artifact_stem.tar.gz" "$output_dir/$artifact_stem-app.tar.gz"
tar --numeric-owner --sort=name -C "$rootfs" -czf "$output_dir/$artifact_stem.tar.gz" .
tar --owner=0 --group=0 --numeric-owner --sort=name --mtime="@$commit_time" \
  -C "$payload_root" -czf "$output_dir/$artifact_stem-app.tar.gz" .
(
  cd "$output_dir"
  sha256sum "$artifact_stem.tar.gz" "$artifact_stem-app.tar.gz" > SHA256SUMS.txt
)

echo
echo "Artifacts in $output_dir:"
ls -lh "$output_dir/$artifact_stem.tar.gz" "$output_dir/$artifact_stem-app.tar.gz" "$output_dir/SHA256SUMS.txt"
cat <<EOF

Import the distribution on Windows (no administrator rights required):

  wsl --import YourChar "%LOCALAPPDATA%\\YourChar\\wsl" "$output_dir/$artifact_stem.tar.gz"

Then start the backend inside it:

  wsl -d YourChar --exec /opt/yourchar/bin/yourchar-backend --check
  wsl -d YourChar --exec /opt/yourchar/bin/yourchar-backend

User state lives in /var/lib/yourchar and is separate from /opt/yourchar, so
replacing the payload directory never touches user data.
EOF