# A Minecraft server as a platform app: Bun wrapper (HTTP control plane on
# PORT) + the Java runtime for the server itself. The server.jar is NOT baked
# into the image — the platform places it at /data/server.jar from op.json
# assets before the container starts.
FROM oven/bun:1-alpine
RUN apk add --no-cache openjdk21-jre-headless
WORKDIR /app
COPY . .
ENV PORT=8080
EXPOSE 8080 25565
CMD ["bun", "server.ts"]
