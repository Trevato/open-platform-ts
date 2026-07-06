#!/usr/bin/env bun
import { homedir } from "node:os";
import { join } from "node:path";
import { Result } from "@op/core";
import { readLineage } from "@op/mitosis";
import { Platform, type PlatformOpts } from "./platform.ts";

function env(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function optsFromEnv(domain: string): PlatformOpts {
  return {
    root: env("OP_ROOT", join(homedir(), ".op", domain)),
    domain,
    httpPort: Number(env("HTTP_PORT", "80")),
    httpsPort: Number(env("HTTPS_PORT", "443")),
    custodyAck:
      process.env["FORK_KEY_ACK"] === "1" || process.stdin.isTTY === true,
  };
}

function card(p: Platform): void {
  const { domain } = p;
  const port = p.ports.https === 443 ? "" : `:${p.ports.https}`;
  console.log(`
╔════════════════════════════════════════════════════════════════════════╗
║                              YOUR PLATFORM                               ║
╚════════════════════════════════════════════════════════════════════════╝
  Domain          : ${domain}
  Console/API     : https://${domain}${port}
  Admin           : plat${p.freshAdminPassword ? `  /  ${p.freshAdminPassword}` : "  (existing password)"}
  Sovereign key   : ${p.sd.keyFile}
                    ⚠  KEEP THIS FILE SAFE FOREVER — it is the ONLY key to
                       this platform's secrets. Back it up offline.
  Platform CA     : ${p.sd.certsDir}/ca.crt  (trust it for clean HTTPS)

  First app:
      curl -sk -u plat:<password> -X POST https://${domain}${port}/api/v1/apps \\
        -H 'content-type: application/json' -d '{"name":"hello"}'
      git clone https://${domain}${port}/plat/hello.git && cd hello
      # edit, commit, push — the platform builds and ships it.

  Children:  op seed → hand the file to anyone → op germinate
`);
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  const domain = env("DOMAIN", "plat.localtest.me");

  switch (cmd) {
    case "up": {
      const booted = await Platform.up(optsFromEnv(domain));
      if (booted.status === "error") {
        console.error(
          `op up FAILED [${booted.error.step}]: ${booted.error.message}`,
        );
        return 1;
      }
      card(booted.value);
      await new Promise(() => {}); // serve forever
      return 0;
    }
    case "seed": {
      const out =
        rest[0] ?? `seed-${new Date().toISOString().slice(0, 10)}.tar.gz`;
      const booted = await Platform.up(optsFromEnv(domain));
      if (booted.status === "error") {
        console.error(`op seed FAILED: ${booted.error.message}`);
        return 1;
      }
      const sealed = await booted.value.seed(out);
      await booted.value.stop();
      if (sealed.status === "error") {
        console.error(`op seed FAILED: ${sealed.error.message}`);
        return 1;
      }
      console.log(`seed written: ${out} (no key inside — hand it to anyone)`);
      return 0;
    }
    case "germinate": {
      const seedFile = process.env["SEED"] ?? rest[0];
      if (!seedFile) {
        console.error(
          "usage: SEED=seed.tar.gz DOMAIN=you.example op germinate",
        );
        return 2;
      }
      const grown = await Platform.germinate(seedFile, optsFromEnv(domain));
      if (grown.status === "error") {
        console.error(
          `op germinate FAILED [${grown.error.step}]: ${grown.error.message}`,
        );
        console.error("germinate is one-shot: remove the root dir and re-run.");
        return 1;
      }
      card(grown.value);
      await new Promise(() => {});
      return 0;
    }
    case "lineage": {
      const root = env("OP_ROOT", join(homedir(), ".op", domain));
      for (const line of await readLineage(join(root, "ORIGIN")))
        console.log(line);
      return 0;
    }
    default:
      console.log(
        "op — Open Platform\n\n  op up          boot (or resume) the platform\n  op seed [out]  export a seed of this platform\n  op germinate   grow a seed into a sovereign platform (SEED=, DOMAIN=)\n  op lineage     print this platform's family tree\n\n  env: DOMAIN, OP_ROOT, HTTP_PORT, HTTPS_PORT, FORK_KEY_ACK=1",
      );
      return cmd ? 2 : 0;
  }
}

process.exit(await main());
