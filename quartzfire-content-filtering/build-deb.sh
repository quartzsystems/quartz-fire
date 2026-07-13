#!/usr/bin/env bash
# Build the quartzfire-content-filtering package inside a Debian bookworm
# container and drop it in ../packages/ for the ISO build. Rust-only; same
# scheme as quartzfire-ssl-inspection.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$here/.." && pwd)"
mkdir -p "$repo_root/packages"

echo "==> Building quartzfire-content-filtering in rust:1-bookworm"
docker run --rm \
  -v "$repo_root/quartzfire-content-filtering":/src:ro \
  -v "$repo_root/packages":/out \
  rust:1-bookworm bash -euo pipefail -c '
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y --no-install-recommends \
    build-essential debhelper devscripts rsync >/dev/null

  mkdir -p /build/quartzfire-content-filtering
  rsync -a --exclude target/ /src/ /build/quartzfire-content-filtering/
  cd /build/quartzfire-content-filtering
  chmod 0755 debian/rules debian/postinst debian/postrm
  dpkg-buildpackage -us -uc -b
  cp /build/quartzfire-content-filtering_*.deb /out/
'
echo "==> Done. Package(s) in packages/:"
ls -1 "$repo_root"/packages/quartzfire-content-filtering_*.deb
