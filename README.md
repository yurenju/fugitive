# fugitive

A git host on Cloudflare Workers. Clone and push with plain `git` over HTTPS; you authenticate by signing with your own Ed25519 key, and the server never issues tokens (see [ADR 0002](docs/adr/0002-user-key-signatures-as-http-credentials.md)).

> **Most of the documentation is in Traditional Chinese**: the design decisions in [`docs/adr/`](docs/adr), the domain glossary in [`CONTEXT.md`](CONTEXT.md), agent instructions in [`CLAUDE.md`](CLAUDE.md), and the project's issues and pull requests. Code, comments and this README are in English.

## Usage

```sh
curl -fsSL https://<host>/install.sh | sh
git clone https://<host>/<owner>/<repository>.git
```

Requires git 2.41 or newer (the helper needs git to pass on the server's challenge). Ubuntu 24.04, Debian 13, Homebrew, Git for Windows and GitHub Actions runners qualify; Ubuntu 22.04, Debian 12 and Debian 12 based Docker images such as `node:24` do not (on Ubuntu, use `ppa:git-core/ppa`; on Debian, move to 13, e.g. `node:24-trixie`). Apple's git from older Command Line Tools is 2.39; use Homebrew's git if yours is older than 2.41. The installer puts a credential helper in place and writes git config for this host only. The helper signs with the first Ed25519 key in ssh-agent, falling back to `~/.ssh/id_ed25519`; to pick another key, set `git config --global fugitive.key <path>`.

Stage 1 has no registration or login yet: `USER_NAME` and `USER_KEY` in `wrangler.jsonc` are the only User and their public key, and any repository name under that User can be pushed to directly.

## Development

```sh
npm install
npm run typecheck
npm test          # HTTP requests straight to the Worker, inside workerd
npm run test:e2e  # starts wrangler dev and runs the acceptance list with real git
```

A local `wrangler dev` needs `CHALLENGE_SECRET=<any string>` in `.dev.vars`.

## Deployment

Deployment runs on Cloudflare Workers Builds: the `fugitive` Worker is connected to this repository in the Cloudflare dashboard, and Cloudflare builds and deploys every push to `main`. GitHub Actions only runs the tests, so a failing test does not stop a deploy; check that CI is green before merging. No Cloudflare credentials are stored on GitHub.

One-time setup in the Cloudflare dashboard:

1. Create the R2 bucket `fugitive-packs`.
2. Create a Worker named `fugitive` (it must match `name` in `wrangler.jsonc`), then under **Settings → Builds** connect this repository with branch `main` and deploy command `npx wrangler deploy`.
3. Under the Worker's **Settings → Variables and Secrets**, add the secret `CHALLENGE_SECRET` (any random string, e.g. `openssl rand -base64 32`). It is the secret the server uses to MAC its challenges and survives later deploys.
