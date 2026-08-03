#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  OpenSync installer
#
#  usage:  curl -sSL <install-url> | bash
#          bash install.sh
#
#  Shows the OpenSync banner, checks dependencies (installing what's missing,
#  with your approval), asks where to install, clones the repository, runs
#  npm install + db:init, registers the `opensync` command system-wide,
#  and optionally starts the server.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/piskevalee-cpu/OpenSync.git}"
REPO_DIR="${REPO_DIR:-OpenSync}"
MIN_NODE_MAJOR=22
SYSTEM_BIN="/usr/local/bin"
USER_BIN="$HOME/.local/bin"

# ---- color + output helpers (self-contained; keep in sync with scripts/lib.sh)
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET='\033[0m'; C_BOLD='\033[1m'; C_DIM='\033[2m'
  C_GREEN='\033[32m'; C_RED='\033[31m'; C_YELLOW='\033[33m'; C_CYAN='\033[36m'; C_MAGENTA='\033[35m'
else
  C_RESET=''; C_BOLD=''; C_DIM=''; C_GREEN=''; C_RED=''; C_YELLOW=''; C_CYAN=''; C_MAGENTA=''
fi

is_tty() { [ -t "${1:-1}" ]; }
interactive() { [ -t 0 ] && [ -t 1 ]; }

# can_read_tty — a controlling terminal is available for prompts
# (true even when stdin is a pipe, e.g. `curl … | bash` in a terminal).
# Probe by opening /dev/tty and checking it's a terminal — never block
# or consume input (a `read -t` probe would time out → false, killing
# every interactive prompt under `curl … | bash`).
can_read_tty() {
  [ -e /dev/tty ] || return 1
  local ok=1
  if { exec 3</dev/tty; } 2>/dev/null && [ -t 3 ]; then
    ok=0
  fi
  exec 3<&- 2>/dev/null || true
  return "$ok"
}

say() { printf '%b%s%b\n' "$1" "$2" "$C_RESET"; }
info() { say "$C_CYAN"   "[*] $*"; }
ok()   { say "$C_GREEN"  "[+] $*"; }
warn() { say "$C_YELLOW" "[!] $*"; }
err()  { say "$C_RED"    "[-] $*"; }

run_spinner() {
  local label="$1" code=0 start=$SECONDS out sp f
  shift; [ "${1:-}" = "--" ] && shift
  out=$(mktemp)
  if is_tty 1; then
    ( while :; do for f in '◐' '◓' '◑' '◒'; do printf '\r%b[%s]%b %s' "$C_CYAN" "$f" "$C_RESET" "$label"; sleep 0.12; done; done ) 2>/dev/null &
    sp=$!
    ( "$@" ) >"$out" 2>&1 || code=$?
    kill "$sp" 2>/dev/null || true
    wait "$sp" 2>/dev/null || true
    if [ "$code" -eq 0 ]; then
      printf '\r%b[✓]%b %s (%ss)\n' "$C_GREEN" "$C_RESET" "$label" "$((SECONDS - start))"
    else
      printf '\r%b[✗]%b %s (%ss)\n' "$C_RED" "$C_RESET" "$label" "$((SECONDS - start))"
    fi
  else
    printf '[ ] %s … ' "$label"
    ( "$@" ) >"$out" 2>&1 || code=$?
    if [ "$code" -eq 0 ]; then printf 'ok\n'; else printf 'failed\n'; fi
  fi
  if [ "$code" -ne 0 ]; then
    sed -n '1,30p' "$out" 2>/dev/null | sed 's/^/    /'
  fi
  rm -f "$out"
  return "$code"
}

prompt_yes_no() {
  local question="$1" default="${2:-yes}" input
  if is_tty 0; then
    read -r -p "$question [Y/n]: " input || { echo; return 1; }
  elif can_read_tty; then
    read -r -p "$question [Y/n]: " input </dev/tty 2>/dev/null || { echo; return 1; }
  else
    [ "$default" = "yes" ]
    return
  fi
  case "$input" in
    "") [ "$default" = yes ] && return 0 || return 1 ;;
    [yY]*) return 0 ;;
    [nN]*) return 1 ;;
  esac
}

