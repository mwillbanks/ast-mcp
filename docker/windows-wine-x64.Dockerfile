# syntax=docker/dockerfile:1.7
FROM --platform=linux/amd64 debian:13-slim@sha256:d7e12182ce18b85b93007c1dedf31f2d29e01ccf3182cc4017c709b6259bc132

ARG BUN_VERSION=1.4.0
ARG BUN_SHA256=e6f093d39da486b20262ca8cdd5ed6a9e8bc9c2f275b78e6d3a0c5b28cc95901

ENV DEBIAN_FRONTEND=noninteractive

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip wine wine64

RUN mkdir -p /opt/bun \
    && curl --fail --location --silent --show-error \
      "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-windows-x64.zip" \
      --output /tmp/bun-windows-x64.zip \
    && echo "${BUN_SHA256}  /tmp/bun-windows-x64.zip" | sha256sum --check \
    && unzip -j /tmp/bun-windows-x64.zip bun-windows-x64/bun.exe -d /opt/bun \
    && rm -f /tmp/bun-windows-x64.zip

ENV WINEPREFIX=/wineprefix \
    WINEDEBUG=-all \
    BUN_INSTALL_CACHE_DIR=/bun-cache \
    CI=1

WORKDIR /workspace
