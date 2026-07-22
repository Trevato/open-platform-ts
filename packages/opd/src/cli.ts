#!/usr/bin/env bun
import { homedir } from "node:os";
import { join } from "node:path";
import { createLog, Result } from "@op/core";
import { readLineage } from "@op/mitosis";
import {
  defaultSourceDir,
  Platform,
  readAdminPassword,
  type PlatformOpts,
} from "./platform.ts";
import { bunSupervisorIo, supervise, UPGRADE_EXIT } from "./supervisor.ts";

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
  Admin           : plat${p.freshAdminPassword ? `  /  ${p.freshAdminPassword}` : "  (set on first boot — reveal it with 'op admin-password')"}
  Crew            : ${p.crewCredentialed ? "credentialed — describe a task in the console and it ships" : "idle — no CLAUDE_CODE_OAUTH_TOKEN in this process's env\n                    (claude setup-token mints one; pass it on the SAME line as\n                     'op up', or export it — a bare VAR=… line is not exported)"}
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

// The daemon: boot, print the card, serve forever. When its own source
// (plat/opd) changes under a supervisor, it asks for a re-exec by exiting
// UPGRADE_EXIT. Unsupervised, exiting would just kill the platform with
// nothing to restart it — so the daemon keeps serving the old code and the
// merge applies on the next (ideally supervised) boot. Apps outlive it.
async function serve(domain: string): Promise<number> {
  let upgrading = false;
  let booted: Platform | undefined;
  const supervised = process.env["OP_SUPERVISED"] === "1";
  const opts: PlatformOpts = {
    ...optsFromEnv(domain),
    ...(supervised
      ? {
          onUpgradeRequested: () => {
            if (upgrading) return;
            upgrading = true;
            void (async () => {
              // Grace: the event that requested this often fires at the tail
              // of an API call (a console Merge) — let its response flush
              // before the gate goes down, or the user sees a network error
              // for a merge that succeeded.
              await Bun.sleep(500);
              await booted?.stop().catch(() => {});
              process.exit(UPGRADE_EXIT);
            })();
          },
        }
      : {}),
  };
  const result = await Platform.up(opts);
  if (result.status === "error") {
    console.error(
      `op serve FAILED [${result.error.step}]: ${result.error.message}`,
    );
    return 1;
  }
  booted = result.value;
  card(booted);
  await new Promise(() => {}); // serve forever
  return 0;
}

