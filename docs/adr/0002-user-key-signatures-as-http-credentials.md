# User key signatures are the HTTP credential, not access tokens

A git client over HTTPS can only send one static `Authorization` value per command. The usual answer is a personal access token, but that is a long-lived secret the host must store. Here, a git credential helper signs "user + timestamp + repository" with the User's private key (`ssh-keygen -Y sign`, Ed25519) and hands the signature to git as a Bearer credential; the host verifies it against the registered User key on every request. The host issues no tokens and stores nothing that could be used to impersonate a User.

## Consequences

- Clients need git 2.46+ (credential helpers returning `authtype=Bearer`) and our credential helper installed.
- A captured header can be replayed until its timestamp falls outside the allowed window; HTTPS is what keeps it from being captured.
- MCP clients will need their own way to attach the same signature (for example Claude Code's `headersHelper`), or a separate path such as OAuth.
