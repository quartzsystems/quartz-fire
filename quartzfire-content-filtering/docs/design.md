# QuartzFire Content Filtering — design

Content Filtering runs **e2guardian in ICAP server mode** as a pure filtering
consumer behind the existing **SSL Inspection** Squid bump. Squid is the sole
TLS terminator and the ICAP client; e2guardian never does its own TLS/MITM and
holds no CA.

```
client ──TLS──▶ Squid (ssl_bump, owns the CA) ──ICAP plaintext──▶ e2guardian
                    │  REQMOD icap://127.0.0.1:1344/request           (127.0.0.1:1344)
                    │  RESPMOD icap://127.0.0.1:1344/response
                    ▼
                 origin
```

## Why stock e2guardian (no custom .deb)

Debian 12 `e2guardian 5.3.5-4+deb12u1` is built `--enable-icap=yes`, proven in
`../quartzfire-ssl-inspection/tests/e2guardian-icap` (forward-proxy smoke test:
banned→block page through the bump, allowed→origin body, filter-down→fail
closed). The package Depends on stock `e2guardian`.

## Load-bearing e2guardian facts (proven, not guessed)

All verified against 5.3.5 in the e2guardian-icap harness. See render.rs.

- **ICAP resource paths are `/request` (REQMOD) and `/response` (RESPMOD)** — not
  `/reqmod`/`/respmod` (400 Bad request).
- **e2guardian is stateful REQMOD→RESPMOD:** it stamps `X-ICAP-E2G` on REQMOD and
  rejects any RESPMOD lacking it (418). Squid must carry it with
  `adaptation_masterx_shared_names X-ICAP-E2G` (emitted by the SSL crate's
  `icap_block`). Missing ⇒ allowed traffic dies on RESPMOD (ERR_ICAP_FAILURE).
- **v5 list format** is `sitelist = 'name=banned,messageno=500,path=…'` (and
  `urllist`/`regexpboollist`/`fileextlist name=bannedextension`/`mimelist
  name=bannedmime`). The pre-v5 `bannedsitelist = '…'` directive is silently
  ignored. Same-`name=` entries MERGE, so QuartzFire lists layer over UT1
  without editing UT1 in place. Exceptions = `name=exception`.
- Phrase lists keep the OLD path format (`weightedphraselist = '/path'`).
- `icapport = <n>` enables ICAP server mode; `transparenthttpsport =` (empty)
  disables e2g's own TLS listener. `defaulticapfiltergroup = 1`.
- `reportinglevel = 3` serves the HTML block template inline; placeholders are
  `-URL- -CATEGORIES- -FILTERGROUP- -IP- -REASONGIVEN-`.
- Filter groups live in `e2guardianfN.conf` (filename DERIVED from the main conf
  name). Clients → group via `authplugin ip.conf` + the `ipgroups` file.

## Config → e2guardian mapping

`service content-filtering` (top-level). See the cstore templates + config.rs.
Each `filter-group` (index+1 = e2guardian filter number; group 1 is the
default/unmatched group) renders one `e2guardianfN.conf`:

| CLI | e2guardian |
|-----|-----------|
| `category <c>` | `sitelist`/`urllist name=banned` → `BLACKLIST_DIR/<c>/{domains,urls}` |
| `block-domain` | `sitelist name=banned` (custom list) |
| `allow-domain` | `sitelist name=exception` (overrides blocks) |
| `block-url-regex` | `regexpboollist name=banned` |
| `block-file-extension` | `fileextlist name=bannedextension` |
| `block-mime-type` | `mimelist name=bannedmime` |
| `blanket-block` | banned sitelist containing `**` (match-all) |
| `phrase-filtering` + `naughtyness-limit` | `weightedphraselist` + `naughtynesslimit` |
| `safe-search` | `regexpreplacelist name=change` (URL rewrite list) |
| `source-address` | `ipgroups`: `<cidr> = filterN` |
| `log level` | `loglevel` (none=0, blocked-only=1, all=3) |

Config files are **derived from a pristine snapshot** of the packaged stock
`e2guardian.conf`/`e2guardianf1.conf` (`*.qz-pristine`), so every mandatory
stock directive survives; QuartzFire overrides are applied and a directive block
is appended between idempotency markers. Never hand-render the whole stock conf.

## Squid coordination (architecture decision)

Content Filtering does **not** own any Squid config. It drives Squid through the
SSL crate's existing ICAP seam: `service quartzfire ssl-inspection` cross-reads
`service content-filtering enable` (`config.rs::read_content_filter`) and, when
set, emits the ICAP block pointing at e2guardian. `qfcf` apply, after
rendering + (re)starting e2guardian, runs `qzssl-apply`, which re-reads the
active config and `squid -k reconfigure`s — adding the ICAP block. Disabling
Content Filtering makes the cross-read return None, so the next `qzssl-apply`
drops the block and traffic flows normally.

Ordering: content-filtering owner priority **992** (after ssl-inspection 991).
On a combined enable there is a brief fail-closed window (Squid gets the ICAP
block before e2guardian is up); this is safe (fail closed, never open).

## Hard dependency

Committing `content-filtering enable` without `ssl-inspection enable` is
**refused** (model.rs validate) — without the bump there is no plaintext to
filter.

## qfcf (multi-call binary)

`commit` (conf-mode owner) · `apply` (resync) · `update` (UT1 updater) ·
`status` · `test-url` · `categories`. Symlink/argv[0] dispatch, same scheme as
qzssl/qzgeo.

## Blocklist updater

`qfcf-update`: download the UT1 tarball (curl) → extract to staging → verify
(≥10 categories with a `domains` file) → atomic directory swap into
`BLACKLIST_DIR` (old tree kept until the new one is committed; rollback on
failure) → `systemctl reload-or-restart e2guardian`. A failure at any step
leaves the previous lists in place. Timer: daily + OnBootSec; WebUI triggers via
the `update-request` path unit. The ISO build overlays a full UT1 snapshot over
the shipped seed for offline-out-of-the-box operation.

## Status / logging

`status.json` under `/run/quartzfire-content-filtering/` (e2guardian active,
ICAP listening, installed category count, last update) is read by the WebUI
backend. Access logging → `/var/log/quartzfire/content-filtering.json` (JSON
lines) feeding the same dashboard/SIEM pipeline as Suricata EVE; rotated by
logrotate.

## Not yet on-device verified

The generated config is proven in a container (`tests/e2guardian-icap` +
`tests/render-filter`); commit/interception/commit-confirm acceptance on a real
VyOS box is deferred (no device here).
