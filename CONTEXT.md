# Fugitive

A multi-user git host built on Cloudflare. Standard `git` clients clone and push over HTTPS; agents will later browse files and run git operations through MCP.

## Language

### People

**User**:
A person with an account on this git host. Anyone may eventually register; at first only emails on the Registration allowlist can.
_Avoid_: Account, member, customer

**Registration allowlist**:
The list of email addresses permitted to register as a User. Registration from any other email is refused.
_Avoid_: Whitelist, invite list, beta list

**User key**:
An Ed25519 public key, written in OpenSSH format, that a User registers to prove who they are. The User keeps the private half; the host never sees it. A User may register several User keys, but each User key belongs to exactly one User.
_Avoid_: SSH key (nothing here speaks SSH), deploy key, API key

### Repositories

**Repository**:
A git repository hosted here, reachable by a standard `git` client over HTTPS.
_Avoid_: Repo (in docs and code names), project

**Owner**:
The User a Repository belongs to; its name is the first segment of the Repository's URL (`/<owner>/<repository>.git`). Organizations will later share this same namespace.
_Avoid_: Namespace (as a noun for the thing itself), author

**Private repository**:
A Repository only its Owner can read or write. Every Repository is private for now.
