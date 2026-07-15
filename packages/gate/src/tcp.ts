import { createConnection, createServer, type Server } from "node:net";
import type { Log } from "@op/core";

export interface TcpRoute {
  public_port: number;
  owner: string;
  app: string;
  container_port: number;
  /** The container's loopback binding; null while the app is stopped. */
  host_port: number | null;
}

/** The L4 sibling of the HTTP gate: one listener per allocated public port,
 *  each relaying raw TCP to a container's loopback binding. Containers stay
 *  loopback-only — this relay is the ONLY public ingress, same invariant as
 *  the HTTP gate. Level-based like everything else: sync() converges the
 *  listener set to the routing table and is safe to call on every pass.
 *
 *  Binds are honest: a port counts as active only once `listening` fires, so
 *  activePorts() never reports a phantom. A bind that fails asynchronously
 *  (a port transiently held elsewhere, a TIME_WAIT after a fast restart) is
 *  retried on a short backoff until it takes — the relay self-heals without
 *  waiting for the next deploy. */
export class TcpGate {
  private listeners = new Map<number, Server>();
  private targets = new Map<number, number>();
  /** Ports mid-bind (listen() called, not yet listening or failed). */
  private pending = new Set<number>();
  private retries = new Map<number, ReturnType<typeof setTimeout>>();
  private stopped = false;

  constructor(private readonly opts: { log?: Log; retryMs?: number } = {}) {}

  private get retryMs(): number {
    return this.opts.retryMs ?? 2_000;
  }

  /** Converge listeners to `routes`. New route → listen; gone/stopped route →
   *  close the listener (in-flight connections are left to finish; new ones
   *  stop being accepted). Retargeting is just a map write — live. */
  sync(routes: TcpRoute[]): void {
    const want = new Map(
      routes
        .filter((r) => r.host_port !== null)
        .map((r) => [r.public_port, r.host_port as number]),
    );

    // Drop targets and listeners for ports no longer wanted.
    for (const port of [...this.targets.keys()]) {
      if (want.has(port)) continue;
      this.targets.delete(port);
      const pending = this.retries.get(port);
      if (pending) {
        clearTimeout(pending);
        this.retries.delete(port);
      }
      this.pending.delete(port);
      const server = this.listeners.get(port);
      if (server) {
        server.close();
        this.listeners.delete(port);
        this.opts.log?.info("tcp gate: closed", { port });
      }
    }

    for (const [port, target] of want) {
      this.targets.set(port, target); // live retarget for new connections
      if (this.listeners.has(port) || this.pending.has(port)) continue;
      this.listen(port);
    }
  }

  private listen(port: number): void {
    if (this.stopped || !this.targets.has(port)) return;
    this.pending.add(port);
    const server = createServer((client) => {
      // Resolve the target per-connection so a redeploy retargets new
      // connections without dropping the listener.
      const hostPort = this.targets.get(port);
      if (hostPort === undefined) {
        client.destroy();
        return;
      }
      const upstream = createConnection({ host: "127.0.0.1", port: hostPort });
      // node:net pipes give backpressure both ways; errors just tear the pair
      // down — the client sees a dropped connection, exactly what a stopped
      // app is.
      client.pipe(upstream);
      upstream.pipe(client);
      const drop = () => {
        client.destroy();
        upstream.destroy();
      };
      client.on("error", drop);
      upstream.on("error", drop);
      client.on("close", () => upstream.destroy());
      upstream.on("close", () => client.destroy());
    });
    server.on("error", (err) => {
      this.pending.delete(port);
      this.listeners.delete(port);
      // Still wanted → retry on a backoff so a transient bind failure heals
      // itself. No longer wanted → sync() already cleared the target; drop it.
      if (this.stopped || !this.targets.has(port)) return;
      this.opts.log?.warn("tcp gate: bind failed, will retry", {
        port,
        error: String(err),
      });
      const t = setTimeout(() => {
        this.retries.delete(port);
        if (!this.listeners.has(port)) this.listen(port);
      }, this.retryMs);
      // Don't keep the process alive just for a relay retry.
      (t as { unref?: () => void }).unref?.();
      this.retries.set(port, t);
    });
    server.listen(port, () => {
      // Only now is the port truly bound and public.
      this.pending.delete(port);
      this.listeners.set(port, server);
      this.opts.log?.info("tcp gate: listening", { port });
    });
  }

  /** Ports actually bound and relaying (never a phantom mid-bind port). */
  activePorts(): number[] {
    return [...this.listeners.keys()].sort((a, b) => a - b);
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.retries.values()) clearTimeout(t);
    this.retries.clear();
    for (const server of this.listeners.values()) server.close();
    this.listeners.clear();
    this.targets.clear();
    this.pending.clear();
  }
}