const USAGE =
  "op — Open Platform\n\n  op up                    boot (or resume) the platform\n  op admin-password        print this platform's admin password\n  op seed [out]            export a seed of this platform\n  op germinate             grow a seed into a sovereign platform (SEED=, DOMAIN=)\n  op app export <o>/<a>    export one app as a portable artifact\n  op app import <seed>     ingest an app someone sold you (optional owner/app remap)\n  op host-source [dir]     publish the platform's own source into plat/opd (automatic on boot; use for a specific checkout or to repair)\n  op lineage               print this platform's family tree\n\n  env: DOMAIN, OP_ROOT, HTTP_PORT, HTTPS_PORT, FORK_KEY_ACK=1";

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  // Help is a global flag, checked before dispatch: an unrecognized flag must
  // never fall through to a command that would treat it as a positional
  // (e.g. `op seed --help` writing a file literally named `--help` and booting
  // the DEFAULT platform on :80/:443). A leading-dash arg anywhere → usage.
  if (argv.some((a) => a === "-h" || a === "--help" || a === "help")) {
    console.log(USAGE);
    return 0;
  }
  const stray = argv.find((a) => a.startsWith("-"));
  if (stray) {
    console.error(`op: unknown flag '${stray}'\n\n${USAGE}`);
    return 2;
  }
  const [cmd, ...rest] = argv;
  const domain = env("DOMAIN", "plat.localtest.me");

  switch (cmd) {
    case "up": {
      // Supervised (OP_SRC = a managed clone of plat/opd) → the platform can
      // re-exec itself from its own source on a merge. Otherwise serve inline
      // (dev/simple mode, no self-upgrade).
      const src = process.env["OP_SRC"];
      if (src && !process.env["OP_SUPERVISED"]) {
        const root = env("OP_ROOT", join(homedir(), ".op", domain));
        const sourceRepo = join(root, "repos", "plat", "opd.git");
        return await supervise({
          src,
          domain,
          log: createLog("super"),
          ...bunSupervisorIo(sourceRepo),
        });
      }
      return await serve(domain);
    }
    case "serve":
      // The daemon proper. Run directly by the supervisor (or by `up` inline).
      return await serve(domain);
    case "seed": {
      const out =
        rest[0] ?? `seed-${new Date().toISOString().slice(0, 10)}.tar.gz`;
      // One-shot boot: self-source publishing is a serving-daemon concern.
      const booted = await Platform.up({
        ...optsFromEnv(domain),
        hostSourceOnBoot: false,
      });
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
    case "app": {
      // op app export <owner>/<app> [out.tar.gz]
      // op app import <seed.tar.gz> [owner/app]
      const sub = rest[0];
      if (sub === "export") {
        const target = rest[1];
        if (!target || !target.includes("/")) {
          console.error("usage: op app export <owner>/<app> [out.tar.gz]");
          return 2;
        }
        const [owner, app] = target.split("/") as [string, string];
        const out =
          rest[2] ??
          `${owner}-${app}-${new Date().toISOString().slice(0, 10)}.tar.gz`;
        const booted = await Platform.up({
          ...optsFromEnv(domain),
          hostSourceOnBoot: false,
        });
        if (booted.status === "error") {
          console.error(`op app export FAILED: ${booted.error.message}`);
          return 1;
        }
        const exported = await booted.value.appExport(owner, app, out);
        await booted.value.stop();
        if (exported.status === "error") {
          console.error(
            `op app export FAILED [${exported.error.step}]: ${exported.error.message}`,
          );
          return 1;
        }
        console.log(
          `app seed written: ${out} — hand it to a client; they run 'op app import ${out}' on their platform`,
        );
        return 0;
      }
      if (sub === "import") {
        const seedFile = rest[1];
        if (!seedFile) {
          console.error("usage: op app import <seed.tar.gz> [owner/app]");
          return 2;
        }
        const remap = rest[2];
        const opts =
          remap && remap.includes("/")
            ? {
                owner: remap.split("/")[0]!,
                app: remap.split("/")[1]!,
              }
            : {};
        const booted = await Platform.up({
          ...optsFromEnv(domain),
          hostSourceOnBoot: false,
        });
        if (booted.status === "error") {
          console.error(`op app import FAILED: ${booted.error.message}`);
          return 1;
        }
        const imported = await booted.value.appImport(seedFile, opts);
        await booted.value.stop();
        if (imported.status === "error") {
          console.error(
            `op app import FAILED [${imported.error.step}]: ${imported.error.message}`,
          );
          return 1;
        }
        console.log(
          `app imported: ${imported.value.owner}/${imported.value.app} — deploying now; 'op up' to serve it`,
        );
        return 0;
      }
      console.error("usage: op app export|import …");
      return 2;
    }
    case "host-source": {
      // Mostly a repair/override tool now — `op up` hosts the source itself
      // (from a checkout or the npm package's shipped tarball) on every boot.
      // hostSourceOnBoot:false so an explicit dir can't lose to the auto-publish.
      const srcDir = rest[0] ?? defaultSourceDir();
      const booted = await Platform.up({
        ...optsFromEnv(domain),
        hostSourceOnBoot: false,
      });
      if (booted.status === "error") {
        console.error(`op host-source FAILED: ${booted.error.message}`);
        return 1;
      }
      const hosted = await booted.value.hostSource(srcDir);
      await booted.value.stop();
      if (hosted.status === "error") {
        console.error(`op host-source FAILED: ${hosted.error.message}`);
        return 1;
      }
      console.log(
        hosted.value.created
          ? `hosted plat/opd from ${hosted.value.source === "tarball" ? "the shipped source tarball" : (srcDir ?? "the running source")} — the crew can now edit the platform; push to plat/opd to self-upgrade`
          : "plat/opd already hosted (published at boot) — nothing to do; remove the plat/opd repo first if you need to re-publish from a different source",
      );
      const root = env("OP_ROOT", join(homedir(), ".op", domain));
      const sourceRepo = join(root, "repos", "plat", "opd.git");
      console.log(`  git clone ${sourceRepo} <dir>`);
      console.log(`  cd <dir> && bun install`);
      console.log(`  OP_SRC=<dir> op up`);
      return 0;
    }
    case "lineage": {
      const root = env("OP_ROOT", join(homedir(), ".op", domain));
      for (const line of await readLineage(join(root, "ORIGIN")))
        console.log(line);
      return 0;
    }
    case "admin-password": {
      // Recover the admin password (printed once on the first-boot card) from
      // the sealed store — the fix for "I looked away and lost it".
      const root = env("OP_ROOT", join(homedir(), ".op", domain));
      const pw = await readAdminPassword(root);
      if (pw.status === "error") {
        console.error(`op admin-password FAILED: ${pw.error.message}`);
        return 1;
      }
      console.log(pw.value);
      return 0;
    }
    default:
      console.log(USAGE);
      return cmd ? 2 : 0;
  }
}

process.exit(await main());
