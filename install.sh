#!/bin/sh

set -eu

HD_AGENT_SOURCE="git:github.com/tuong-nguyen-vn/hd-agent"
HD_AGENT_BUN_SOURCE="github:tuong-nguyen-vn/hd-agent"
LEGACY_PI_SOURCE="git:github.com/tuong-nguyen-vn/pim-agent"
PI_PACKAGE="@earendil-works/pi-coding-agent"
LEGACY_PACKAGE="@aaroncql/pim-agent"
BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"

log() {
  printf '\n==> %s\n' "$1"
}

fail() {
  printf '\nError: %s\n' "$1" >&2
  exit 1
}

refresh_path() {
  PATH="$BUN_INSTALL/bin:$PATH"
  export PATH
  hash -r 2>/dev/null || true
}

install_bun() {
  if command -v bun >/dev/null 2>&1; then
    log "Bun is already installed ($(bun --version))"
    return
  fi

  log "Installing Bun"
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
      if command -v powershell.exe >/dev/null 2>&1; then
        powershell.exe -NoProfile -ExecutionPolicy Bypass -Command \
          "Invoke-RestMethod https://bun.sh/install.ps1 | Invoke-Expression"
      elif command -v powershell >/dev/null 2>&1; then
        powershell -NoProfile -ExecutionPolicy Bypass -Command \
          "Invoke-RestMethod https://bun.sh/install.ps1 | Invoke-Expression"
      else
        fail "PowerShell is required to install Bun from Git Bash."
      fi
      ;;
    Darwin|Linux)
      command -v curl >/dev/null 2>&1 || fail "curl is required to install Bun."
      curl -fsSL https://bun.sh/install | bash
      ;;
    *)
      fail "Unsupported operating system: $(uname -s)"
      ;;
  esac

  refresh_path
  command -v bun >/dev/null 2>&1 || fail "Bun was installed but is not available in PATH. Add $BUN_INSTALL/bin to PATH and run this script again."
}

install_pi() {
  if pi_cli=$(find_bun_pi_cli); then
    log "Pi is already installed ($(bun "$pi_cli" --version 2>/dev/null || printf 'version unknown'))"
    return
  fi

  log "Installing Pi"
  bun install -g "$PI_PACKAGE"
  refresh_path
  find_bun_pi_cli >/dev/null 2>&1 || command -v pi >/dev/null 2>&1 || fail "Pi installation completed but the pi command was not found."
}

find_bun_pi_cli() {
  bun_global_bin=$(bun pm -g bin 2>/dev/null || true)
  if [ -n "$bun_global_bin" ]; then
    bun_pi_cli="$bun_global_bin/../install/global/node_modules/$PI_PACKAGE/dist/cli.js"
    if [ -f "$bun_pi_cli" ]; then
      printf '%s\n' "$bun_pi_cli"
      return 0
    fi
  fi

  bun_global_root=$(bun pm -g ls 2>/dev/null | sed -n '1s/.*node_modules.*/&/p' || true)
  if [ -n "$bun_global_root" ]; then
    bun_pi_cli="$bun_global_root/$PI_PACKAGE/dist/cli.js"
    if [ -f "$bun_pi_cli" ]; then
      printf '%s\n' "$bun_pi_cli"
      return 0
    fi
  fi

  for candidate in \
    "$BUN_INSTALL/install/global/node_modules/$PI_PACKAGE/dist/cli.js" \
    "$HOME/.bun/install/global/node_modules/$PI_PACKAGE/dist/cli.js"; do
    if [ -f "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  return 1
}

run_pi_package_command() {
  if pi_cli=$(find_bun_pi_cli); then
    bun "$pi_cli" "$@"
  elif command -v pi >/dev/null 2>&1; then
    pi "$@"
  else
    fail "Pi is not installed. Run this script again."
  fi
}

remove_legacy_pi_package() {
  list_log="${TMPDIR:-/tmp}/hd-agent-list.$$"
  trap 'rm -f "$list_log"' EXIT HUP INT TERM

  run_pi_package_command list --no-approve >"$list_log" 2>&1
  if grep -Fq "$LEGACY_PI_SOURCE" "$list_log"; then
    log "Removing legacy Pim Pi package"
    run_pi_package_command remove "$LEGACY_PI_SOURCE" --no-approve
  fi

  rm -f "$list_log"
  trap - EXIT HUP INT TERM
}

install_or_update_pi_package() {
  log "Installing or updating the HD Agent Pi package"

  update_log="${TMPDIR:-/tmp}/hd-agent-update.$$"
  trap 'rm -f "$update_log"' EXIT HUP INT TERM

  if run_pi_package_command update "$HD_AGENT_SOURCE" --no-approve >"$update_log" 2>&1; then
    cat "$update_log"
  elif grep -q "No matching package found" "$update_log"; then
    cat "$update_log"
    run_pi_package_command install "$HD_AGENT_SOURCE" --no-approve
  else
    cat "$update_log" >&2
    fail "Could not update the HD Agent Pi package."
  fi

  rm -f "$update_log"
  trap - EXIT HUP INT TERM
}

install_or_update_launcher() {
  log "Installing or updating the HD Agent launcher"

  if bun pm ls -g 2>/dev/null | grep -Fq "$LEGACY_PACKAGE@"; then
    bun remove -g "$LEGACY_PACKAGE"
  fi

  if bun pm ls -g 2>/dev/null | grep -Fq 'hd-agent@'; then
    bun remove -g hd-agent
  fi

  bun install -g --force --no-cache "$HD_AGENT_BUN_SOURCE"
  refresh_path
  command -v hd-agent >/dev/null 2>&1 || fail "HD Agent was installed but the hd-agent command was not found."
}

print_summary() {
  log "HD Agent is ready"
  printf 'Bun:     %s\n' "$(bun --version)"
  printf 'Pi:      %s\n' "$(hd-agent --version)"
  printf 'Command: %s\n' "$(command -v hd-agent)"
  printf '\nRun HD Agent with:\n\n  hd-agent\n\n'
}

refresh_path
install_bun
install_pi
remove_legacy_pi_package
install_or_update_pi_package
install_or_update_launcher
print_summary
