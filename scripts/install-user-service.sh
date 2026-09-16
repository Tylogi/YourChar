#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node_path="$(command -v node)"
if [[ ! -x /usr/bin/bwrap ]]; then
  echo "Bubblewrap is required at /usr/bin/bwrap for sandboxed Agent shell and document conversion." >&2
  exit 1
fi
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
unit_path="$unit_dir/rp-agent.service"
state_dir="$project_dir/.yourchar"
legacy_state_dir="$project_dir/.rp-agent"
existing_unit=false

if systemctl --user cat rp-agent.service >/dev/null 2>&1; then
  existing_unit=true
  if ! existing_working_directory="$(
    systemctl --user show --property=WorkingDirectory --value rp-agent.service
  )"; then
    echo "Cannot inspect the existing rp-agent.service WorkingDirectory; refusing to overwrite it." >&2
    exit 1
  fi
  if [[ "$existing_working_directory" != "$project_dir" ]]; then
    echo "Existing rp-agent.service belongs to a different project (WorkingDirectory=${existing_working_directory:-<empty>})." >&2
    echo "Refusing to stop or overwrite that unit." >&2
    exit 1
  fi

  if ! existing_exec_start="$(
    systemctl --user show --property=ExecStart --value rp-agent.service
  )"; then
    echo "Cannot inspect the existing rp-agent.service ExecStart; refusing to overwrite it." >&2
    exit 1
  fi
  expected_entrypoint="$project_dir/dist/src/server.js"
  if [[ "$existing_exec_start" != *"$expected_entrypoint"* ]]; then
    echo "Existing rp-agent.service does not run this project's dist/src/server.js." >&2
    echo "Refusing to stop or overwrite that unit." >&2
    exit 1
  fi

  if ! existing_environment="$(
    systemctl --user show --property=Environment --value rp-agent.service
  )"; then
    echo "Cannot inspect the existing rp-agent.service Environment; refusing to overwrite it." >&2
    exit 1
  fi
  if ! "$node_path" - "$existing_environment" "$state_dir" "$legacy_state_dir" <<'NODE'
const [serialized, currentState, legacyState] = process.argv.slice(2);
const allowedByName = new Map([
  ["YOURCHAR_STATE_DIR", currentState],
  ["RP_AGENT_STATE_DIR", legacyState],
]);
const words = [];
let word = "";
let quote;
let escaped = false;
let active = false;
for (const character of serialized) {
  if (escaped) {
    word += character;
    escaped = false;
    active = true;
  } else if (character === "\\") {
    escaped = true;
    active = true;
  } else if (quote !== undefined) {
    if (character === quote) quote = undefined;
    else word += character;
    active = true;
  } else if (character === "\"" || character === "'") {
    quote = character;
    active = true;
  } else if (/\s/u.test(character)) {
    if (active) words.push(word);
    word = "";
    active = false;
  } else {
    word += character;
    active = true;
  }
}
if (escaped || quote !== undefined) throw new Error("malformed systemd Environment property");
if (active) words.push(word);

for (const entry of words) {
  for (const [name, allowed] of allowedByName) {
    const marker = `${name}=`;
    if (!entry.includes(marker)) continue;
    if (!entry.startsWith(marker) || entry.slice(marker.length) !== allowed) process.exit(1);
  }
}
NODE
  then
    echo "Existing rp-agent.service has a custom state-directory configuration." >&2
    echo "The installer manages only this project's .yourchar/.rp-agent paths; migrate the custom drop-in manually." >&2
    exit 1
  fi
fi

migration_action="$("$node_path" --disable-warning=ExperimentalWarning \
  "$project_dir/scripts/migrate-state-directory.mjs" preflight "$project_dir")"

npm --prefix "$project_dir" run build

