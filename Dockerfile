# Runtime image for the worktree handler.
# Node 22 (debian/glibc, matching the host) + git + a pinned Bun, so the
# worktrees' host-installed node_modules and native binaries run unchanged.
#
# The handler source and the worktrees are bind-mounted at runtime (see
# docker-compose.yml) at their real host paths, so nothing is COPY'd here —
# edits to handler/src take effect on the next `docker compose restart`.
FROM node:22-bookworm-slim

RUN apt-get update \
	&& apt-get install -y --no-install-recommends git ca-certificates curl unzip \
	&& rm -rf /var/lib/apt/lists/*

ARG BUN_VERSION=1.3.13
RUN npm install -g "bun@${BUN_VERSION}"

ENV NODE_ENV=development
CMD ["bun", "run", "src/server.ts"]
