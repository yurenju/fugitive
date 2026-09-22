import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Each test signs up its own User (u0@example.com, u1@…), so the allowlist has plenty of addresses.
const ALLOWLIST = Array.from({ length: 60 }, (_, i) => `u${i}@example.com`);

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          // Commas and newlines both separate entries; the tests' own fetch stub plays Resend.
          REGISTRATION_ALLOWLIST: `${ALLOWLIST.slice(0, 30).join(",")}\n${ALLOWLIST.slice(30).join("\n")}`,
          SESSION_SECRET: "test-secret",
          RESEND_API_KEY: "test-key",
          RESEND_API_URL: "https://resend.test",
          EMAIL_FROM: "fugitive <noreply@fugitive.test>",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["./test/global-setup.ts"],
  },
});
