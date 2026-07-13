#!/usr/bin/env bash
# Prove the qfcf-RENDERED e2guardian config actually filters, in one throwaway
# rust:1-bookworm container (debian bookworm + cargo). The crate source is piped
# in as a tar (no host-path bind mount — works from git-bash + Docker Desktop and
# native WSL/Linux alike). Requires Docker. On Windows:  wsl bash smoke.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
crate="$(cd "$here/../.." && pwd)"

echo "==> Rendering + filtering proof in rust:1-bookworm"
tar -C "$crate" --exclude=target --exclude=.git -cf - . \
  | docker run --rm -i rust:1-bookworm bash -c '
      set -e
      mkdir -p /src
      tar -C /src -xf -
      bash /src/tests/render-filter/run-in-container.sh'
