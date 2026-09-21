# Implement the git protocol ourselves on Durable Objects, not Cloudflare Artifacts

Cloudflare Artifacts already speaks git smart HTTP, but it is a closed beta that needs an access request, and it only runs on Workers Paid. We implement upload-pack and receive-pack ourselves on Workers + SQLite-backed Durable Objects instead. That keeps the whole implementation in our hands, and existing projects (littledivy/durable-git, zllovesuki/git-on-cloudflare) show Durable Objects can carry git.

## Consequences

- We write and maintain the protocol code, including packfile parsing within the 128 MB isolate memory limit.
- Because Users only ever see our own URLs and User keys, swapping the storage underneath (for example to Artifacts once it is generally available) would not change anything on the client side.
