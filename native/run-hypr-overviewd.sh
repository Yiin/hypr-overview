#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/hypr-overviewd" && pwd)"
BIN="$ROOT/target/release/hypr-overviewd"

if pgrep -u "${USER:-$(id -un)}" -x hypr-overviewd >/dev/null 2>&1; then
  exit 0
fi

needs_build=0
if [[ ! -x "$BIN" ]]; then
  needs_build=1
elif find "$ROOT/src" "$ROOT/Cargo.toml" "$ROOT/Cargo.lock" -type f -newer "$BIN" | grep -q .; then
  needs_build=1
fi

if [[ "$needs_build" -eq 1 ]]; then
  cargo build --release --manifest-path "$ROOT/Cargo.toml"
fi

exec "$BIN"