prompt_input() {
  local prompt="$1" default="${2:-}" input
  if is_tty 0; then
    read -r -p "$prompt" input || return 1
  elif can_read_tty; then
    read -r -p "$prompt" input </dev/tty 2>/dev/null || return 1
  else
    input="$default"
    return 0
  fi
  printf '%s' "$input"
}

print_banner() {
  local art
  art=$(cat <<'BANNER'

 ▄██████▄     ▄███████▄    ▄████████ ███▄▄▄▄      ▄████████ ▄██   ▄   ███▄▄▄▄    ▄████████
███    ███   ███    ███   ███    ███ ███▀▀▀██▄   ███    ███ ███   ██▄ ███▀▀▀██▄ ███    ███
███    ███   ███    ███   ███    █▀  ███   ███   ███    █▀  ███▄▄▄███ ███   ███ ███    █▀
███    ███   ███    ███  ▄███▄▄▄     ███   ███   ███        ▀▀▀▀▀▀███ ███   ███ ███
███    ███ ▀█████████▀  ▀▀███▀▀▀     ███   ███ ▀███████████ ▄██   ███ ███   ███ ███
███    ███   ███          ███    █▄  ███   ███          ███ ███   ███ ███   ███ ███    █▄
███    ███   ███          ███    ███ ███   ███    ▄█    ███ ███   ███ ███   ███ ███    ███
 ▀██████▀   ▄████▀        ██████████  ▀█   █▀   ▄████████▀   ▀█████▀   ▀█   █▀  ████████▀
BANNER
)
  say "$C_GREEN" "$art"
}

# ── 0. intro ──────────────────────────────────────────────────────────────────
print_banner
say "$C_BOLD" "$(printf '%s\n' \
  '  Install OpenSync on this machine.' \
  '  Checks dependencies, asks where to install, clones the repository,' \
  '  initializes the database and registers your `opensync` command.')"

# ── 1. dependencies ──────────────────────────────────────────────────────────
# check_dep <name> <probe-cmd> <hint-text>
# Returns 0 if present. Prints spinner while probing; on failure proposes
# an installation and retries.
check_dep() {
  local name="$1" probe="$2" hint="${3:-}"
  if run_spinner "checking $name" -- sh -c "$probe"; then
    ok "$name found"
    return 0
  fi
  warn "$name is missing${hint:+ — $hint}"
  if prompt_yes_no "install $name now?" yes; then
    install_dep "$name" || exit 1
  else
    err "$name is required. exiting."
    exit 1
  fi
}

install_dep() {
  case "$1" in
    curl)
      install_pkg curl curl
      ;;
    git)
      install_pkg git git
      ;;
    node)
      install_node
      ;;
  esac
}

detect_pkg_manager() {
  if command -v apt-get >/dev/null 2>&1; then echo "apt"
  elif command -v dnf >/dev/null 2>&1; then echo "dnf"
  elif command -v yum >/dev/null 2>&1; then echo "yum"
  elif command -v pacman >/dev/null 2>&1; then echo "pacman"
  elif command -v brew >/dev/null 2>&1; then echo "brew"
  else echo "unknown"; fi
}

install_pkg() {
  local pm pkg="$1" desc="${2:-$1}"
  pm=$(detect_pkg_manager)
  info "installing $desc ($pkg) via $pm…"
  case "$pm" in
    apt)    run_spinner "installing $desc" -- sh -c "sudo apt-get update -qq && sudo apt-get install -y $pkg" ;;
    dnf)    run_spinner "installing $desc" -- sh -c "sudo dnf install -y $pkg" ;;
    yum)    run_spinner "installing $desc" -- sh -c "sudo yum install -y $pkg" ;;
    pacman) run_spinner "installing $desc" -- sh -c "sudo pacman -Sy --noconfirm $pkg" ;;
    brew)   run_spinner "installing $desc" -- brew install "$pkg" ;;
    *)      err "unsupported package manager — install $pkg manually."; return 1 ;;
  esac
}

