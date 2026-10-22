# syntax=docker/dockerfile:1.7
FROM --platform=linux/arm64 oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS base

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git gzip libicu76 tar

FROM base AS qualification
WORKDIR /workspace
COPY . .
RUN --mount=type=cache,target=/workspace/node_modules,sharing=locked \
    --mount=type=cache,target=/root/.bun/install/cache,sharing=locked \
    --mount=type=cache,target=/root/.cache,sharing=locked \
    bun ci && AST_MCP_QUALIFY_EMBEDDINGS=1 bun run intelligence:qualify

FROM base AS coverage
WORKDIR /workspace
COPY . .
RUN --mount=type=cache,target=/workspace/node_modules,sharing=locked \
    --mount=type=cache,target=/root/.bun/install/cache,sharing=locked \
    bun ci && bun run test:coverage
