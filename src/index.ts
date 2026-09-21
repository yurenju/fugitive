// Worker: routing and authentication; authenticated requests go to the Repository's Durable Object.
import { AuthError, authenticate, issueChallenge, publicKeyBlob, type Mode, type User } from "./auth";
import { HELPER, installScript } from "./scripts";

export { Repository } from "./repository";

const NAME = "[A-Za-z0-9][A-Za-z0-9._-]{0,99}";
const GIT_PATH = new RegExp(`^/(${NAME})/(${NAME})\\.git/(info/refs|git-upload-pack|git-receive-pack)$`);
const SERVICES = new Set(["git-upload-pack", "git-receive-pack"]);

function configuredUsers(env: Env): User[] {
  // Stage 1 has no registration or login: the config holds one User and one User key.
  return [{ name: env.USER_NAME, keyBlob: publicKeyBlob(env.USER_KEY) }];
}

function text(body: string, status: number, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...headers } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/install.sh") return text(installScript(url.origin), 200);
    if (url.pathname === "/git-credential-fugitive") return text(HELPER, 200);

    const match = GIT_PATH.exec(url.pathname);
    if (!match) return text("not found\n", 404);
    const [, owner, name, action] = match;
    const users = configuredUsers(env);
    if (!users.some((u) => u.name === owner)) return text("repository not found\n", 404);

    const service = action === "info/refs" ? url.searchParams.get("service") : action;
    if (!service || !SERVICES.has(service)) {
      return text("fugitive only speaks the smart HTTP protocol; please upgrade git\n", 403);
    }
    if ((action === "info/refs") !== (request.method === "GET")) return text("method not allowed\n", 405);

    const repository = `${owner}/${name}`;
    const mode: Mode = service === "git-receive-pack" ? "write" : "read";
    const now = Math.floor(Date.now() / 1000);
    try {
      const user = await authenticate(request.headers.get("Authorization"), {
        secret: env.CHALLENGE_SECRET,
        repository,
        mode,
        now,
        users,
      });
      // Private repository: only the Owner can read or write.
      if (user.name !== owner) throw new AuthError("not the owner");
    } catch (e) {
      if (!(e instanceof AuthError)) throw e;
      const challenge = await issueChallenge(env.CHALLENGE_SECRET, repository, mode, now);
      const reason = request.headers.has("Authorization") ? `authentication failed: ${e.message}\n` : "authentication required\n";
      return text(reason, 401, { "WWW-Authenticate": `Basic realm="fugitive", challenge="${challenge}"` });
    }
    return env.REPOSITORY.getByName(repository).fetch(request);
  },
} satisfies ExportedHandler<Env>;
