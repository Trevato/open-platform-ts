# Your app

Push to `main` and the platform builds the Dockerfile and ships it to
`https://<app>-<you>.<your-platform-domain>`.

- `DATA_DIR` (default `/data`) is your durable data directory — put your
  SQLite database and files there. The platform snapshots, backs up, and can
  branch it.
- `PORT` is where your server must listen (default 8080).
- Authenticated platform users reach you with an `X-Plat-User` header —
  it has already been verified at the edge; a client can never spoof it.
