# The Velocity proxy as a platform app: a Bun control plane (HTTP on PORT) that
# runs the velocity.jar the platform places from op.json assets and generates
# its config from live backend discovery. Java 21 for Velocity 4.
FROM oven/bun:1-alpine
RUN apk add --no-cache openjdk21-jre-headless
WORKDIR /app
COPY . .
ENV PORT=8080
EXPOSE 8080 25565
CMD ["bun", "server.ts"]
