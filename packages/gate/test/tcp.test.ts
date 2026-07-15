import { afterAll, describe, expect, test } from "bun:test";
import { createConnection, createServer, type Server } from "node:net";
import { TcpGate } from "../src/tcp.ts";

// A loopback TCP echo server standing in for an app container's binding.
function echoServer(): Promise<{ server: Server; port: number }> {
  return new Promise((resolvePort) => {
    const server = createServer((sock) => {
      sock.on("data", (b) => sock.write(`echo:${b.toString()}`));
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolvePort({ server, port });
    });
  });
}

/** Grab a free port the OS just handed out; racy in theory, fine in tests. */
function freePort(): Promise<number> {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

function roundTrip(port: number, message: string): Promise<string> {
  return new Promise((resolveData, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port }, () => {
      socket.write(message);
    });
    socket.on("data", (buf) => {
      resolveData(buf.toString());
      socket.end();
    });
    socket.on("error", reject);
    setTimeout(() => reject(new Error("relay timeout")), 5_000).unref();
  });
}

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const fn of cleanups) fn();
});

describe("TcpGate", () => {
  test("relays bytes both ways and converges on sync()", async () => {
    const upstream = await echoServer();
    const pub = await freePort();
    const gate = new TcpGate();
    cleanups.push(
      () => gate.stop(),
      () => upstream.server.close(),
    );

    gate.sync([
      {
        public_port: pub,
        owner: "o",
        app: "a",
        container_port: 25565,
        host_port: upstream.port,
      },
    ]);
    // listener comes up asynchronously
    for (let i = 0; i < 50 && gate.activePorts().length === 0; i++)
      await Bun.sleep(10);
    expect(gate.activePorts()).toEqual([pub]);

    expect(await roundTrip(pub, "hello")).toBe("echo:hello");

    // A stopped app (host_port null) closes the listener.
    gate.sync([
      {
        public_port: pub,
        owner: "o",
        app: "a",
        container_port: 25565,
        host_port: null,
      },
    ]);
    expect(gate.activePorts()).toEqual([]);

    // Re-sync brings it back — level-based, idempotent.
    gate.sync([
      {
        public_port: pub,
        owner: "o",
        app: "a",
        container_port: 25565,
        host_port: upstream.port,
      },
    ]);
    for (let i = 0; i < 50 && gate.activePorts().length === 0; i++)
      await Bun.sleep(10);
    expect(await roundTrip(pub, "back")).toBe("echo:back");
  });

  test("retargets live on redeploy without dropping the listener", async () => {
    const first = await echoServer();
    const second = await echoServer();
    const pub = await freePort();
    const gate = new TcpGate();
    cleanups.push(
      () => gate.stop(),
      () => first.server.close(),
      () => second.server.close(),
    );

    const route = (hostPort: number) => [
      {
        public_port: pub,
        owner: "o",
        app: "a",
        container_port: 25565,
        host_port: hostPort,
      },
    ];
    gate.sync(route(first.port));
    for (let i = 0; i < 50 && gate.activePorts().length === 0; i++)
      await Bun.sleep(10);
    expect(await roundTrip(pub, "one")).toBe("echo:one");

    gate.sync(route(second.port));
    expect(await roundTrip(pub, "two")).toBe("echo:two");
  });

  test("self-heals when the public port is briefly held elsewhere", async () => {
    const upstream = await echoServer();
    const pub = await freePort();
    // Squat on the public port (same wildcard bind the gate uses, so it
    // reliably conflicts despite SO_REUSEADDR) → the first bind fails async.
    const squatter = createServer();
    await new Promise<void>((r) => squatter.listen(pub, r));

    const gate = new TcpGate({ retryMs: 150 });
    cleanups.push(
      () => gate.stop(),
      () => upstream.server.close(),
      () => squatter.close(),
    );
    gate.sync([
      {
        public_port: pub,
        owner: "o",
        app: "a",
        container_port: 25565,
        host_port: upstream.port,
      },
    ]);
    // Bind can't take while the squatter holds the port — no phantom active.
    await Bun.sleep(120);
    expect(gate.activePorts()).toEqual([]);

    // Release it; the retry should claim it and start relaying.
    await new Promise<void>((r) => squatter.close(() => r()));
    for (let i = 0; i < 60 && gate.activePorts().length === 0; i++)
      await Bun.sleep(20);
    expect(gate.activePorts()).toEqual([pub]);
    expect(await roundTrip(pub, "healed")).toBe("echo:healed");
  });
});
