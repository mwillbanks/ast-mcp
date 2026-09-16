#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image="ast-mcp/wine-bun:debian13-1.4.2"
wine_volume="ast-mcp-wine-debian13"
bun_volume="ast-mcp-wine-bun-cache-1-4-2"
disk_limit_bytes=$((3 * 1024 * 1024 * 1024))
workspace_limit_bytes=$((1024 * 1024 * 1024))
stage="${1:-full}"

case "$stage" in
  probe|targeted|full) ;;
  *) echo "Usage: $0 [probe|targeted|full]" >&2; exit 2 ;;
esac

cd "$project_root"
docker build --quiet --platform linux/amd64 \
  -f docker/windows-wine-x64.Dockerfile \
  -t "$image" docker

image_bytes="$(docker image inspect "$image" --format '{{.Size}}')"
if (( image_bytes > disk_limit_bytes )); then
  echo "Wine image exceeds the 3 GiB local disk limit" >&2
  exit 1
fi

docker volume create "$wine_volume" >/dev/null
docker volume create "$bun_volume" >/dev/null

docker_args=(
  run --rm --platform linux/amd64
  --mount "type=volume,source=$wine_volume,target=/wineprefix"
  --mount "type=volume,source=$bun_volume,target=/bun-cache"
  --mount "type=tmpfs,destination=/workspace,tmpfs-size=$workspace_limit_bytes"
  -e "WINDOWS_LOCAL_STAGE=$stage"
  "$image"
)

check_disk_budget() {
  local volume_bytes
  volume_bytes="$(docker "${docker_args[@]}" sh -c 'du -sb /wineprefix /bun-cache | awk "{ total += \$1 } END { print total + 0 }"')" || return
  if (( image_bytes + volume_bytes > disk_limit_bytes )); then
    echo "Wine image and caches exceed the 3 GiB local disk budget" >&2
    return 1
  fi
}

check_disk_budget
trap 'check_disk_budget' EXIT

if [[ "$stage" == probe ]]; then
  docker "${docker_args[@]}" sh -c 'wine /opt/bun/bun.exe --version'
else
  git ls-files --cached --others --exclude-standard -z \
    | COPYFILE_DISABLE=1 tar --null -T - -cf - \
    | docker "${docker_args[@]:0:2}" -i "${docker_args[@]:2}" sh -c '
        set -eu
        tar --warning=no-unknown-keyword -xf - -C /workspace
        wine /opt/bun/bun.exe --version
        cd /workspace
        wine /opt/bun/bun.exe ci
        wine /opt/bun/bun.exe test --max-concurrency=1 --timeout=30000 \
          tests/host-smoke.test.ts tests/runtime-subprocess.test.ts
        wine /opt/bun/bun.exe run intelligence:qualify
        wine /opt/bun/bun.exe test tests/mcp.test.ts \
          --test-name-pattern "calls native code intelligence through the server"
        if [ "$WINDOWS_LOCAL_STAGE" = full ]; then
          wine /opt/bun/bun.exe test --max-concurrency=1 --timeout=30000
        fi
      '
fi
