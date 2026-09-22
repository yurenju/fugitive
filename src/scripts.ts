// The two shell scripts that run on the user's machine: the credential helper and the installer.
import helper from "./scripts/git-credential-fugitive.sh";
import installer from "./scripts/install.sh";

// Origins come from the request URL, so they never hold a quote.
export const helperScript = (origin: string) => helper.replaceAll("__ORIGIN__", origin);
export const installScript = (origin: string) => installer.replaceAll("__ORIGIN__", origin);
