#!/bin/sh
# fugitive installer: `curl -fsSL <origin>/install.sh | sh`. Installs the credential helper and writes git config
# for this host only; running it again replaces an older helper, stage 1's signing helper included.
set -e
origin='__ORIGIN__'
dir="${XDG_DATA_HOME:-$HOME/.local/share}/fugitive"
mkdir -p "$dir"
curl -fsSL "$origin/git-credential-fugitive" -o "$dir/git-credential-fugitive"
chmod +x "$dir/git-credential-fugitive"

# An empty helper first clears helpers like Keychain that would store the token as a password; then add ours.
git config --global --unset-all "credential.$origin.helper" || true
git config --global --add "credential.$origin.helper" ""
git config --global --add "credential.$origin.helper" "$dir/git-credential-fugitive"
# Stage 1's helper signed with this key; nothing reads it any more.
git config --global --unset fugitive.key || true

echo "fugitive: credential helper installed for $origin"
echo "fugitive: the first clone or push opens a sign-in page in your browser"
