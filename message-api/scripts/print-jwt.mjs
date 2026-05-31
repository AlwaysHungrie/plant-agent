#!/usr/bin/env node
// Signs a long-lived HS256 JWT using JWT_SECRET from .dev.vars and prints it
// to the console. Run automatically after `wrangler deploy` via npm script.
//
// The deployed Worker verifies tokens against the JWT_SECRET that was pushed
// with `wrangler secret put JWT_SECRET` — keep .dev.vars in sync with that
// value or the printed token will be rejected in production.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sign } from "hono/jwt";

const __dirname = dirname(fileURLToPath(import.meta.url));
const devVarsPath = resolve(__dirname, "..", ".dev.vars");

function readSecret() {
  let raw;
  try {
    raw = readFileSync(devVarsPath, "utf8");
  } catch {
    return null;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key !== "JWT_SECRET") continue;
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    return val;
  }
  return null;
}

const secret = readSecret();
if (!secret) {
  console.error(
    "\n[print-jwt] JWT_SECRET not found in message-api/.dev.vars.\n" +
      "  1. Create .dev.vars with:  JWT_SECRET=<random-long-string>\n" +
      "  2. Push the same value:    wrangler secret put JWT_SECRET\n" +
      "  3. Re-run deploy.\n",
  );
  process.exit(1);
}

const payload = {
  sub: "genesis-operator",
  iat: Math.floor(Date.now() / 1000),
};

const token = await sign(payload, secret, "HS256");

const bar = "=".repeat(60);
console.log(`\n${bar}`);
console.log("GENESIS_JWT (paste into viewer localStorage as 'GENESIS_JWT'):");
console.log(token);
console.log(`${bar}\n`);
