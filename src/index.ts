// Worker: the OAuth package wraps everything and answers its own endpoints (/token, /register, metadata);
// everything else comes to the default handler below.
import { env as workerEnv } from "cloudflare:workers";
import OAuthProvider, {
  getOAuthApi,
  GrantType,
  OAuthError,
  type OAuthHelpers,
  type OAuthProviderOptions,
} from "@cloudflare/workers-oauth-provider";
import { checkAccess } from "./access";
import { authorize, authorizeDone, type Props } from "./authorize";
import { advertiseRefs, gitResponse, repositoryObject } from "./repository";
import { idleTooLong, repositoryNameProblem, userNameProblem } from "./rules";
import { helperScript, installPowerShellScript, installScript } from "./scripts";
import { settings } from "./settings";
import { now, users } from "./sign-in";

export { RepositoryObject } from "./repository";
export { Users } from "./users";

declare global {
  interface Env {
    /** Set by the OAuth package before it calls the default handler. */
    OAUTH_PROVIDER: OAuthHelpers;
    /** The package's name for its KV; see oauthEnv(). */
    OAUTH_KV: KVNamespace;
    /** Test-only override of the resend wait; deliberately not in wrangler.jsonc. See codeResendSeconds(). */
    CODE_RESEND_SECONDS?: string;
  }
}

/** The package reads its KV as env.OAUTH_KV; ours is bound as OAUTH_STORE (see wrangler.jsonc). */
function oauthEnv(env: Omit<Env, "OAUTH_KV" | "OAUTH_PROVIDER">): Env {
  return Object.assign(env, { OAUTH_KV: env.OAUTH_STORE }) as Env;
}

const GIT_PATH = /^\/@([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;
const SERVICES = new Set(["git-upload-pack", "git-receive-pack"]);

function text(body: string, status: number, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...headers } });
}

const notFound = () => text("repository not found\n", 404);

/** The access token is the Basic password; the username is ignored. */
function basicPassword(authorization: string | null): string | null {
  if (!authorization?.startsWith("Basic ")) return null;
  try {
    const decoded = atob(authorization.slice(6).trim());
    return decoded.slice(decoded.indexOf(":") + 1) || null;
  } catch {
    return null;
  }
}

async function git(request: Request, env: Env, match: RegExpExecArray): Promise<Response> {
  const [, owner, name, action] = match;
  // The Owner is a user name; anything else, uppercase included, cannot be anyone's.
  if (userNameProblem(owner)) return notFound();
  const url = new URL(request.url);
  const service = action === "info/refs" ? url.searchParams.get("service") : action;
  if (!service || !SERVICES.has(service)) {
    return text("fugitive only speaks the smart HTTP protocol; please upgrade git\n", 403);
  }
  if ((action === "info/refs") !== (request.method === "GET")) return text("method not allowed\n", 405);

  const password = basicPassword(request.headers.get("Authorization"));
  const token = password ? await env.OAUTH_PROVIDER.unwrapToken<Props>(password) : null;
  if (!token) {
    const reason = request.headers.has("Authorization") ? "invalid or expired access token\n" : "authentication required\n";
    return text(reason, 401, { "WWW-Authenticate": 'Basic realm="fugitive"' });
  }
  const push = service === "git-receive-pack";
  switch (checkAccess(token.grant.props, token.scope, push ? "write" : "read", owner)) {
    case "not-found":
      return notFound();
    case "read-only":
      return text("this token is read-only\n", 403);
  }

  const userId = token.grant.props.userId;
  if (push) {
    // Checked on info/refs too: git shows the message only for that request, and sends no pack after it.
    const problem = repositoryNameProblem(name);
    if (problem) return text(`${problem}\n`, 400);
  }
  let id: string | null;
  if (!push || action === "info/refs") {
    id = await users(env).findRepository(userId, name);
    if (!id && !push) return notFound();
    // Don't register on info/refs, so a push that stops before sending anything leaves no empty Repository behind.
    if (!id) return gitResponse(`${service}-advertisement`, advertiseRefs(service, new Map()));
  } else {
    // ADR 0008: register at the start of the push, before any data is written.
    id = await users(env).findOrCreateRepository(userId, name, now());
  }
  return repositoryObject(env, id).fetch(request);
}

const defaultHandler: ExportedHandler<Env> = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const match = GIT_PATH.exec(url.pathname);
    if (match) return git(request, env, match);
    if (url.pathname === "/authorize") return authorize(request, env);
    if (url.pathname === "/authorize/done") return authorizeDone(request);
    if (url.pathname === "/settings" || url.pathname.startsWith("/settings/")) return settings(request, env);
    if (url.pathname === "/install.sh") return text(installScript(url.origin), 200);
    if (url.pathname === "/install.ps1") return text(installPowerShellScript(url.origin), 200);
    if (url.pathname === "/git-credential-fugitive") return text(helperScript(url.origin), 200);
    return text("not found\n", 404);
  },
};

const options: OAuthProviderOptions<Env> = {
  defaultHandler,
  // git sends Basic, and the package's API protection only takes Bearer, so git checks tokens itself (spec #24).
  // The package insists on an API configuration; an empty one routes nothing to it.
  apiHandlers: {},
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: ["read", "write"],
  accessTokenTTL: 3600,
  // The package has defaults for these two, so they must be undefined on purpose. Grants don't expire on a fixed
  // date: 90 days unused is checked below (ADR 0007). Registered clients don't expire either, or every helper
  // would break 90 days after its first sign-in, however often it is used.
  refreshTokenTTL: undefined,
  clientRegistrationTTL: undefined,
  allowImplicitFlow: false,
  allowPlainPKCE: false,
  async tokenExchangeCallback({ grantType, grantId, userId, props }) {
    if (grantType !== GrantType.REFRESH_TOKEN) return;
    const at = now();
    const p = props as Props;
    if (idleTooLong(p.lastUsedAt, at)) {
      await getOAuthApi<Env>(options, oauthEnv(workerEnv)).revokeGrant(grantId, userId);
      throw new OAuthError("invalid_grant", { description: "unused for more than 90 days; sign in again" });
    }
    await users(workerEnv).touchGrant(grantId, at);
    return { newProps: { ...p, lastUsedAt: at } satisfies Props };
  },
};

const provider = new OAuthProvider<Env>(options);

export default {
  fetch: (request, env, ctx) => provider.fetch(request, oauthEnv(env), ctx),
} satisfies ExportedHandler<Env>;