install_node() {
  if [ -s "$HOME/.nvm/nvm.sh" ] || command -v nvm >/dev/null 2>&1; then
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
    info "installing Node.js $MIN_NODE_MAJOR via nvm…"
    run_spinner "nvm install $MIN_NODE_MAJOR" -- nvm install "$MIN_NODE_MAJOR"
    nvm use "$MIN_NODE_MAJOR" >/dev/null 2>&1 || true
    [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
    return 0
  fi

  local pm
  pm=$(detect_pkg_manager)
  info "installing Node.js $MIN_NODE_MAJOR via the system package manager ($pm)…"
  case "$pm" in
    apt)
      run_spinner "adding NodeSource repository" -- sh -c "curl -fsSL https://deb.nodesource.com/setup_${MIN_NODE_MAJOR}.x | sudo -E bash -"
      run_spinner "installing nodejs via apt" -- sudo apt-get install -y nodejs
      ;;
    dnf)
      run_spinner "adding NodeSource repository" -- sh -c "curl -fsSL https://rpm.nodesource.com/setup_${MIN_NODE_MAJOR}.x | sudo -E bash -"
      run_spinner "installing nodejs via dnf" -- sudo dnf install -y nodejs
      ;;
    yum)
      run_spinner "adding NodeSource repository" -- sh -c "curl -fsSL https://rpm.nodesource.com/setup_${MIN_NODE_MAJOR}.x | sudo -E bash -"
      run_spinner "installing nodejs via yum" -- sudo yum install -y nodejs
      ;;
    pacman)
      run_spinner "installing nodejs via pacman" -- sudo pacman -Sy --noconfirm nodejs npm
      ;;
    brew)
      run_spinner "installing node@22 via brew" -- brew install node@22
      ;;
    *)
      err "no supported package manager found — install Node.js 22+ manually: https://nodejs.org/"
      exit 1
      ;;
  esac
}

check_deps() {
  echo
  info "checking dependencies…"

  if (( BASH_VERSINFO[0] < 4 )); then
    err "bash ${BASH_VERSION} is too old — OpenSync requires bash >= 4."
    exit 1
  fi
  ok "bash ${BASH_VERSION}"

  check_dep "curl" "command -v curl" "used to fetch this installer and to health-check the server"
  check_dep "git"  "command -v git"  "needed to clone and update the repository"

  local node_ok=false node_ver=""
  if command -v node >/dev/null 2>&1; then
    node_ver=$(node -v | sed 's/^v//')
    local major
    major=$(printf '%s' "$node_ver" | cut -d. -f1)
    if [ "$major" -ge "$MIN_NODE_MAJOR" ]; then
      node_ok=true
      ok "node found: v$node_ver"
    else
      warn "node found but v$node_ver — at least v${MIN_NODE_MAJOR} is required"
    fi
  else
    warn "node is missing"
  fi
  if [ "$node_ok" != true ]; then
    if prompt_yes_no "install/update Node.js ${MIN_NODE_MAJOR}+ now?" yes; then
      install_dep node || exit 1
    else
      err "Node.js ${MIN_NODE_MAJOR}+ is required. exiting."
      exit 1
    fi
  fi

  if command -v npm >/dev/null 2>&1; then
    ok "npm found: $(npm -v)"
  else
    err "npm is missing even though Node.js is installed. exiting."
    exit 1
  fi
}

# ── 2. install location ───────────────────────────────────────────────────────
# Asks where the repo should live: home (default), current directory, custom.
# Prompts via stdin, falling back to /dev/tty (curl … | bash safe); silently
# defaults to $HOME when no terminal is available at all.
choose_clone_dir() {
  local choice="" custom=""
  if is_tty 0 || can_read_tty; then
    echo
    info "where should OpenSync be installed?"
    echo "  1) $HOME/$REPO_DIR          (home — default)"
    echo "  2) $PWD/$REPO_DIR           (current directory)"
    echo "  3) custom location"
    while :; do
      choice=$(prompt_input "  choice [1]: ")
      [ -z "$choice" ] && choice=1
      case "$choice" in
        1) INSTALL_BASE="$HOME"; break ;;
        2) INSTALL_BASE="$PWD"; break ;;
        3)
          custom=$(prompt_input "  full path (e.g. /srv/opensync): ")
          if [ -n "$custom" ]; then
            if mkdir -p "$custom" 2>/dev/null; then
              INSTALL_BASE="$custom"
              break
            fi
            warn "cannot create '$custom' — try again"
          fi
          ;;
        *) warn "invalid choice '$choice' — pick 1, 2 or 3" ;;
      esac
    done
  else
    INSTALL_BASE="$HOME"
  fi
  INSTALL_DIR="$INSTALL_BASE/$REPO_DIR"
}

