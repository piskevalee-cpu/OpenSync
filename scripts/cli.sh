#!/usr/bin/env bash
# opensync — OpenSync CLI dashboard & service manager.
#
#   usage:  opensync [command]
#
#   (no command)   interactive dashboard (fallback: one-shot status)
#   start          start the server in the background
#   stop           stop the server
#   restart        restart the server
#   status         show service status (one-shot)
#   logs           tail the server log
#   update         git pull + npm install (+ restart if active)
#   uninstall      stop the server and remove the command
#   help           show this help
set -euo pipefail

SOURCE="$(readlink -f "$0" 2>/dev/null || echo "$0")"
ROOT="$(cd "$(dirname "$(dirname "$SOURCE")")" && pwd)"
ROOT="${OPENSYNC_DIR:-$ROOT}"

source "$ROOT/scripts/lib.sh" || { echo "cannot find scripts/lib.sh (repo root: $ROOT)" >&2; exit 1; }

DEFAULT_PORT=3000
STORAGE="${OPENSYNC_STORAGE:-$ROOT/storage}"
PIDFILE="$STORAGE/opensync.pid"
LOGFILE="$STORAGE/opensync.log"

# ---- small utilities ---------------------------------------------------------

pkg_version() {
  node -p "require('$ROOT/package.json').version" 2>/dev/null || echo "?"
}

repo_ready() {
  [ -d "$ROOT/node_modules" ] && [ -f "$STORAGE/opensync.db" ]
}

not_installed() {
  err "OpenSync is not installed yet."
  echo "  run the installer first:  curl -sSL <install-url> | bash"
  echo "  (or manually: cd \"$ROOT\" && npm install && npm run db:init)"
  exit 1
}

health_ok() { curl -fsS -m 2 "http://127.0.0.1:${1:-$DEFAULT_PORT}/api/health" >/dev/null 2>&1; }

lan_ips() {
  local out
  out=$(hostname -I 2>/dev/null | tr ' ' '\n' | sed '/^$/d')
  if [ -z "$out" ]; then
    out=$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1)
  fi
  [ -n "$out" ] || out=$(hostname 2>/dev/null)
  printf '%s\n' "$out"
}

first_ip() {
  local ip
  ip=$(lan_ips | sed -n '1p')
  printf '%s\n' "${ip:-127.0.0.1}"
}

url_for() { printf 'http://%s:%s' "$(first_ip)" "${1:-$DEFAULT_PORT}"; }

# ---- service state -----------------------------------------------------------
# Sets globals: STATE (active|starting|external|stale|down), PID, PORT.
service_state() {
  STATE=down; PID=""; PORT="$DEFAULT_PORT"
  if [ -f "$PIDFILE" ]; then
    PID=$(sed -n '1p' "$PIDFILE" 2>/dev/null || true)
    PORT=$(sed -n '2p' "$PIDFILE" 2>/dev/null || true)
    PORT="${PORT:-$DEFAULT_PORT}"
    if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
      if health_ok "$PORT"; then STATE=active; else STATE=starting; fi
    else
      STATE=stale
    fi
  elif health_ok "$PORT"; then
    STATE=external
  fi
  return 0
}

# ---- service management ------------------------------------------------------

cmd_start() {
  repo_ready || not_installed
  # capture the requested port BEFORE service_state — it overwrites the
  # global PORT with the pidfile/default port, which would silently ignore
  # the PORT env override and start on 3000.
  local port="${PORT:-$DEFAULT_PORT}"
  service_state
  if [ "$STATE" = active ]; then
    ok "opensync is already active (pid $PID) — $(url_for "$PORT")"
    return 0
  fi
  if health_ok "$port"; then
    err "something is already answering on port $port (health ok) — refusing to start."
    err "stop the other process first, or open the port."
    return 1
  fi
  if [ "$STATE" = stale ]; then
    warn "cleaning up stale pid file ($PIDFILE)"
    rm -f "$PIDFILE"
  fi

  mkdir -p "$STORAGE"
  info "starting opensync on port $port (log: $LOGFILE)"

  ( cd "$ROOT" && exec env PORT="$port" OPENSYNC_STORAGE="$STORAGE" node server/index.js ) >>"$LOGFILE" 2>&1 </dev/null &
  PID=$!
  echo "$PID" > "$PIDFILE"
  echo "$port" >> "$PIDFILE"

  local sp="" tries=0
  if is_tty 1; then
    ( while :; do for f in '◐' '◓' '◑' '◒'; do printf '\r%b[%s]%b waiting for server…' "$C_CYAN" "$f" "$C_RESET"; sleep 0.12; done; done ) 2>/dev/null &
    sp=$!
  fi
  while ! health_ok "$port"; do
    tries=$((tries + 1))
    if [ "$tries" -gt 40 ]; then
      kill "$sp" 2>/dev/null || true; wait "$sp" 2>/dev/null || true
      printf '\r\033[K'
      err "server did not come up on port $port (after ~20s)."
      tail -n 15 "$LOGFILE" 2>/dev/null | sed 's/^/    /'
      rm -f "$PIDFILE"
      return 1
    fi
    sleep 0.5
  done
  kill "$sp" 2>/dev/null || true
  wait "$sp" 2>/dev/null || true
  printf '\r\033[K'
  ok "opensync is ACTIVE (pid $PID) — $(url_for "$port")"
}

