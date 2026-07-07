import type { Server } from "bun";
import type { Log } from "@op/core";
import type { Store } from "@op/store";

export interface GateOptions {
  store: Store;
  domain: string;
  httpPort: number;
  httpsPort: number;
  tls: { cert: string; key: string };
  /** Handles requests whose Host is exactly `domain` (the platform itself). */
  platformHandler: (req: Request) => Promise<Response>;
  /** null = anonymous. Used by the SSO gate for app hosts. */
  resolveUser: (req: Request) => Promise<{ username: string } | null>;
  /** Fail-closed app access decision (M1: public-read repos → anon allowed). */
  authorizeApp: (
    user: { username: string } | null,
    owner: string,
    app: string,
  ) => boolean;
  log?: Log;
}

// Host may carry a port ("a.example.com:8443") or be an IPv6 literal
// ("[::1]:443") — routing keys off the bare name only.
function stripPort(host: string): string {
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end === -1 ? host : host.slice(0, end + 1);
  }
  const colon = host.indexOf(":");
  return colon === -1 ? host : host.slice(0, colon);
}

// Responses fetch already decoded / connection-scoped headers that no longer
// describe the body we re-stream.
const HOP_BY_HOP = [
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
];

const text = (status: number, body: string): Response =>
  new Response(`${body}\n`, {
    status,
    headers: { "content-type": "text/plain" },
  });

export class Gate {
  private httpServer: Server<undefined> | null = null;
  private httpsServer: Server<undefined> | null = null;

  constructor(private readonly opts: GateOptions) {}

  /** Actual bound ports (differ from opts when constructed with port 0 in tests). */
  get boundHttpPort(): number {
    return this.httpServer?.port ?? this.opts.httpPort;
  }
  get boundHttpsPort(): number {
    return this.httpsServer?.port ?? this.opts.httpsPort;
  }

  start(): void {
    // HTTPS first: the redirect handler needs its bound port.
    this.httpsServer = Bun.serve({
      port: this.opts.httpsPort,
      tls: { cert: this.opts.tls.cert, key: this.opts.tls.key },
      // The default 10s drops slow-but-legitimate requests (the issue composer
      // shells out to a model, ~10s). Give in-process work room to finish.
      idleTimeout: 60,
      fetch: (req) => this.handleHttps(req),
    });
    this.httpServer = Bun.serve({
      port: this.opts.httpPort,
      fetch: (req) => this.redirectToHttps(req),
    });
    this.opts.log?.info("gate started", {
      domain: this.opts.domain,
      http: this.boundHttpPort,
      https: this.boundHttpsPort,
    });
  }

  stop(): void {
    this.httpServer?.stop(true);
    this.httpsServer?.stop(true);
    this.httpServer = null;
    this.httpsServer = null;
  }

  private redirectToHttps(req: Request): Response {
    const url = new URL(req.url);
    const host = stripPort(req.headers.get("host") ?? url.host);
    const port = this.boundHttpsPort;
    const suffix = port === 443 ? "" : `:${port}`;
    return new Response(null, {
      status: 301,
      headers: {
        location: `https://${host}${suffix}${url.pathname}${url.search}`,
      },
    });
  }

  private async handleHttps(req: Request): Promise<Response> {
    try {
      const url = new URL(req.url);
      const rawHost = req.headers.get("host") ?? url.host;
      const host = stripPort(rawHost).toLowerCase();
      if (host === this.opts.domain.toLowerCase()) {
        return await this.opts.platformHandler(req);
      }

      // App host: X-Plat-* is the platform's identity channel — anything the
      // client sent on it is a forgery attempt. Drop before any other work.
      const headers = new Headers(req.headers);
      for (const name of [...headers.keys()]) {
        if (name.toLowerCase().startsWith("x-plat-")) headers.delete(name);
      }
      const sanitized = new Request(req, { headers });

      const row = this.opts.store.resolveHost(host);
      if (!row) return text(404, "unknown host");

      const user = await this.opts.resolveUser(sanitized);
      if (!this.opts.authorizeApp(user, row.owner, row.app)) {
        if (user === null) {
          const port = this.boundHttpsPort;
          const suffix = port === 443 ? "" : `:${port}`;
          const next = encodeURIComponent(req.url);
          return new Response(null, {
            status: 302,
            headers: {
              location: `https://${this.opts.domain}${suffix}/login?next=${next}`,
            },
          });
        }
        return text(403, "forbidden");
      }

      if (row.container_port === null) return text(502, "app not running");
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        return text(501, "websocket upgrade not supported");
      }
      return await this.proxy(
        sanitized,
        url,
        rawHost,
        user,
        row.container_port,
      );
    } catch (cause) {
      this.opts.log?.error("gate request failed", { error: String(cause) });
      return text(500, "internal error");
    }
  }

  private async proxy(
    req: Request,
    url: URL,
    rawHost: string,
    user: { username: string } | null,
    port: number,
  ): Promise<Response> {
    const headers = new Headers(req.headers);
    headers.delete("host"); // upstream sees its own host; original travels in x-forwarded-host
    if (user) headers.set("x-plat-user", user.username);
    headers.set("x-forwarded-proto", "https");
    headers.set("x-forwarded-host", rawHost);

    const target = `http://127.0.0.1:${port}${url.pathname}${url.search}`;
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    let upstream: Response;
    try {
      upstream = await fetch(target, {
        method: req.method,
        headers,
        body: hasBody ? req.body : null,
        redirect: "manual",
      });
    } catch (cause) {
      this.opts.log?.warn("upstream unreachable", {
        target,
        error: String(cause),
      });
      return text(502, "upstream unreachable");
    }
    const respHeaders = new Headers(upstream.headers);
    for (const h of HOP_BY_HOP) respHeaders.delete(h);
    return new Response(upstream.body, {
      status: upstream.status,
      headers: respHeaders,
    });
  }
}
