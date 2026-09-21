// 使用者電腦上跑的兩支 shell script：credential helper 和安裝指令。

/**
 * git credential helper。git 要帳密時會帶著 401 回應裡的 WWW-Authenticate（wwwauth[]）來問它；
 * 它從裡面取出 challenge，用使用者金鑰簽，簽章當 Basic 的密碼交回去。
 */
export const HELPER = `#!/bin/sh
# fugitive git credential helper — https://github.com/yurenju/fugitive
[ "$1" = get ] || exit 0

challenge=
while IFS= read -r line; do
  [ -z "$line" ] && break
  case "$line" in
    'wwwauth[]='*'challenge="'*) c=\${line#*challenge=\\"}; challenge=\${c%%\\"*} ;;
  esac
done
if [ -z "$challenge" ]; then
  echo "fugitive: git did not pass on the server's challenge; fugitive needs git 2.41 or newer" >&2
  exit 1
fi

tmp=$(mktemp -d) || exit 1
trap 'rm -rf "$tmp"' EXIT

key=$(git config --get fugitive.key)
case "$key" in "~/"*) key="$HOME/\${key#"~/"}" ;; esac
if [ -z "$key" ]; then
  agent_key=$(ssh-add -L 2>/dev/null | grep '^ssh-ed25519 ' | head -n 1)
  if [ -n "$agent_key" ]; then
    printf '%s\\n' "$agent_key" > "$tmp/key.pub"
    key="$tmp/key.pub"
  elif [ -f "$HOME/.ssh/id_ed25519" ]; then
    key="$HOME/.ssh/id_ed25519"
  else
    echo "fugitive: no Ed25519 key in ssh-agent or ~/.ssh/id_ed25519; set one with: git config --global fugitive.key <path>" >&2
    exit 1
  fi
fi

printf '%s' "$challenge" > "$tmp/challenge"
ssh-keygen -q -Y sign -n fugitive-git-v1 -f "$key" "$tmp/challenge" >/dev/null || exit 1
sig=$(grep -v -e '-----' "$tmp/challenge.sig" | tr -d '\\n' | tr '+/' '-_' | tr -d '=')
echo "username=fugitive"
echo "password=fgt1.$challenge.$sig"
`;

/** `curl <origin>/install.sh | sh`：裝好 helper，只替這台主機寫 git 設定。 */
export function installScript(origin: string): string {
  return `#!/bin/sh
set -e
origin='${origin}'
dir="\${XDG_DATA_HOME:-$HOME/.local/share}/fugitive"
mkdir -p "$dir"
curl -fsSL "$origin/git-credential-fugitive" -o "$dir/git-credential-fugitive"
chmod +x "$dir/git-credential-fugitive"

# 空的 helper 先清掉 Keychain 這類會把簽章當密碼存起來的 helper，再接上我們的。
git config --global --unset-all "credential.$origin.helper" || true
git config --global --add "credential.$origin.helper" ""
git config --global --add "credential.$origin.helper" "$dir/git-credential-fugitive"

echo "fugitive: credential helper installed for $origin"
`;
}