cmd_stop() {
  service_state
  case "$STATE" in
    down)
      info "opensync is not running"
      rm -f "$PIDFILE" 2>/dev/null || true
      return 0
      ;;
    external)
      err "opensync is running externally (no pid file) — I cannot stop it."
      return 1
      ;;
    stale)
      warn "stale pid file — removing"
      rm -f "$PIDFILE"
      return 0
      ;;
  esac

  info "stopping opensync (pid $PID)…"
  kill -TERM "$PID" 2>/dev/null || true
  local tries=0
  while kill -0 "$PID" 2>/dev/null; do
    tries=$((tries + 1))
    if [ "$tries" -gt 20 ]; then
      warn "still up after 5s — forcing kill"
      kill -KILL "$PID" 2>/dev/null || true
      sleep 0.3
      break
    fi
    sleep 0.25
  done
  rm -f "$PIDFILE"
  ok "opensync stopped"
}

cmd_restart() {
  cmd_stop
  cmd_start
}

cmd_status() {
  service_state
  case "$STATE" in
    active)   say "$C_GREEN"   "● opensync is ACTIVE    — $(url_for "$PORT")  (pid $PID)" ;;
    starting) say "$C_YELLOW"  "◐ opensync is STARTING  — $(url_for "$PORT")  (pid $PID)" ;;
    external) say "$C_CYAN"    "● opensync is RUNNING externally — $(url_for "$PORT")  (no pid file)" ;;
    stale)    say "$C_RED"     "○ opensync is DOWN       — stale pid $PID (run 'opensync start')" ;;
    down)     say "$C_RED"     "○ opensync is DOWN       — $(url_for) (run 'opensync start')" ;;
  esac
}

cmd_logs() {
  service_state
  if [ "$STATE" = down ] || [ "$STATE" = stale ]; then warn "opensync is down — log may be stale"; fi
  if [ ! -f "$LOGFILE" ]; then
    info "no log yet (server has never been started here)"
    return 0
  fi
  tail -n 50 -F "$LOGFILE"
}

cmd_update() {
  service_state
  local was_active=0
  [ "$STATE" = active ] && was_active=1
  run_spinner "updating repository (git pull)" -- git -C "$ROOT" pull --ff-only
  run_spinner "installing dependencies (npm install)" -- npm install --prefix "$ROOT"
  if [ "$was_active" = 1 ]; then
    info "restarting service…"
    cmd_stop
    cmd_start
  else
    ok "update done (server was not running)"
  fi
}

cmd_uninstall() {
  cmd_stop || true
  local link
  link=$(command -v opensync 2>/dev/null || true)
  if [ -n "$link" ]; then
    info "removing $link"
    if ! rm -f "$link" 2>/dev/null; then
      if prompt_yes_no "need root to remove $link — use sudo?" yes; then
        sudo rm -f "$link" || warn "could not remove $link"
      fi
    fi
  fi
  if prompt_yes_no "delete all stored data ($STORAGE)?" no; then
    rm -rf "$STORAGE"
  fi
  if prompt_yes_no "remove the install directory ($ROOT) too?" no; then
    if [ "$ROOT" = "/" ] || [ "$ROOT" = "$HOME" ] || [ ! -f "$ROOT/scripts/cli.sh" ]; then
      warn "refusing to remove '$ROOT' (does not look like an OpenSync install dir)"
    else
      info "removing $ROOT…"
      # the script is running from inside $ROOT — cd out first
      cd /
      rm -rf "$ROOT" || warn "could not remove $ROOT"
    fi
  fi
  ok "opensync uninstalled"
}

# ---- dashboard (interactive TUI) ---------------------------------------------