if [[ "$migration_action" == "migrate" ]]; then
  service_was_active=false
  if systemctl --user is-active --quiet rp-agent.service; then
    service_was_active=true
  fi
  if [[ "$service_was_active" == true || "$existing_unit" == true ]]; then
    systemctl --user stop rp-agent.service
  fi

  restart_previous_service_after_failure() {
    if [[ "$service_was_active" == true ]]; then
      systemctl --user start rp-agent.service || \
        echo "Installation failed and the previous service could not be restarted." >&2
    fi
  }

  backup_timestamp="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
  backup_destination="$project_dir/backups/yourchar-pre-migration-$backup_timestamp-$$"
  backup_status=0
  migration_backup="$(
    "$node_path" --disable-warning=ExperimentalWarning \
      "$project_dir/scripts/backup-state.mjs" "$legacy_state_dir" "$backup_destination"
  )" || backup_status=$?
  if [[ "$backup_status" -ne 0 ]]; then
    restart_previous_service_after_failure
    exit "$backup_status"
  fi
  echo "Verified pre-migration backup: $migration_backup"

  migration_status=0
  "$node_path" --disable-warning=ExperimentalWarning \
    "$project_dir/scripts/migrate-state-directory.mjs" migrate "$project_dir" || \
    migration_status=$?
  if [[ "$migration_status" -ne 0 ]]; then
    if [[ "$service_was_active" == true && -d "$legacy_state_dir" && ! -L "$legacy_state_dir" ]]; then
      restart_previous_service_after_failure
    fi
    exit "$migration_status"
  fi
fi

confirmed_action="$("$node_path" --disable-warning=ExperimentalWarning \
  "$project_dir/scripts/migrate-state-directory.mjs" preflight "$project_dir")"
if [[ "$confirmed_action" != "ready" && "$confirmed_action" != "create" ]]; then
  echo "State directory layout changed during installation; refusing to continue." >&2
  exit 1
fi
install -d -m 700 -- "$unit_dir" "$state_dir"
unit_staging="$(mktemp -- "$unit_dir/.rp-agent.service.XXXXXX")"
cleanup_unit_staging() {
  if [[ -n "${unit_staging:-}" ]]; then
    rm -f -- "$unit_staging"
  fi
}
trap cleanup_unit_staging EXIT
sed \
  -e "s|__PROJECT_DIR__|$project_dir|g" \
  -e "s|__HOME__|$HOME|g" \
  -e "s|__NODE__|$node_path|g" \
  "$project_dir/ops/rp-agent.service.in" > "$unit_staging"
chmod 600 "$unit_staging"
mv -f -- "$unit_staging" "$unit_path"
unit_staging=""
systemctl --user daemon-reload
systemctl --user enable rp-agent.service
systemctl --user restart rp-agent.service

readiness_url="http://127.0.0.1:8765/api/v1/readiness"
probe_readiness() {
  "$node_path" --input-type=module -e '
    const response = await fetch(process.argv[1], {
      redirect: "error",
      signal: AbortSignal.timeout(2000),
    });
    await response.body?.cancel();
    process.exit(response.ok ? 0 : 1);
  ' "$readiness_url" >/dev/null 2>&1
}
report_startup_failure() {
  echo "rp-agent.service failed post-restart readiness/stability verification." >&2
  systemctl --user --no-pager status rp-agent.service >&2 || true
  journalctl --user -u rp-agent.service --no-pager -n 100 >&2 || true
}

readiness_deadline=$((SECONDS + 30))
readiness_succeeded=false
while (( SECONDS < readiness_deadline )); do
  if probe_readiness; then
    readiness_succeeded=true
    break
  fi
  sleep 1
done
if [[ "$readiness_succeeded" != true ]] || \
    ! systemctl --user is-active --quiet rp-agent.service; then
  report_startup_failure
  exit 1
fi

initial_main_pid="$(systemctl --user show --property=MainPID --value rp-agent.service)"
sleep 2
stable_main_pid="$(systemctl --user show --property=MainPID --value rp-agent.service)"
if [[ -z "$initial_main_pid" || "$initial_main_pid" == 0 || \
      "$stable_main_pid" != "$initial_main_pid" ]] || \
    ! systemctl --user is-active --quiet rp-agent.service || \
    ! probe_readiness; then
  report_startup_failure
  exit 1
fi

systemctl --user --no-pager status rp-agent.service
