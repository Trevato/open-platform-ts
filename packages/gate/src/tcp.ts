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
 *  listener set to the routing table and is safe to call on every pass. */
export class TcpGate {
  private listeners = new Map<number, Server>();
  private targets = new Map<number, number>();

  constructor(private readonly opts: { log?: Log } = {}) {}

  /** Converge listeners to `routes`. New route → listen; gone/stopped route →
   *  close the listener (in-flight connections are left to finish; new ones
   *  stop being accepted). Retargeting is just a map write — live. */
  sync(routes: TcpRoute[]): void {
    const want = new Map(
      routes
        .filter((r) => r.host_port !== null)
        .map((r) => [r.public_port, r.host_port as number]),
    );

    for (const [port, server] of this.listeners) {
      if (want.has(port)) continue;
      server.close();
      this.listeners.delete(port);
      this.targets.delete(port);
      this.opts.log?.info("tcp gate: closed", { port });
    }

    for (const [port, target] of want) {
      this.targets.set(port, target);
      if (this.listeners.has(port)) continue;
      const server = createServer((client) => {
        // Resolve the target per-connection so a redeploy retargets new
        // connections without dropping the listener.
        const hostPort = this.targets.get(port);
        if (hostPort === undefined) {
          client.destroy();
          return;
        }
        const upstream = createConnection({
          host: "127.0.0.1",
          port: hostPort,
        });
        // node:net pipes give backpressure both ways; errors just tear the
        // pair down — the client sees a dropped connection, which is exactly
        // what a stopped app is.
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
        this.opts.log?.error("tcp gate: listen failed", {
          port,
          error: String(err),
        });
        this.listeners.delete(port);
        this.targets.delete(port);
      });
      server.listen(port, () => {
        this.opts.log?.info("tcp gate: listening", { port });
      });
      this.listeners.set(port, server);
    }
  }

  /** Ports currently being relayed (for status surfaces and tests). */
  activePorts(): number[] {
    return [...this.listeners.keys()].sort((a, b) => a - b);
  }

  stop(): void {
    for (const server of this.listeners.values()) server.close();
    this.listeners.clear();
    this.targets.clear();
  }
}
