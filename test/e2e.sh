#!/usr/bin/env bash
# End-to-end tests: start a local wrangler dev and run the acceptance list with real git and the real helper.
# The script plays the person at the keyboard: the helper's terminal is a FIFO (FUGITIVE_TTY), the script reads the
# sign-in URL from it, walks the Authorization Page with curl, reads the Verification Code from a fake Resend, and
# writes the code from /authorize/done back into the FIFO.
# Usage: test/e2e.sh (needs git, curl, openssl, node)
set -euo pipefail

PORT=${PORT:-8791}
MAIL_PORT=${MAIL_PORT:-8792}
ORIGIN="http://127.0.0.1:$PORT"
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
LOG="$WORK/wrangler.log"
MAIL="$WORK/mail.log"
pass=0

cleanup() {
  # wrangler runs workerd underneath, so stop the whole process group.
  [ -n "${SERVER:-}" ] && kill -- "-$SERVER" 2>/dev/null || true
  [ -n "${RESEND:-}" ] && kill "$RESEND" 2>/dev/null || true
  wait 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() {
  echo "not ok - $*" >&2
  echo "--- wrangler log (tail) ---" >&2
  tail -n 40 "$LOG" >&2 || true
  exit 1
}
ok() {
  pass=$((pass + 1))
  echo "ok $pass - $*"
}

# ---- start the fake Resend and the server ----
if curl -s -o /dev/null "$ORIGIN/"; then
  echo "port $PORT is already in use; set PORT to another value" >&2
  exit 1
fi
: >"$MAIL"
node "$ROOT/test/fake-resend.mjs" "$MAIL_PORT" "$MAIL" &
RESEND=$!
(cd "$ROOT" && exec setsid npx wrangler dev --ip 127.0.0.1 --port "$PORT" --persist-to "$WORK/state" \
  --var "RESEND_API_URL:http://127.0.0.1:$MAIL_PORT" --var "RESEND_API_KEY:e2e-key" \
  --var "EMAIL_FROM:fugitive <noreply@fugitive.test>" --var "SESSION_SECRET:e2e-secret" \
  --var "REGISTRATION_ALLOWLIST:tester@example.com,second@example.com" >"$LOG" 2>&1) &
SERVER=$!
for _ in $(seq 1 120); do
  curl -fs "$ORIGIN/install.sh" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fs "$ORIGIN/install.sh" >/dev/null || fail "wrangler dev did not start"

# ---- playing the person at the keyboard ----
field_in() { sed -n "s/.*name=\"$1\" value=\"\([^\"]*\)\".*/\1/p" | head -n 1; }
latest_code() { grep "^$1 " "$MAIL" | tail -n 1 | cut -d' ' -f2; }
# The server mails an address at most once a minute, so wait out the rest of that minute before asking again.
request_code() { # request_code <url of a page with the email step> <email>
  local stamp="$WORK/sent-$2" left
  if [ -f "$stamp" ]; then
    left=$(($(cat "$stamp") + 61 - $(date +%s)))
    [ "$left" -gt 0 ] && sleep "$left"
  fi
  curl -fsS -d step=email --data-urlencode "email=$2" "$1" >/dev/null
  date +%s >"$stamp"
}

# Walk the Authorization Page for an /authorize URL; print the code /authorize/done shows.
# approve <url> <email> [name, for a new User] [extra form field for the approve step]
approve() {
  local url=$1 email=$2 name=${3:-} extra=${4:-step=approve} action ticket done_url
  action=${url#"$ORIGIN"}
  curl -fsS "$ORIGIN$action" >/dev/null
  request_code "$ORIGIN$action" "$email"
  local form=(-d step=code --data-urlencode "email=$email" -d "code=$(latest_code "$email")")
  [ -n "$name" ] && form+=(-d "name=$name")
  ticket=$(curl -fsS "${form[@]}" "$ORIGIN$action" | field_in ticket)
  [ -n "$ticket" ] || return 1
  done_url=$(curl -fsS -o /dev/null -w '%{redirect_url}' -d step=approve -d decision=approve -d "$extra" \
    --data-urlencode "ticket=$ticket" "$ORIGIN$action")
  curl -fsS "$done_url" | sed -n 's/.*<div class="code">\([^<]*\)<\/div>.*/\1/p'
}

# The helper's terminal. `sign_in` answers one sign-in prompt in the background.
TTY_FIFO="$WORK/tty"
mkfifo "$TTY_FIFO"
export FUGITIVE_TTY="$TTY_FIFO"
sign_in() { # sign_in <email> [name]
  (
    prompt=$(cat "$TTY_FIFO")
    url=$(printf '%s\n' "$prompt" | grep -o "$ORIGIN/authorize?[^ ]*" | head -n 1)
    code=$(approve "$url" "$@") || code=failed
    printf '%s\n' "$code" >"$TTY_FIFO"
  ) &
  SIGN_IN=$!
}

# ---- the user's machine: its own HOME, no stage 1 key ----
export HOME="$WORK/home"
mkdir -p "$HOME"
# CI runners set these; the helper and installer would then write outside this HOME.
unset XDG_CONFIG_HOME XDG_DATA_HOME
export GIT_TERMINAL_PROMPT=0
git config --global user.name Tester
git config --global user.email tester@example.com
git config --global init.defaultBranch main
git config --global advice.detachedHead false
git config --global fugitive.key "$HOME/.ssh/id_ed25519" # stage 1's setting; the installer removes it

curl -fsSL "$ORIGIN/install.sh" | sh >/dev/null
git config --global --get-all "credential.$ORIGIN.helper" | grep -q git-credential-fugitive || fail "installer did not configure helper"
! git config --global --get fugitive.key >/dev/null || fail "installer left fugitive.key behind"
ok "install.sh sets up the credential helper and drops stage 1's key setting"

helper="$HOME/.local/share/fugitive/git-credential-fugitive"
TOKENS="$HOME/.config/fugitive/127.0.0.1_$PORT"
cd "$WORK"
R="$ORIGIN/@tester"

commit() { # commit <dir> <file> <content>
  printf '%s\n' "$3" >"$1/$2"
  git -C "$1" add "$2"
  git -C "$1" commit -qm "$2: $3"
}

# 1. first use: the helper registers, the browser part is done by `approve`, the clone goes on by itself
sign_in tester@example.com tester
if git clone -q "$R/missing.git" missing 2>"$WORK/missing.err"; then fail "clone of a missing repository succeeded"; fi
wait "$SIGN_IN"
grep -q "not found" "$WORK/missing.err" || fail "clone of a missing repository did not say not found: $(cat "$WORK/missing.err")"
[ "$(stat -c %a "$TOKENS" 2>/dev/null || stat -f %Lp "$TOKENS")" = 600 ] || fail "token file is not private"
grep -q '^refresh_token=.' "$TOKENS" || fail "no refresh token saved"
ok "first sign-in through the helper (FIFO terminal); clone of a missing repository says not found"

# 2. push a new branch, clone it, fsck passes and content matches
git init -q src
for i in 1 2 3; do commit src "file$i.txt" "hello $i"; done
mkdir -p src/dir/sub && commit src dir/sub/nested.txt nested
git -C src tag -a v1 -m "version 1"
git -C src remote add origin "$R/project.git"
git -C src push -q origin main v1 || fail "first push"
git clone -q "$R/project.git" clone1 || fail "clone after push"
git -C clone1 fsck --strict --no-progress || fail "fsck of clone"
[ "$(git -C clone1 rev-parse HEAD)" = "$(git -C src rev-parse HEAD)" ] || fail "clone HEAD differs"
[ "$(git -C clone1 rev-parse v1^{})" = "$(git -C src rev-parse v1^{})" ] || fail "annotated tag missing"
[ "$(git -C clone1 symbolic-ref HEAD)" = refs/heads/main ] || fail "clone did not check out main"
ok "push a new branch and clone it back (fsck, content, tag, HEAD)"

# the same with protocol v0
git -c protocol.version=0 clone -q "$R/project.git" clone-v0 || fail "clone with protocol v0"
git -C clone-v0 fsck --strict --no-progress || fail "fsck of v0 clone"
[ "$(git -C clone-v0 rev-parse HEAD)" = "$(git -C src rev-parse HEAD)" ] || fail "v0 clone HEAD differs"
ok "clone with protocol v0"

# 3. incremental push, fetched on the other side (v2 and v0)
commit src file1.txt "changed"
git -C src push -q origin main || fail "incremental push"
git -C clone1 fetch -q origin || fail "incremental fetch"
[ "$(git -C clone1 rev-parse origin/main)" = "$(git -C src rev-parse main)" ] || fail "fetch did not see new commit"
git -C clone-v0 -c protocol.version=0 fetch -q origin || fail "incremental fetch v0"
[ "$(git -C clone-v0 rev-parse origin/main)" = "$(git -C src rev-parse main)" ] || fail "v0 fetch did not see new commit"
git -C clone1 fsck --strict --no-progress || fail "fsck after fetch"
ok "incremental push and fetch"

# 4. force push
git -C src commit -q --amend -m "rewritten"
git -C src push -q -f origin main || fail "force push"
[ "$(git ls-remote "$R/project.git" refs/heads/main | cut -f1)" = "$(git -C src rev-parse main)" ] || fail "force push not applied"
ok "force push"

# 5. delete a branch
git -C src push -q origin main:refs/heads/feature || fail "push feature"
git -C src push -q origin --delete feature || fail "delete branch"
[ -z "$(git ls-remote "$R/project.git" refs/heads/feature)" ] || fail "branch still there"
ok "delete a branch"

# 6. atomic: one ref rejected, none move
git -C src push -q origin main:refs/heads/a main:refs/heads/b || fail "push a and b"
git -C src push -q --atomic origin main:refs/heads/a main:refs/heads/c || fail "atomic push"
commit src extra.txt "for a"
git -C src branch -q stale HEAD~2
before=$(git ls-remote "$R/project.git")
if git -C src push -q --atomic origin main:refs/heads/a stale:refs/heads/b 2>/dev/null; then fail "atomic push with a rejected ref succeeded"; fi
[ "$before" = "$(git ls-remote "$R/project.git")" ] || fail "atomic push changed refs"
ok "atomic push: all or nothing"

# 7. two concurrent pushes to one branch, only one wins
git clone -q "$R/project.git" racer1 && git clone -q "$R/project.git" racer2
commit racer1 race.txt one && commit racer2 race.txt two
(if git -C racer1 push -q origin main 2>"$WORK/race1.err"; then echo 0; else echo 1; fi >"$WORK/race1") &
p1=$!
(if git -C racer2 push -q origin main 2>"$WORK/race2.err"; then echo 0; else echo 1; fi >"$WORK/race2") &
p2=$!
wait "$p1" "$p2"
r1=$(cat "$WORK/race1") r2=$(cat "$WORK/race2")
[ $((r1 == 0)) -ne $((r2 == 0)) ] || fail "concurrent pushes: expected exactly one success (got $r1, $r2)"
grep -qE "fetch first|rejected" "$WORK/race1.err" "$WORK/race2.err" || fail "loser got no clear rejection"
ok "concurrent pushes to one branch: exactly one wins"

# 8. shallow clone, then restore history
git -C src pull -q --rebase origin main 2>/dev/null || true
git -C src push -q origin main
total=$(git -C src rev-list --count main)
git clone -q --depth 1 "$R/project.git" shallow || fail "shallow clone"
[ "$(git -C shallow rev-list --count HEAD)" = 1 ] || fail "depth 1 has more than one commit"
git -C shallow fetch -q --deepen 1 || fail "deepen"
[ "$(git -C shallow rev-list --count HEAD)" = 2 ] || fail "deepen by 1 did not give 2 commits"
git -C shallow fetch -q --unshallow || fail "unshallow"
[ "$(git -C shallow rev-list --count HEAD)" = "$total" ] || fail "unshallow did not restore history"
git -C shallow fsck --strict --no-progress || fail "fsck after unshallow"
git -c protocol.version=0 clone -q --depth 1 "$R/project.git" shallow-v0 || fail "shallow clone v0"
[ "$(git -C shallow-v0 rev-list --count HEAD)" = 1 ] || fail "v0 depth 1 has more than one commit"
git -C shallow-v0 -c protocol.version=0 fetch -q --unshallow || fail "unshallow v0"
[ "$(git -C shallow-v0 rev-list --count HEAD)" = "$total" ] || fail "v0 unshallow did not restore history"
git clone -q --depth 1 "$R/project.git" shallow-push || fail "shallow clone for push"
commit shallow-push shallow.txt "from a shallow clone"
git -C shallow-push push -q origin main || fail "push from a shallow clone"
ok "shallow clone, deepen, unshallow (v2 and v0), push from a shallow clone"

# 9. a ~50 MB push (stored in R2)
git init -q big
for i in $(seq 1 10); do head -c 5000000 /dev/urandom >"big/blob$i.bin"; done
git -C big add . && git -C big commit -qm big
git -C big push -q "$R/big.git" main || fail "50 MB push"
git clone -q "$R/big.git" big-clone || fail "clone big repository"
git -C big-clone fsck --strict --no-progress || fail "fsck of big clone"
[ "$(git -C big-clone rev-parse HEAD^{tree})" = "$(git -C big rev-parse HEAD^{tree})" ] || fail "big clone differs"
# thin pack: the new delta's base is a blob stored in R2
head -c 100 /dev/urandom >>big/blob1.bin
git -C big commit -qam "append to blob1"
git -C big push -q "$R/big.git" main || fail "thin push on top of R2 pack"
git -C big-clone pull -q --ff-only || fail "fetch after thin push"
git -C big-clone fsck --strict --no-progress || fail "fsck after thin push"
ok "~50 MB push and clone, then a thin push on top"

# 10. a push that fails leaves an empty Repository, which clones as empty
at=$(sed -n 's/^access_token=//p' "$TOKENS")
printf '0000' | curl -s -o /dev/null -u "fugitive:$at" -H 'Content-Type: application/x-git-receive-pack-request' \
  --data-binary @- "$R/leftover.git/git-receive-pack"
git clone -q "$R/leftover.git" leftover 2>/dev/null || fail "clone of the empty leftover repository"
[ -z "$(git -C leftover rev-parse --all)" ] || fail "leftover clone has refs"
ok "a failed push leaves an empty repository that clones as empty"

# 11. no helper, a bad token, or the wrong owner: rejected
if git -c credential.helper= clone -q "$R/project.git" nohelper 2>/dev/null; then fail "clone without helper succeeded"; fi
bad="!f() { echo username=x; echo password=a:b:c; }; f"
if git -c "credential.$ORIGIN.helper=" -c "credential.$ORIGIN.helper=$bad" clone -q "$R/project.git" badtoken 2>/dev/null; then
  fail "clone with a bad token succeeded"
fi
code=$(curl -s -o /dev/null -w '%{http_code}' -u "fugitive:$(sed -n 's/^access_token=//p' "$TOKENS")" \
  "$ORIGIN/@someone-else/project.git/info/refs?service=git-upload-pack")
[ "$code" = 404 ] || fail "other owner returned $code"
ok "no helper, a bad token, or another owner: rejected"

# 12. a read-only token cannot push (a separate tool, approved with "Allow read only")
client=$(curl -fsS -H 'Content-Type: application/json' -d "{\"client_name\":\"reader\",\"redirect_uris\":[\"$ORIGIN/authorize/done\"],\"token_endpoint_auth_method\":\"none\"}" \
  "$ORIGIN/register" | sed -n 's/.*"client_id":"\([^"]*\)".*/\1/p')
verifier=$(openssl rand -hex 32)
challenge=$(printf '%s' "$verifier" | openssl dgst -sha256 -binary | openssl base64 -A | tr -d '=' | tr '+/' '-_')
rcode=$(approve "$ORIGIN/authorize?response_type=code&client_id=$client&redirect_uri=$ORIGIN/authorize/done&code_challenge=$challenge&code_challenge_method=S256" \
  tester@example.com "" read_only=1)
read_token=$(curl -fsS -d grant_type=authorization_code -d "client_id=$client" --data-urlencode "code=$rcode" \
  -d "redirect_uri=$ORIGIN/authorize/done" -d "code_verifier=$verifier" "$ORIGIN/token" | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')
[ -n "$read_token" ] || fail "no read-only token"
reader="!f() { echo username=x; echo password=$read_token; }; f"
git -c "credential.$ORIGIN.helper=" -c "credential.$ORIGIN.helper=$reader" ls-remote "$R/project.git" >/dev/null || fail "read-only ls-remote"
if git -C src -c "credential.$ORIGIN.helper=" -c "credential.$ORIGIN.helper=$reader" push -q origin main:refs/heads/readonly 2>"$WORK/ro.err"; then
  fail "push with a read-only token succeeded"
fi
grep -q "read-only" "$WORK/ro.err" || fail "read-only push did not say why: $(cat "$WORK/ro.err")"
ok "a read-only token can fetch but not push"

# 13. bad repository names are refused with a reason
git init -q named && commit named a.txt a
if git -C named push -q "$R/Notes.git" main 2>"$WORK/name.err"; then fail "push to an uppercase name succeeded"; fi
grep -q 'use "notes"' "$WORK/name.err" || fail "uppercase push did not suggest the lowercase name: $(cat "$WORK/name.err")"
ok "a bad repository name is refused, with the lowercase spelling"

# 14. an expired access token is refreshed without anyone noticing
old=$(sed -n 's/^refresh_token=//p' "$TOKENS")
sed -i.bak 's/^expires_at=.*/expires_at=0/' "$TOKENS"
git ls-remote "$R/project.git" >/dev/null || fail "ls-remote after the access token expired"
[ "$(sed -n 's/^refresh_token=//p' "$TOKENS")" != "$old" ] || fail "the helper did not refresh"
ok "an expired access token is refreshed silently"

# 15. two git commands that both need a refresh: the lock makes one refresh and both succeed
# (Both would usually succeed even without the lock, since the package accepts the previous refresh token once,
# so count the refreshes.)
sed -i.bak 's/^expires_at=.*/expires_at=0/' "$TOKENS"
refreshes=$(grep -c 'POST /token' "$LOG" || true)
git ls-remote "$R/project.git" >"$WORK/p1" 2>&1 &
p1=$!
git ls-remote "$R/project.git" >"$WORK/p2" 2>&1 &
p2=$!
wait "$p1" || fail "first parallel ls-remote: $(cat "$WORK/p1")"
wait "$p2" || fail "second parallel ls-remote: $(cat "$WORK/p2")"
[ "$(grep -c 'POST /token' "$LOG")" = $((refreshes + 1)) ] || fail "expected exactly one refresh for two parallel commands"
git ls-remote "$R/project.git" >/dev/null || fail "ls-remote after parallel refreshes"
ok "two parallel commands that need a refresh: one refresh, both succeed"

# 16. revoked on the Settings Page: git goes back to sign-in
request_code "$ORIGIN/settings" tester@example.com
cookie=$(curl -sS -o /dev/null -D - -d step=code -d email=tester@example.com -d "code=$(latest_code tester@example.com)" \
  "$ORIGIN/settings" | sed -n 's/^[Ss]et-[Cc]ookie: \([^;]*\);.*/\1/p')
[ -n "$cookie" ] || fail "no Settings Page session"
page=$(curl -fsS -H "Cookie: $cookie" "$ORIGIN/settings")
printf '%s' "$page" | grep -q "git on $(hostname 2>/dev/null || uname -n)" || fail "Settings Page does not list the helper"
grant=$(printf '%s' "$page" | tr '\n' ' ' | sed 's/<tr>/\
<tr>/g' | grep '<td>git on ' | field_in grant)
curl -fsS -o /dev/null -H "Cookie: $cookie" -d "grant=$grant" "$ORIGIN/settings/revoke"
# The first command still holds the revoked access token: it fails, and git tells the helper to drop it.
git ls-remote "$R/project.git" >/dev/null 2>&1 && fail "ls-remote with a revoked token succeeded"
sign_in tester@example.com
git ls-remote "$R/project.git" >/dev/null || fail "ls-remote after signing in again"
wait "$SIGN_IN"
ok "after revoking on the Settings Page, git signs in again"

# 17. logout revokes this machine's tokens
at=$(sed -n 's/^access_token=//p' "$TOKENS")
"$helper" logout >/dev/null || fail "logout"
[ ! -e "$TOKENS" ] || fail "logout left the token file"
code=$(curl -s -o /dev/null -w '%{http_code}' -u "fugitive:$at" "$R/project.git/info/refs?service=git-upload-pack")
[ "$code" = 401 ] || fail "token still works after logout ($code)"
ok "logout revokes the token and removes the file"

# 18. a second User cannot see the first one's repository
sign_in second@example.com second
if XDG_CONFIG_HOME="$WORK/second" git clone -q "$R/project.git" second 2>"$WORK/second.err"; then
  fail "second user cloned tester's repository"
fi
wait "$SIGN_IN"
grep -q "not found" "$WORK/second.err" || fail "second user did not get not found: $(cat "$WORK/second.err")"
ok "another User gets not found"

echo "all $pass end-to-end checks passed"
