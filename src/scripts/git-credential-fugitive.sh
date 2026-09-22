#!/bin/sh
# fugitive git credential helper — https://github.com/yurenju/fugitive
# Hands git an OAuth access token for this host. The first time, it registers itself as a tool, sends you to the
# Authorization Page in a browser and takes the code you paste back; after that it refreshes tokens on its own.
#   get | erase | store   called by git (stdin/stdout are git's credential protocol)
#   login                 sign in again now
#   logout                revoke this machine's tokens and forget them
# Needs only sh, curl and openssl.
set -u
ORIGIN='__ORIGIN__'
TTY=${FUGITIVE_TTY:-/dev/tty}

die() {
  echo "fugitive: $*" >&2
  exit 1
}

cmd=${1:-}
case "$cmd" in
get | erase)
  protocol= host=
  while IFS= read -r line; do
    [ -z "$line" ] && break
    case "$line" in
    protocol=*) protocol=${line#protocol=} ;;
    host=*) host=${line#host=} ;;
    esac
  done
  [ -n "$protocol" ] && [ -n "$host" ] && ORIGIN="$protocol://$host"
  ;;
login | logout) ;;
*) exit 0 ;; # store: the token lives in our own file, not with git
esac

dir="${XDG_CONFIG_HOME:-$HOME/.config}/fugitive"
# One file per host; a port (local tests) gets its own file.
file="$dir/$(printf '%s' "${ORIGIN#*://}" | tr ':/' '__')"
lock="$file.lock"
redirect="$ORIGIN/authorize/done"

field() { [ -f "$file" ] && sed -n "s/^$1=//p" "$file" | head -n 1; }
# A string or number field from a flat JSON object; no jq needed.
json() { printf '%s' "$2" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\{0,1\}\([^\",}]*\).*/\1/p" | head -n 1; }
now() { date +%s; }

save() { # client_id access_token expires_at refresh_token
  mkdir -p "$dir" && chmod 700 "$dir"
  (umask 077 && printf 'client_id=%s\naccess_token=%s\nexpires_at=%s\nrefresh_token=%s\n' "$1" "$2" "$3" "$4" >"$file.$$")
  mv "$file.$$" "$file"
}

save_tokens() { # client_id token-endpoint-response
  save "$1" "$(json access_token "$2")" "$(($(now) + $(json expires_in "$2")))" "$(json refresh_token "$2")"
}

fresh_token() { # the stored access token, if it has at least 60 seconds left
  at=$(field access_token) exp=$(field expires_at)
  [ -n "$at" ] && [ "${exp:-0}" -gt "$(($(now) + 60))" ] && printf '%s' "$at"
}

take_lock() {
  waited=0
  until mkdir "$lock" 2>/dev/null; do
    # A lock older than a minute belongs to a helper that died.
    if [ -n "$(find "$lock" -maxdepth 0 -mmin +1 2>/dev/null)" ]; then
      rmdir "$lock" 2>/dev/null
      continue
    fi
    waited=$((waited + 1))
    [ "$waited" -ge 30 ] && die "gave up waiting for $lock"
    sleep 1
  done
  trap 'rmdir "$lock" 2>/dev/null' EXIT
}

drop_lock() {
  rmdir "$lock" 2>/dev/null
  trap - EXIT
}

refresh() { # prints a new access token, or nothing when the refresh token is no good
  take_lock
  # Another helper may have refreshed while we waited; its refresh token replaced ours.
  at=$(fresh_token) || {
    client=$(field client_id)
    res=$(curl -sS -X POST "$ORIGIN/token" -d grant_type=refresh_token -d "client_id=$client" \
      --data-urlencode "refresh_token=$(field refresh_token)") || die "could not reach $ORIGIN"
    at=$(json access_token "$res")
    if [ -n "$at" ]; then
      save_tokens "$client" "$res"
    elif [ "$(json error "$res")" = invalid_grant ]; then
      save "$client" "" 0 "" # revoked, or unused for 90 days: sign in again
    else
      die "could not refresh the token: $res"
    fi
  }
  drop_lock
  printf '%s' "$at"
}

urlencode() { printf '%s' "$1" | sed 's/%/%25/g; s/:/%3A/g; s/\//%2F/g; s/?/%3F/g; s/&/%26/g; s/=/%3D/g'; }

login() { # prints the new access token
  # stdin and stdout belong to git, so talk to the person through the terminal.
  if [ -z "${FUGITIVE_TTY:-}" ] && ! (: </dev/tty) 2>/dev/null; then
    die "sign-in needed and there is no terminal; run '$0 login' in a terminal"
  fi
  client=$(field client_id)
  if [ -z "$client" ]; then
    name="git on $(hostname 2>/dev/null || uname -n)"
    res=$(curl -sS -X POST "$ORIGIN/register" -H 'Content-Type: application/json' \
      -d "{\"client_name\":\"$name\",\"redirect_uris\":[\"$redirect\"],\"token_endpoint_auth_method\":\"none\"}") ||
      die "could not reach $ORIGIN"
    client=$(json client_id "$res")
    [ -n "$client" ] || die "could not register with $ORIGIN: $res"
    save "$client" "" 0 ""
  fi
  verifier=$(openssl rand -base64 48 | tr -d '\n=' | tr '+/' '-_')
  challenge=$(printf '%s' "$verifier" | openssl dgst -sha256 -binary | openssl base64 -A | tr -d '=' | tr '+/' '-_')
  state=$(openssl rand -hex 16)
  url="$ORIGIN/authorize?response_type=code&client_id=$client&redirect_uri=$(urlencode "$redirect")&code_challenge=$challenge&code_challenge_method=S256&state=$state"

  for opener in xdg-open open start; do
    if command -v "$opener" >/dev/null 2>&1; then
      "$opener" "$url" >/dev/null 2>&1 &
      break
    fi
  done
  # One write, so a test reading the terminal from a FIFO gets it all at once.
  printf 'fugitive: sign in to %s in your browser:\n\n  %s\n\nThen paste the code from the last page here: ' "$ORIGIN" "$url" >"$TTY"
  IFS= read -r code <"$TTY" || die "no code entered"
  code=$(printf '%s' "$code" | tr -d '[:space:]')
  res=$(curl -sS -X POST "$ORIGIN/token" -d grant_type=authorization_code -d "client_id=$client" \
    --data-urlencode "code=$code" --data-urlencode "redirect_uri=$redirect" --data-urlencode "code_verifier=$verifier") ||
    die "could not reach $ORIGIN"
  [ -n "$(json access_token "$res")" ] || die "sign-in failed: $res"
  save_tokens "$client" "$res"
  field access_token
}

case "$cmd" in
get)
  at=$(fresh_token) || { [ -n "$(field refresh_token)" ] && at=$(refresh) && [ -n "$at" ]; } || at=$(login) || exit 1
  echo "username=fugitive"
  echo "password=$at"
  ;;
erase)
  # The server turned the access token down: drop it, keep the refresh token.
  [ -f "$file" ] && save "$(field client_id)" "" 0 "$(field refresh_token)"
  ;;
login)
  [ -f "$file" ] && save "$(field client_id)" "" 0 ""
  login >/dev/null && echo "fugitive: signed in to $ORIGIN"
  ;;
logout)
  rt=$(field refresh_token)
  if [ -n "$rt" ]; then
    # Revoking the refresh token revokes this machine's whole grant (RFC 7009 at the token endpoint).
    curl -sS -X POST "$ORIGIN/token" -d token_type_hint=refresh_token -d "client_id=$(field client_id)" \
      --data-urlencode "token=$rt" >/dev/null || die "could not reach $ORIGIN"
  fi
  rm -f "$file"
  echo "fugitive: signed out of $ORIGIN"
  ;;
esac