# Render the whole dashboard to stdout. Every line is truncated to the
# terminal width and ends with ESC[K (clear to EOL) so in-place redraws
# never leave residue on shorter lines.
render_screen() {
  STATE=down; PID=""; PORT="$DEFAULT_PORT"
  if command -v curl >/dev/null 2>&1; then service_state; fi

  local w out=""
  w=$(tput cols 2>/dev/null || echo 80)
  [ "$w" -ge 20 ] || w=80
  put()  { out+="${1:0:$w}$C_RESET"$'\033[K\n'; }
  cput() { out+="$1${2:0:$w}$C_RESET"$'\033[K\n'; }

  while IFS= read -r l; do put "$l"; done <<<"$(print_banner)"
  put ""
  cput "$C_BOLD" "  OpenSync CLI v$(pkg_version)  ·  node $(node -v 2>/dev/null || echo '?')  ·  npm $(npm -v 2>/dev/null || echo '?')"
  put "  ────────────────────────────────────────────────────────────────"

  case "$STATE" in
    active)   cput "$C_GREEN"  "  ● service    ACTIVE    $(url_for "$PORT")  (pid $PID)" ;;
    starting) cput "$C_YELLOW" "  ◐ service    STARTING  $(url_for "$PORT")  (pid $PID)" ;;
    external) cput "$C_CYAN"   "  ● service    RUNNING (external)  $(url_for "$PORT")" ;;
    stale)    cput "$C_RED"    "  ○ service    DOWN      stale pid $PID — press [s] to start" ;;
    down)     cput "$C_RED"    "  ○ service    DOWN      $(url_for "$PORT") — press [s] to start" ;;
  esac

  while IFS= read -r line; do put "$line"; done < <({
    printf '  port         %s\n' "$PORT"
    printf '  storage      %s\n' "$STORAGE"
    printf '  repo         %s\n' "$ROOT"
  })

  local admin_info=""
  if [ "$STATE" = active ] && command -v curl >/dev/null 2>&1; then
    admin_info=$(curl -fsS -m 2 "http://127.0.0.1:$PORT/api/info" 2>/dev/null || true)
    if [ -n "$admin_info" ]; then
      if printf '%s' "$admin_info" | grep -q '"has_admin":true'; then
        cput "$C_DIM" "  first admin   registered"
      else
        cput "$C_YELLOW" "  first admin   NOT registered — open the page and register (first user = admin)"
      fi
    fi
  fi

  if [ -f "$LOGFILE" ]; then
    put ""
    while IFS= read -r line; do put "$line"; done < <(tail -n 4 "$LOGFILE" 2>/dev/null | sed 's/^/  │ /')
  fi

  put ""
  cput "$C_BOLD" '  [s] start    [S] stop    [r] restart    [l] logs    [q] quit + stop'
  printf '%b' "$out"
}

restore_tty() {
  stty sane 2>/dev/null || true
  printf '\033[?25h\033[?1049l' 2>/dev/null || true
}

cmd_dashboard() {
  if ! interactive; then
    cmd_status
    return
  fi
  local key prev=""
  trap restore_tty EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  printf '\033[?1049h\033[?25l'
  # cbreak (not raw): keeps OPOST/ONLCR so \n still returns the cursor to
  # column 0 — raw mode made every dashboard line start where the previous
  # one ended (cumulative right-shift of the whole screen).
  stty -icanon -echo 2>/dev/null || true
  while :; do
    local screen
    screen=$(render_screen)
    if [ "$screen" != "$prev" ]; then
      printf '\033[H%b' "$screen"
      prev="$screen"
    fi
    if read -r -t 3 -n 1 key; then
      case "$key" in
        [qQ])
          cmd_stop >/dev/null 2>&1 || true
          break
          ;;
        [sS]|r)
          case "$key" in
            s) cmd_start >/dev/null 2>&1 || true ;;
            S) cmd_stop  >/dev/null 2>&1 || true ;;
            r) cmd_restart >/dev/null 2>&1 || true ;;
          esac
          prev=""
          ;;
        [lL])
          stty sane
          printf '\033[2J\033[H'
          # A no-op INT trap: Ctrl+C still kills `tail`, but the shell itself
          # would otherwise self-signal and exit (a cleared trap is not
          # enough — non-interactive bash re-raises SIGINT after the child
          # dies). Hold the no-op trap through the Enter read — the re-raise
          # is asynchronous, so restoring 'exit 130' early exits 130 when the
          # dashboard is supposed to continue.
          trap ':' INT
          cmd_logs || true
          printf '\npress enter to return to the dashboard\n'
          read -r _ || true
          stty -icanon -echo
          trap 'exit 130' INT
          prev=""
          ;;
      esac
    fi
  done
  restore_tty
}

# ---- entrypoint --------------------------------------------------------------

usage() {
  cat <<EOF
opensync — OpenSync CLI dashboard & service manager

  usage:  opensync [command]

  (no command)   dashboard (live status overview)
  start          start the server in the background
  stop           stop the server
  restart        restart the server
  status         one-shot service status (pipeline-friendly)
  logs           tail the server log
  update         git pull + npm install (+ restart if active)
  uninstall      stop the server and remove the command
  help           show this help
EOF
}

main() {
  local cmd="${1:-dashboard}"
  case "$cmd" in
    ""|dashboard) cmd_dashboard ;;
    start)    cmd_start ;;
    stop)     cmd_stop ;;
    restart)  cmd_restart ;;
    status)   cmd_status ;;
    logs)     cmd_logs ;;
    update)   cmd_update ;;
    uninstall) cmd_uninstall ;;
    help|-h|--help) usage ;;
    *) err "unknown command: $cmd"; usage; exit 1 ;;
  esac
}

main "$@"