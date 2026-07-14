# qfdevd — device/client monitoring

qfdevd builds and maintains the inventory of clients seen on the LAN that backs
the QuartzFire WebUI's **Monitoring → Devices** page (a Meraki-style client
list). It is a small root-capable collector; the WebUI backend (unprivileged)
only reads its output.

## Architecture

```
  ip -j neigh ─┐
  Kea leases  ─┼─▶ qfdevd ──▶ /config/quartzfire/devices.db (SQLite, WAL)
  conntrack   ─┘                     ▲
                                     │ read inventory / write description
                             quartzfire-webui (Axum, unprivileged)
```

Same pattern as the other QuartzFire daemons: privileged collection lives in a
sandboxed daemon; the WebUI stays unprivileged and reads a shared artifact. The
artifact here is a SQLite database (WAL) rather than a status JSON, because the
list is large, queryable, and one column (`description`) is written by the WebUI.

## Collectors

- **Neighbor table** (`ip -j neigh show`, ~20 s): the online/offline signal.
  REACHABLE/DELAY/PROBE ⇒ online; the freshness rule (recent traffic within
  `online_timeout_secs`) also keeps a device online between probes.
- **Kea DHCPv4 leases** (memfile CSV, ~30 s): IP, MAC, hostname, lease expiry.
  Fixed reservations are detected from the Kea config (`hw-address`) and flagged
  Static.
- **conntrack accounting** (needs `net.netfilter.nf_conntrack_acct=1`): a
  periodic `conntrack -L` snapshot credits long-lived flows, and a
  `conntrack -E -e DESTROY` event stream credits short flows that start and end
  between snapshots. Both feed one accounting map keyed per flow, so bytes are
  never double-counted; deltas land in 5-minute `usage_buckets` for 1h/24h/7d.
- **Fingerprinting**: MAC OUI vendor (IEEE `ieee-data`) + DHCP-hostname
  heuristics → `client_type` / `os_guess`. DHCP option 55/60 and a Zeek
  enrichment feed are stubbed for the future (see `fingerprint.rs`).

## Storage

`devices` (mac PK, description, first/last seen, hostname, vendor, client_type,
os_guess, current_ip, interface, vlan, dhcp_static, lease_expiry, neigh_state,
online) and `usage_buckets` (mac, bucket_ts, bytes_in, bytes_out). Usage buckets
prune after 30 days, devices after 90 (configurable). The DB is created
group-`quartzfire`, mode 0660, so the DynamicUser WebUI backend can open it.

## Ownership contract

qfdevd owns every collected column and **never** writes `description`. The WebUI
owns `description` and **never** writes a collected column. So the shared WAL DB
needs no locking protocol beyond SQLite's own.
