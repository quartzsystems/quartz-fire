#!/usr/bin/env bash
# Prove the QuartzFire Content Filtering proof-of-concept locally: the existing
# SSL-inspection Squid bump driving a REAL stock e2guardian in ICAP server mode.
#
# Two harnesses:
#   run-in-container.sh  — forward-proxy bump + ICAP (reliable everywhere);
#                          asserts block page / allow / fail-closed.
#   run-transparent.sh   — device-representative TRANSPARENT intercept via an
#                          iptables REDIRECT (needs --cap-add=NET_ADMIN).
#
# Everything runs in one throwaway debian:bookworm container (--rm); nothing
# touches the host. Requires Docker. On Windows run under WSL:  wsl bash smoke.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
mode="${1:-proxy}"   # proxy | transparent

if [ "$mode" = transparent ]; then
  echo "==> Content-filtering PoC: TRANSPARENT intercept + stock e2guardian ICAP"
  tar -C "$here" -cf - run-transparent.sh \
    | docker run --rm -i --cap-add=NET_ADMIN debian:bookworm bash -c '
        set -e; mkdir -p /harness; tar -C /harness -xf -; bash /harness/run-transparent.sh'
else
  echo "==> Content-filtering PoC: forward-proxy bump + stock e2guardian ICAP"
  tar -C "$here" -cf - run-in-container.sh \
    | docker run --rm -i debian:bookworm bash -c '
        set -e; mkdir -p /harness; tar -C /harness -xf -; bash /harness/run-in-container.sh'
fi
