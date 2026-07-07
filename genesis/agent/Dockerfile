# The crew's agent sandbox. Slim, pinned, reproducible: node-alpine (musl) gives
# node; bun (pinned) builds/tests the user's Bun apps; git + ripgrep are the
# agent's hands. claude comes CURRENT from npm (the linux musl native binary) —
# NOT a Nix flake, which always lags Anthropic's releases. Rebuild to bump it.
#
# This image is the SECURITY BOUNDARY: the crew runs claude
# --dangerously-skip-permissions inside it (the agent runs wild), but the box is
# non-root, cap-dropped, read-only-rootfs, memory/pids-limited, on an isolated
# network, with no host access and no platform credentials — only a bind-mounted
# checkout and its inference token. See @op/engine runTask for the run flags.
FROM node:22-alpine

# bash: Claude Code's Bash tool needs a real bash — busybox sh is rejected as
# "No suitable shell found", which leaves the agent unable to run commands.
RUN apk add --no-cache bash git ripgrep ca-certificates libgcc libstdc++

# bun (pinned) + CURRENT claude from npm; drop the npm cache to stay slimmer.
RUN npm install -g bun@1.3.13 @anthropic-ai/claude-code && npm cache clean --force

# node-alpine ships a `node` user at uid 1000. claude refuses
# --dangerously-skip-permissions as root, so run as this non-root user.
USER node
WORKDIR /work
