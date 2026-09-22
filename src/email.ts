// Mail Verification Codes through Resend's HTTP API (#13).

/** Returns false (and logs Resend's answer) when the mail could not be sent. */
export async function sendCode(env: Env, to: string, code: string): Promise<boolean> {
  const res = await fetch(`${env.RESEND_API_URL}/emails`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [to],
      subject: `Your fugitive code is ${code}`,
      text:
        `Your fugitive verification code is ${code}\n\n` +
        `It works once and expires in 10 minutes.\n\n` +
        `If you did not ask for this code, ignore this email.\n`,
    }),
  }).catch((e: unknown) => e);
  if (res instanceof Response && res.ok) return true;
  console.error("resend failed", res instanceof Response ? `${res.status} ${await res.text()}` : String(res));
  return false;
}