# ── 3. clone ──────────────────────────────────────────────────────────────────
clone_repo() {
  echo
  if [ -d "$INSTALL_DIR" ]; then
    warn "'$INSTALL_DIR' already exists — reusing it."
    cd "$INSTALL_DIR"
    if [ -d .git ]; then
      run_spinner "updating repository (git pull)" -- git pull --ff-only
    fi
  else
    run_spinner "cloning OpenSync into $INSTALL_DIR" -- git clone "$REPO_URL" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
  fi
}

# ── 4. npm install + db init ──────────────────────────────────────────────────
setup_runtime() {
  echo
  run_spinner "installing dependencies (npm install)" -- npm install
  run_spinner "initializing database (npm run db:init)" -- npm run db:init
}

# ── 5. register the `opensync` command ────────────────────────────────────────
install_command() {
  echo
  local target="$(pwd)/scripts/cli.sh" dest
  chmod +x "$target"
  if [ -w "$SYSTEM_BIN" ] && ln -sf "$target" "$SYSTEM_BIN/opensync" 2>/dev/null; then
    dest="$SYSTEM_BIN/opensync"
    ok "installed 'opensync' → $dest"
    return 0
  fi
  mkdir -p "$USER_BIN"
  dest="$USER_BIN/opensync"
  ln -sf "$target" "$dest"
  ok "installed 'opensync' → $dest"
  case ":$PATH:" in
    *":$USER_BIN:"*) ;;
    *) warn "'$USER_BIN' is not on your PATH."
       echo "  add this to your shell profile (~/.bashrc):"
       say "$C_CYAN" "  export PATH=\"$USER_BIN:\$PATH\"" ;;
  esac
}

# ── 6. optional server start + summary ───────────────────────────────────────
start_server() {
  echo
  if prompt_yes_no "start OpenSync now?" yes; then
    local bin=""
    for c in /usr/local/bin/opensync "$HOME/.local/bin/opensync" "$(command -v opensync 2>/dev/null || true)"; do
      if [ -n "$c" ] && [ -x "$c" ]; then bin="$c"; break; fi
    done
    if [ -n "$bin" ]; then
      info "launching 'opensync start'…"
      "$bin" start || true
    else
      warn "'opensync' not found on PATH — start it manually from the install dir:"
      say "$C_CYAN" "  cd $INSTALL_DIR && ./scripts/cli.sh start"
    fi
  else
    ok "no problem — OpenSync is installed and ready."
    echo "  you can start the server anytime, from anywhere, by running:"
    say "$C_GREEN" "      opensync"
  fi
}

summary() {
  printf '%s\n' "────────────────────────────────────────────────────────────────────────────"
  ok "OpenSync installed!"
  echo
  echo "  install dir : $INSTALL_DIR"
  echo "  what's next :"
  echo "    opensync            → live dashboard (status, start, stop, logs)"
  echo "    opensync start      → start the server in the background"
  echo "    opensync status     → one-shot status (pipeline-friendly)"
  echo "    opensync logs       → tail the server log"
  echo "    opensync update     → git pull + npm install (auto-restart)"
  echo "    opensync uninstall  → remove the command (+ optionally your data)"
  echo
  local ip port
  ip=$(hostname -I 2>/dev/null | awk '{print $1}')
  [ -n "$ip" ] || ip=$(hostname)
  port="${PORT:-3000}"
  echo "  your instance will be served at:"
  say "$C_GREEN" "      http://$ip:$port"
  echo "  open it and register — the FIRST user becomes the admin."
}

# ── run ───────────────────────────────────────────────────────────────────────
check_deps
choose_clone_dir
clone_repo
setup_runtime
install_command
start_server
summary