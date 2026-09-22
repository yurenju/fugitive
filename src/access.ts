// The one access check every entry point uses (ADR 0007: the OAuth package records scopes but enforces nothing).
import type { Props } from "./authorize";

export type Need = "read" | "write";

/**
 * "not-found" when the token's User is not the Owner (Private Repositories don't reveal whether they exist),
 * "read-only" when the token lacks the scope. `write` includes `read`, so only the needed scope is checked.
 */
export function checkAccess(props: Props, scope: string[], need: Need, owner: string): "ok" | "not-found" | "read-only" {
  if (props.userName !== owner) return "not-found";
  if (!scope.includes(need)) return "read-only";
  return "ok";
}
