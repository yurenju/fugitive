// The email and code steps that the Authorization Page and the Settings Page share.
import { sendCode } from "./email";
import type { Redeemed } from "./users";

export const now = () => Math.floor(Date.now() / 1000);

export function users(env: Pick<Env, "USERS">) {
  return env.USERS.getByName("global");
}

export function formField(form: FormData) {
  return (name: string) => {
    const value = form.get(name);
    return typeof value === "string" ? value : "";
  };
}

export function codeError(r: Exclude<Redeemed, { ok: true }>): string {
  switch (r.reason) {
    case "wrong":
      return `That code is not right. ${r.remaining} ${r.remaining === 1 ? "try" : "tries"} left.`;
    case "too-many":
      return "Too many wrong codes. Ask for a new code.";
    case "no-code":
      return "This code has expired or was already used. Ask for a new code.";
    case "needs-name":
      return "Choose a user name to create your account.";
    case "name-invalid":
      return r.detail;
    case "name-taken":
      return "That name is taken. Choose another.";
  }
}

/**
 * Ask for a code and mail it. Asking again within a minute sends nothing, but the page doesn't say so: only emails
 * that can get codes have a "last sent" time, so saying it would tell who is on the allowlist.
 */
export async function mailCode(env: Env, email: string): Promise<{ askName: boolean; error?: string }> {
  const r = await users(env).requestCode(email, now());
  if (r.code && !(await sendCode(env, email.trim().toLowerCase(), r.code))) {
    return { askName: r.askName, error: "We could not send the email. Please try again later." };
  }
  return { askName: r.askName };
}
