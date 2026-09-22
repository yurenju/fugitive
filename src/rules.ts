// Pure rules shared by the routes, the pages and the Users Durable Object.

/** User names (ADR 0006): lowercase letters and digits, single `-` between them, 1–39 characters. */
export function userNameProblem(name: string): string | null {
  if (name.length < 1 || name.length > 39) return "Names are 1 to 39 characters long.";
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
    return "Use lowercase letters, digits and single hyphens; no hyphen at the start or end.";
  }
  return null;
}

/** Repository names (ADR 0008): `[a-z0-9._-]`, 1–100 characters, not `.` or `..`, not ending in `.git`. */
export function repositoryNameProblem(name: string): string | null {
  if (/[A-Z]/.test(name) && !repositoryNameProblem(name.toLowerCase())) {
    return `repository names are lowercase; use "${name.toLowerCase()}"`;
  }
  if (name.length < 1 || name.length > 100) return "repository names are 1 to 100 characters long";
  if (!/^[a-z0-9._-]+$/.test(name)) return "repository names use only lowercase letters, digits, '.', '_' and '-'";
  if (name === "." || name === "..") return `"${name}" is not a repository name`;
  if (name.endsWith(".git")) return "repository names cannot end in .git";
  return null;
}

/** A grant unused for longer than this can no longer refresh (ADR 0007). */
export const IDLE_LIMIT_SECONDS = 90 * 24 * 60 * 60;

export function idleTooLong(lastUsedAt: number, now: number): boolean {
  return now - lastUsedAt > IDLE_LIMIT_SECONDS;
}
