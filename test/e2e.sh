#!/usr/bin/env bash
# End-to-end tests: start a local wrangler dev and run stage 1's acceptance list with real git.
# Usage: test/e2e.sh (needs git, ssh-keygen, curl)
set -euo pipefail

PORT=${PORT:-8791}
ORIGIN="http://127.0.0.1:$PORT"
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
LOG="$WORK/wrangler.log"
pass=0

cleanup() {
  # wrangler runs workerd underneath, so stop the whole process group.
  [ -n "${SERVER:-}" ] && kill -- "-$SERVER" 2>/dev/null || true
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

# ---- test User and keys (generated fresh each run) ----
KEYS="$WORK/keys"
mkdir -p "$KEYS"
ssh-keygen -q -t ed25519 -N '' -C tester -f "$KEYS/tester"
ssh-keygen -q -t ed25519 -N '' -C stranger -f "$KEYS/stranger"

# ---- start the server ----
if curl -s -o /dev/null "$ORIGIN/"; then
  echo "port $PORT is already in use; set PORT to another value" >&2
  exit 1
fi
(cd "$ROOT" && exec setsid npx wrangler dev --ip 127.0.0.1 --port "$PORT" --persist-to "$WORK/state" \
  --var "USER_NAME:tester" --var "USER_KEY:$(cat "$KEYS/tester.pub")" \
  --var "CHALLENGE_SECRET:e2e-secret" >"$LOG" 2>&1) &
SERVER=$!
for _ in $(seq 1 120); do
  curl -fs "$ORIGIN/install.sh" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fs "$ORIGIN/install.sh" >/dev/null || fail "wrangler dev did not start"

# ---- the user's machine: its own HOME, no ssh-agent ----
export HOME="$WORK/home"
mkdir -p "$HOME/.ssh"
cp "$KEYS/tester" "$HOME/.ssh/id_ed25519"
cp "$KEYS/tester.pub" "$HOME/.ssh/id_ed25519.pub"
unset SSH_AUTH_SOCK
export GIT_TERMINAL_PROMPT=0
git config --global user.name Tester
git config --global user.email tester@example.com
git config --global init.defaultBranch main
git config --global advice.detachedHead false

curl -fsSL "$ORIGIN/install.sh" | sh >/dev/null
git config --global --get-all "credential.$ORIGIN.helper" | grep -q git-credential-fugitive || fail "installer did not configure helper"
ok "install.sh sets up the credential helper"

cd "$WORK"
R="$ORIGIN/tester"

commit() { # commit <dir> <file> <content>
  printf '%s\n' "$3" >"$1/$2"
  git -C "$1" add "$2"
  git -C "$1" commit -qm "$2: $3"
}

# 1. clone an empty repository
git clone -q "$R/empty.git" empty 2>/dev/null || fail "clone empty repository"
[ -z "$(git -C empty rev-parse --all)" ] || fail "empty clone has refs"
ok "clone an empty repository"

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

# 10. no helper, or a key not in the config: rejected
if git -c credential.helper= clone -q "$R/project.git" nohelper 2>/dev/null; then fail "clone without helper succeeded"; fi
if git -c fugitive.key="$KEYS/stranger" clone -q "$R/project.git" stranger 2>/dev/null; then fail "clone with unknown key succeeded"; fi
if git -C src -c fugitive.key="$KEYS/stranger" push -q origin main:refs/heads/x 2>/dev/null; then fail "push with unknown key succeeded"; fi
code=$(curl -s -o /dev/null -w '%{http_code}' "$ORIGIN/someone-else/project.git/info/refs?service=git-upload-pack")
[ "$code" = 404 ] || fail "other owner returned $code"
ok "no helper, unknown key, or other owner: rejected"

# 11. a read signature cannot be used to push
helper="$HOME/.local/share/fugitive/git-credential-fugitive"
cat >"$WORK/capture" <<EOF
#!/bin/sh
out=\$("$helper" "\$@")
[ "\$1" = get ] && printf '%s\n' "\$out" | sed -n 's/^password=//p' >"$WORK/read-password"
printf '%s\n' "\$out"
EOF
chmod +x "$WORK/capture"
git -c "credential.$ORIGIN.helper=" -c "credential.$ORIGIN.helper=$WORK/capture" ls-remote "$R/project.git" >/dev/null || fail "ls-remote with capture helper"
pw=$(cat "$WORK/read-password")
[ -n "$pw" ] || fail "did not capture read password"
replay="!f() { echo username=x; echo password=$pw; }; f"
if git -C src -c "credential.$ORIGIN.helper=" -c "credential.$ORIGIN.helper=$replay" push -q origin main:refs/heads/replayed 2>/dev/null; then
  fail "push with a read signature succeeded"
fi
[ -z "$(git ls-remote "$R/project.git" refs/heads/replayed)" ] || fail "replayed push created a branch"
ok "a read signature cannot be used to push"

echo "all $pass end-to-end checks passed"
