#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node_path="$(command -v node)"
if [[ ! -x /usr/bin/bwrap ]]; then
  echo "Bubblewrap is required at /usr/bin/bwrap for sandboxed Agent shell execution." >&2
  exit 1
fi
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
unit_path="$unit_dir/rp-agent.service"

npm --prefix "$project_dir" run build
mkdir -p "$unit_dir" "$project_dir/.rp-agent"
sed \
  -e "s|__PROJECT_DIR__|$project_dir|g" \
  -e "s|__HOME__|$HOME|g" \
  -e "s|__NODE__|$node_path|g" \
  "$project_dir/ops/rp-agent.service.in" > "$unit_path"
chmod 600 "$unit_path"
systemctl --user daemon-reload
systemctl --user enable --now rp-agent.service
systemctl --user --no-pager status rp-agent.service
