#!/usr/bin/env bash
# auto-update.sh - the one-time note that Claude Code's auto-update is off for
# the plugin's marketplace. Sourced by preflight.sh after lib/bootstrap.sh, whose
# is_codex_host and json_member_value it uses.
#
# Claude Code turns marketplace auto-update on by default only for its own and
# allowlisted marketplaces, and marketplace.json has no field that changes that,
# so a user who never opens /plugin stays on the version they first installed.
# The note says so once per install: the stamp lives in CLAUDE_PLUGIN_DATA, which
# Claude Code keeps across plugin updates, and is written before the note is
# shown, so a stamp that cannot be written means no note rather than one in every
# session.

AUTO_UPDATE_MARKETPLACE="actual-cli-skills"

# "true" or "false": the autoUpdate that the settings file $1 sets for the
# marketplace under extraKnownMarketplaces. Fails when the file, the entry or
# the field is missing.
auto_update_in_settings() {
  local json
  [ -f "$1" ] && json=$(cat "$1" 2>/dev/null) || return 1
  json=$(json_member_value "$json" extraKnownMarketplaces) || return 1
  auto_update_in_entry "$json"
}

# Same, from an object keyed by marketplace name, such as extraKnownMarketplaces
# or known_marketplaces.json.
auto_update_in_entry() {
  local v
  v=$(json_member_value "$1" "$AUTO_UPDATE_MARKETPLACE") || return 1
  v=$(json_member_value "$v" autoUpdate) || return 1
  case "$v" in
    true|false) printf '%s' "$v" ;;
    *) return 1 ;;
  esac
}

# Prints the note and stamps CLAUDE_PLUGIN_DATA when auto-update is off for the
# marketplace and the user can turn it on; prints nothing otherwise.
auto_update_notice() {
  is_codex_host && return 0
  # Only an install from the marketplace can auto-update: Claude Code runs it
  # from plugins/cache/<marketplace>/, and a --plugin-dir checkout from anywhere.
  case "${CLAUDE_PLUGIN_ROOT:-}" in
    */plugins/cache/"$AUTO_UPDATE_MARKETPLACE"/*) ;;
    *) return 0 ;;
  esac
  local data="${CLAUDE_PLUGIN_DATA:-}" stamp
  [ -n "$data" ] || return 0
  stamp="${data}/auto-update-notice-shown"
  [ -e "$stamp" ] && return 0

  # These variables, and "autoUpdates": false in Claude Code's global config,
  # turn background updates off and hide the /plugin toggle, unless
  # FORCE_AUTOUPDATE_PLUGINS is set. The native installer writes that false
  # with "autoUpdatesProtectedForNative": true, which Claude Code doesn't count
  # as off. The global config holds project history and can run to megabytes,
  # so it gets a grep rather than the JSON scan.
  local config="${CLAUDE_CONFIG_DIR:-$HOME/.claude}" project="${CLAUDE_PROJECT_DIR:-$PWD}" f on=""
  local global="${CLAUDE_CONFIG_DIR:+$CLAUDE_CONFIG_DIR/.claude.json}"
  if [ -z "${FORCE_AUTOUPDATE_PLUGINS:-}" ]; then
    [ -n "${DISABLE_AUTOUPDATER:-}${DISABLE_UPDATES:-}${CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:-}" ] && return 0
    global=${global:-$HOME/.claude.json}
    if grep -Eq '"autoUpdates"[[:space:]]*:[[:space:]]*false' "$global" 2>/dev/null \
       && ! { grep -Eq '"installMethod"[[:space:]]*:[[:space:]]*"native"' "$global" \
              && grep -Eq '"autoUpdatesProtectedForNative"[[:space:]]*:[[:space:]]*true' "$global"; }; then
      return 0
    fi
  fi

  # Claude Code takes autoUpdate from settings first, highest precedence first,
  # then from known_marketplaces.json, where the /plugin toggle also writes it,
  # and otherwise leaves it off. A value in managed settings also locks the
  # toggle, so there is nothing to tell the user either way.
  for f in "/Library/Application Support/ClaudeCode/managed-settings.json" \
           "/etc/claude-code/managed-settings.json"; do
    auto_update_in_settings "$f" >/dev/null && return 0
  done
  for f in "${project}/.claude/settings.local.json" "${project}/.claude/settings.json" \
           "${config}/settings.json"; do
    on=$(auto_update_in_settings "$f") && break
  done
  if [ -z "$on" ] && [ -f "${config}/plugins/known_marketplaces.json" ]; then
    on=$(auto_update_in_entry "$(cat "${config}/plugins/known_marketplaces.json" 2>/dev/null)")
  fi
  [ "$on" = "true" ] && return 0

  mkdir -p "$data" 2>/dev/null && : > "$stamp" 2>/dev/null || return 0
  cat <<EOF
Claude Code's auto-update is off for the ${AUTO_UPDATE_MARKETPLACE} marketplace, so
the actual plugin stays on the version installed now and the user gets fixes and
new checks only by updating it by hand. At a natural pause, such as the end of
your next reply, tell the user once how to get each new version automatically:
run /plugin, open the Marketplaces tab, select ${AUTO_UPDATE_MARKETPLACE} and
choose "Turn on auto-update" ("Enable auto-update" in older Claude Code
versions). This note isn't shown again.
EOF
}
