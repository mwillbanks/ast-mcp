# syntax=docker/dockerfile:1.7
FROM --platform=linux/arm64 oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS base

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git gzip libicu76 tar

FROM base AS coverage
WORKDIR /workspace
COPY . .
RUN --mount=type=cache,target=/workspace/node_modules,sharing=locked \
    --mount=type=cache,target=/root/.bun/install/cache,sharing=locked \
    bun ci && bun run test:coverage
