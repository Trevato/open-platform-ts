# COPY-only by design: no RUN, no install step. Build time is one layer copy,
# which is what keeps the platform's <60s full-loop promise honest.
FROM oven/bun:1-alpine
WORKDIR /app
COPY server.ts ui.ts ./
ENV PORT=8080
EXPOSE 8080
CMD ["bun", "server.ts"]
