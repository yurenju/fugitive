# fugitive

A git host on Cloudflare Workers. Clone and push with plain `git` over HTTPS. People on the registration allowlist sign up with an email verification code, and every client, `git` included, gets its own OAuth access token with a read or write scope (see [ADR 0004](docs/adr/0004-oauth-tokens-for-every-client.md) and [ADR 0007](docs/adr/0007-token-scopes-and-settings-page.md)).

> **Most of the documentation is in Traditional Chinese**: the design decisions in [`docs/adr/`](docs/adr), the domain glossary in [`CONTEXT.md`](CONTEXT.md), agent instructions in [`CLAUDE.md`](CLAUDE.md), and the project's issues and pull requests. Code, comments and this README are in English.

## Usage

```sh
curl -fsSL https://<host>/install.sh | sh
git clone https://<host>/@<owner>/<repository>.git
```

The installer puts a credential helper in place and writes git config for this host only (run it again to replace an older helper). The helper needs only `sh`, `curl` and `openssl`, and works with any git version. The first clone or push opens the sign-in page in your browser (or prints its URL): enter your email, the 6-digit code you are mailed, and approve; the last page shows a code to paste back into the terminal, and the git command carries on. After that the helper refreshes its token on its own; a machine unused for 90 days signs in again. Each machine is its own entry on the settings page.

- Pushing to a name that doesn't exist yet creates the repository. Names are lowercase letters, digits, `.`, `_` and `-`.
- `https://<host>/settings` lists the tools you approved and your repositories. Revoking a tool and deleting a repository happen only there; no token can do either.
- `~/.local/share/fugitive/git-credential-fugitive logout` revokes this machine's token; `login` signs in again.
- Without a terminal (an IDE's background git, CI), the helper can't sign in; run its `login` in a terminal once, and the refresh token carries on from there.

## Development

```sh
npm install
npm run typecheck
npm test          # HTTP requests straight to the Worker, inside workerd
npm run test:e2e  # starts wrangler dev and runs the acceptance list with real git
```

A local `wrangler dev` needs `RESEND_API_KEY`, `EMAIL_FROM`, `REGISTRATION_ALLOWLIST` and `SESSION_SECRET` in `.dev.vars`. The tests need none of them: `npm test` stubs Resend inside the Worker, and `npm run test:e2e` starts a fake Resend (`test/fake-resend.mjs`).

## Deployment

Deployment runs on Cloudflare Workers Builds: the `fugitive` Worker is connected to this repository in the Cloudflare dashboard, and Cloudflare builds and deploys every push to `main`. GitHub Actions only runs the tests, so a failing test does not stop a deploy; check that CI is green before merging. No Cloudflare credentials are stored on GitHub.

One-time setup in the Cloudflare dashboard:

1. Create a Worker named `fugitive` (it must match `name` in `wrangler.jsonc`), then under **Settings → Builds** connect this repository with branch `main`, build command `npm run build` (a typecheck; a type error stops the deploy) and deploy command `npx wrangler deploy`. The deploy creates the KV namespace `OAUTH_KV` and the R2 bucket `fugitive-repositories` if they are missing; if it can't, create them by hand and fill them into `wrangler.jsonc`.
2. Verify a sending domain in [Resend](https://resend.com) and add its DNS records.
3. Under the Worker's **Settings → Variables and Secrets**, add the secrets `RESEND_API_KEY`, `EMAIL_FROM` (e.g. `fugitive <noreply@your-domain>`), `REGISTRATION_ALLOWLIST` (emails separated by commas or newlines) and `SESSION_SECRET` (any random string, e.g. `openssl rand -base64 32`; it signs the settings page cookie and the approval step).
