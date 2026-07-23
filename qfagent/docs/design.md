# QuartzFire Cloud Management Agent (qfagent)

The device side of QuartzCommand cloud management: a locally generated
Ed25519 device identity, token-triggered enrollment against the controller's
`EnrollmentService`, and the persistent outbound mTLS control channel with
automatic certificate renewal.

## Wire protocol

`proto/quartzcommand/{enrollment,device}/v1/*.proto` are vendored verbatim
from the QuartzCommand repo (`backend/proto/...`) — the server side is
authoritative; never rename fields here. Stubs are generated at build by
protox (pure Rust; no protoc, unlike qfappd — the dev machines have none)
via prost-build's `skip_protoc_run` + descriptor-set path.

* `BeginEnrollment(token_id, pubkey) → nonce, session`
* `CompleteEnrollment(session, secret, device_id, sig(nonce), CSR, hostname,
  version) → client cert, CA chain, assigned_gateway, org_id`
* `DeviceService.RenewCertificate(CSR) → fresh cert` (mTLS; identity comes
  from the presented client cert)

## Device identity

* `/config/quartzfire/qfagent/identity/` (the repo's established `/config`
  persistence convention — NOT the `/config/quartz` of the original spec):
  `device.key` (Ed25519 PKCS#8 PEM, 0600 root), `device.pub`, `host.json`,
  and after enrollment `client.crt`, `ca-chain.crt`, `pinned-ca.crt`.
* Device ID = `"QF-" + Crockford base32(SHA256(pubkey_raw))[0:16]` grouped
  in fours — a verbatim port of the server's `backend/src/pki/deviceid.rs`,
  pinned by fixed test vectors cross-checked against an independent
  implementation (src/deviceid.rs).
* Host fingerprint (clone protection): machine-id + DMI product UUID are
  recorded at identity creation, but only the **DMI product UUID** gates —
  on every start (and at enrollment) a recorded-and-readable-but-different
  DMI UUID refuses the control channel, logs loudly, and sets the status
  flag `identity/host mismatch — run 'qf identity regenerate'`. A fact
  missing on either side is inconclusive, never a mismatch.
  `/etc/machine-id` is recorded for diagnostics but deliberately does NOT
  gate: on VyOS each installed image regenerates its own machine-id, while
  the identity persists in `/config` across images, so gating on it would
  refuse the control channel on the same hardware after every
  `add system image` upgrade (and force a needless `qf identity
  regenerate`). The DMI product UUID is the true hardware anchor and is
  stable across image upgrades.
* TPM: `/dev/tpmrm0` presence is logged; keying stays file-based. The
  `KeyBackend` trait (`identity::TpmKeyBackend` stub) is the seam for TPM
  keys — enrollment, renewal, and the control channel only use the trait.

## Config nodes (all the hard-won geoip constraints apply)

```
set system quartz-command gateway <host>          # optional; token's gateway overrides + overwrites it
set system quartz-command port <1-65535>          # default 443
set system quartz-command ca-certificate <name>   # PKI cert for self-hosted (non-WebPKI) controllers
set system quartz-command enroll-token <QC1|...>  # one-shot trigger, auto-removed
```

Hand-written cstore templates (`vyos/templates/system/quartz-command/`,
priority 995) owned by `system_quartz-command.py` — a symlink to the qfagent
multi-call binary (`.py` suffix mandated by vyos-configd's regex). The XML
mirror (`vyos/xml/system_quartz-command.xml`) is registered with the vyos-1x
xml_ref cache in postinst, plus `qfagent-component-version.xml`
(`quartzfire-qfagent` version 1) for the boot-time config migrator.

### One-shot enroll-token (the pattern, since the repo had none)

A commit script cannot modify the very session it is validating, so:

1. The conf-mode owner parses the token in its verify stage (malformed →
   commit ABORTS naming the bad segment; the token never enters the active
   config on failure) and runs enrollment synchronously — errors surface on
   the committing CLI/WebUI request itself.
2. On success it bumps `/run/qfagent/scrub-request`;
   `quartzfire-qfagent-scrub.path` fires a root one-shot that opens its OWN
   config session (`cli-shell-api setupSession` + `my_delete`/`my_set` +
   `my_commit`, retrying under the commit lock), deletes `enroll-token`,
   persists the token's gateway + port, and saves the boot config via
   vyos-1x's save script (`show configuration` masks secrets; the save
   script is the supported programmatic path).
3. Replay safety: `state.json` records the SHA-256 of the last consumed
   token. A config.boot that still carries the consumed token (saved/booted
   before the scrub landed) re-runs the owner as a no-op that only re-arms
   the scrub — enrollment never re-fires on boot.

## Enrollment TLS trust

WebPKI first (Mozilla roots + configured `ca-certificate` + any previously
pinned CA); if that fails, the token's `sha256:<CA fingerprint>` is matched
against the presented chain — a matching intermediate becomes the sole trust
anchor for a full re-validation, a matching self-signed end-entity is an
exact-cert pin. Chains matching neither are rejected outright. The path that
validated is logged and persisted (`pinned-ca.crt` + `trust_path` in state);
the control channel then trusts pinned-CA-only or WebPKI accordingly.

## Control channel + renewal

Eager mTLS HTTP/2 connect to `assigned_gateway` (fallback: token gateway),
25 s keepalive pings, reconnect with exponential backoff + jitter
(1 s → 5 min cap). The renewal loop wakes at `renew_after` (server-supplied,
else 2/3 lifetime), sends a fresh CSR (same key), persists the new cert, and
reconnects; `<7 days to expiry without successful renewal` raises
`cert_renewal_alarm`.

The `ControlStream` (bidirectional) is opened after connect: the device
announces itself with a `DeviceHello`, then serves the controller's
`ProxyRequest`s — authenticated local management-API calls replayed against
the WebUI backend (`localapi`) — and pushes two unsolicited, fire-and-forget
telemetry streams on independent tickers (both offloaded to blocking tasks,
both first-tick-immediate so the controller has data right after the hello):

* `SecurityTelemetry` every ~60 s (`telemetry`) — per-service security
  counters read from each subsystem's on-disk artifacts.
* `DeviceStats` every ~30 s (`stats`) — device health + traffic: CPU / memory
  / disk gauges (clamped 0–100, CPU sampled over a short in-call window),
  uptime, the outbound (WAN) source address, WAN throughput in bits/sec
  (rx/tx byte-counter deltas between snapshots, summed across the WAN-facing
  interfaces — the firewall's "WAN" zone or interface-group alias, falling
  back to the default-route interface; 0/0 on the first snapshot = "not
  measured"), and the busiest firewall rules by bytes from the nftables
  `vyos_filter` counters. Any unavailable source degrades to a zero/empty
  field, never a dropped message.

## Processes and files

| unit | role |
|---|---|
| `qfagent.service` | the agent daemon (root — key custody + DMI; sandboxed otherwise; `RuntimeDirectoryPreserve` so a pending scrub trigger survives the post-commit restart) |
| `quartzfire-qfagent-scrub.path/.service` | post-commit token scrub (above) |
| (vyos commit) | `system_quartz-command.py` → `qfagent commit` |

| file | writer | purpose |
|---|---|---|
| `/config/quartzfire/qfagent/identity/*` | daemon / commit | keys, certs, host fingerprint |
| `/config/quartzfire/qfagent/state.json` | commit / renewal | durable enrollment state (no secrets) |
| `/config/quartzfire/qfagent/config.json` | commit owner | committed settings snapshot (daemon never needs cli-shell-api) |
| `/run/qfagent/status.json` | daemon | live status for `show quartz-command status` + WebUI |
| `/run/qfagent/scrub-request` | commit owner | path-unit trigger |

## Operator surface

* `show quartz-command status` (op-mode template → `/usr/bin/qf status`).
* `qf status [--json]`, `qf identity regenerate` (confirm; wipes identity +
  enrollment, keeps configured gateway, regenerates keypair + fingerprint),
  `qf prepare-template [--yes]` (also truncates `/etc/machine-id` — systemd
  regenerates it on next boot, the distro templating mechanism — and prints
  what was removed).
* WebUI System → Management: status card (device ID, org, trust path, cert
  expiry + renewal alarm, control channel, host-mismatch banner), enroll
  card (client-side token pre-flight mirroring the Rust parser; enrollment
  errors are the commit errors), connection settings via the VyOS proxy
  (direct commit path, like L2TP), CLI pointers for the destructive
  lifecycle commands. Backend: `GET /api/quartz-command/status`.
* Cloud "Reboot Device" → `POST /api/system/reboot` on the WebUI backend
  (reached over the ControlStream proxy; the cloud gates it to org
  owner/admin). The sandboxed backend can't reboot itself, so it arms the
  root `quartzfire-reboot.path` trigger (same seam as factory reset) and acks
  immediately — the box reboots a couple seconds later, after the ack lands.

## Build / ship / test

`build-deb.sh` (rust:1-bookworm, no protoc) → `packages/qfagent_*.deb`,
baked into the ISO. `cargo test` runs anywhere (Windows/Linux): device-ID
vectors, strict token parser (per-segment + hostile input), identity
lifecycle + host-fingerprint rules, commit decision matrix, root-store
builders, and a mock EnrollmentService over real TLS exercising both trust
paths, chain-matching-neither rejection, and expired-token / bad-signature
error mapping. Frontend: `test/quartz-command.test.ts` covers the token
pre-flight mirror.
