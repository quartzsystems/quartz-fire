#!/usr/bin/env bash
# Build qfagent_*.deb inside a Debian bookworm container with a current Rust
# toolchain, then drop the artifact into ../packages/ for the ISO build. Run
# from anywhere; needs Docker. Works from a Windows checkout (mounts the repo
# and restores exec bits inside the container).
#
# The build runs against a copy of the crate inside the container filesystem
# (not the bind mount) so it works from a Windows/drvfs checkout as well as
# ext4 — only the finished .deb is copied back to the host. No
# protobuf-compiler needed: the protos compile with protox (pure Rust).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$here/.." && pwd)"

mkdir -p "$repo_root/packages"

echo "==> Building qfagent .deb in rust:1-bookworm"
docker run --rm \
  -v "$repo_root/qfagent":/src-qfagent:ro \
  -v "$repo_root/packages":/out \
  rust:1-bookworm bash -euo pipefail -c '
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y --no-install-recommends \
    build-essential debhelper devscripts ca-certificates >/dev/null

  # Copy the crate out of the read-only mount so cargo/dpkg can write to it.
  cp -a /src-qfagent /build
  cd /build

  # Windows checkouts drop the exec bit; restore it for the maintainer scripts.
  chmod +x debian/rules debian/postinst debian/postrm

  dpkg-buildpackage -us -uc -b

  cp ../qfagent_*.deb /out/
'

echo "==> Done. Package(s) in packages/:"
ls -1 "$repo_root"/packages/qfagent_*.deb
