#!/usr/bin/env bash
# OpenSync shared bash helpers — sourced by scripts/cli.sh.
# Keep install.sh's embedded copies in sync if you change anything here.

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET='\033[0m'
  C_BOLD='\033[1m'
  C_DIM='\033[2m'
  C_GREEN='\033[32m'
  C_RED='\033[31m'
  C_YELLOW='\033[33m'
  C_CYAN='\033[36m'
  C_MAGENTA='\033[35m'
else
  C_RESET=''; C_BOLD=''; C_DIM=''; C_GREEN=''; C_RED=''; C_YELLOW=''; C_CYAN=''; C_MAGENTA=''
fi

# is_tty [fd] — is the given fd (default stdout) a terminal?
is_tty() { [ -t "${1:-1}" ]; }

# interactive — stdin AND stdout are real terminals (safe for raw-mode TUI).
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

# run_spinner <label> -- <cmd...>
# Runs cmd with an animated spinner; output is captured and only shown on
# failure. Prints ✓/✗ (tty) or ok/failed (piped) with elapsed seconds.
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

# sanitize_input <str> — strip ANSI escape sequences (arrow keys pressed while
# a prompt is pending leak ESC[…] bytes into canonical-mode reads) and trim
# surrounding whitespace.
sanitize_input() {
  local s="$1"
  s=$(printf '%s' "$s" | LC_ALL=C sed $'s/\033\[[0-9;]*[a-zA-Z]//g')
  s=${s#"${s%%[![:space:]]*}"}
  s=${s%"${s##*[![:space:]]}"}
  printf '%s' "$s"
}

# prompt_yes_no <question> [default: yes|no]
# Reads from the terminal when possible (stdin, else /dev/tty — curl|bash
# safe); falls back to the default when no console is available. Input is
# sanitized; 'y'/'s' (sì) = yes, 'n' = no, empty = default; anything else
# re-asks (max 3 tries, then the default wins).
# NOTE: `read -p` writes the prompt to stderr — the /dev/tty branch must
# print the prompt with printf >/dev/tty first, or it stays invisible under
# `curl … | bash` (stdin is a pipe, so the /dev/tty branch is always taken).
prompt_yes_no() {
  local question="$1" default="${2:-yes}" input tries=0 suffix
  [ "$default" = yes ] && suffix="[Y/n]" || suffix="[y/N]"
  while :; do
    if is_tty 0; then
      read -r -p "$question $suffix: " input || { echo; return 1; }
    elif can_read_tty; then
      printf '%s' "$question $suffix: " >/dev/tty 2>/dev/null
      read -r input </dev/tty 2>/dev/null || { printf '\n' >/dev/tty 2>/dev/null; return 1; }
    else
      [ "$default" = "yes" ]
      return
    fi
    input=$(sanitize_input "$input")
    case "$input" in
      "") [ "$default" = yes ] && return 0 || return 1 ;;
      [yYsS]*) return 0 ;;
      [nN]*) return 1 ;;
    esac
    tries=$((tries + 1))
    if [ "$tries" -ge 3 ]; then
      warn "invalid answer — using default ($default)"
      [ "$default" = yes ] && return 0 || return 1
    else
      warn "please answer y or n — try again"
    fi
  done
}

# print_banner — figlet-style OpenSync ASCII art.
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
