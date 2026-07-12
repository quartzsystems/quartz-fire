# Content Filtering PoC — Squid bump + stock e2guardian ICAP server

Proof (Phase 1) that QuartzFire Content Filtering can run **stock Debian 12
`e2guardian` in ICAP server mode** behind the existing SSL-inspection Squid
bump. No custom `.deb` is required. Run:

```sh
wsl bash smoke.sh              # forward-proxy harness — AUTHORITATIVE PoC
wsl bash smoke.sh transparent  # transparent intercept (see limitation below)
```

`smoke.sh` stands up one throwaway `debian:bookworm` container, installs
**stock** `squid-openssl` + `e2guardian`, and asserts acceptance criteria
#1/#2/#6. Last run of the forward-proxy harness: **ALL CHECKS PASSED**
(2026-07-12).

> **Transparent harness — known limitation:** `run-transparent.sh` uses an
> iptables REDIRECT to mirror the device's `qz_ssl` prerouting redirect, but on
> a single loopback host Squid will not cleanly intercept a connection whose
> client and origin are both `127.0.0.1` (TLS handshake times out). It is kept
> as documentation of the device topology; full transparent verification needs
> a network namespace / two IPs and is deferred to on-device testing. The
> forward-proxy harness is the authoritative Phase-1 proof, and the inline
> block-page behavior it exercises is the same code path the device hits after
> the bump.

## What was proven

1. **Stock bookworm `e2guardian 5.3.5-4+deb12u1` is built `--enable-icap=yes`.**
   `e2guardian -v` confirms it. → We ship the stock package; no ICAP rebuild.
2. A bumped HTTPS request to a **banned** domain gets the **QuartzFire block
   page served inline through the bump** (REQMOD block).
3. A bumped HTTPS request to an **allowed** domain gets the **origin body**
   (RESPMOD passes it through) — no over-blocking.
4. With **e2guardian down and `bypass=off`, traffic fails closed** (HTTP 500),
   never uninspected.

## Non-obvious findings (these drive the real templates — do NOT guess)

- **ICAP resource paths are `/request` and `/response`, NOT `/reqmod`/`/respmod`.**
  e2guardian returns `400 Bad request` for `/reqmod`. (The feature spec's
  `/reqmod`/`/respmod` are wrong for e2guardian; the SSL crate's render already
  defaults to `request`/`response`, which is correct.)
- **e2guardian is STATEFUL across REQMOD→RESPMOD.** It stamps an `X-ICAP-E2G`
  correlation header on the REQMOD reply and **rejects any RESPMOD without it**
  (`418 Bad composition - X-ICAP-E2G header not present`). Squid must be told to
  carry it across the master transaction:
  ```
  adaptation_masterx_shared_names X-ICAP-E2G
  ```
  Missing this ⇒ every *allowed* site dies on RESPMOD with `ERR_ICAP_FAILURE`.
  **This line must be added to the SSL crate's `icap_block` render** (it is not
  there today).
- **e2guardian v5 uses a NEW list-definition format.** The pre-v5
  `bannedsitelist = '/path'` directive is **silently ignored** by 5.3.5. Lists
  are declared in `e2guardianfN.conf` as:
  ```
  sitelist = 'name=banned,messageno=500,path=/etc/e2guardian/lists/quartzfire/f1-banned-sites'
  urllist  = 'name=banned,messageno=501,path=…'
  sitelist = 'name=exception,messageno=602,path=…'   # allow / bypass
  ```
  Multiple entries with the same `name=` **merge**, so QuartzFire layers its
  custom allow/block lists on top of the UT1 lists without editing them.
- **`groupmode` is deprecated in 5.3.5** ("NO LONGER SUPPORTED"). Blanket-block
  is done with an exception/banned list strategy, not `groupmode`.
- The **filter-group config filename is derived from the main config filename**
  (`e2guardian.conf` → `e2guardianf1.conf`, `f2`, …). Keep the stock naming.
- In **pure ICAP server mode**, disable e2guardian's own listeners
  (`transparenthttpsport =` empty) so it never tries to own TLS — Squid is the
  sole terminator (per [ssl-inspection design.md](../../docs/design.md)).
- Client→group mapping = `authplugin '…/authplugins/ip.conf'` + an `ipgroups`
  file (`<cidr> = filterN`); unmatched clients fall to `defaulticapfiltergroup`.
- The forward-proxy harness must exclude the **CONNECT** method from adaptation
  (`adaptation_access qf_req deny CONNECT`), else e2g blocks the CONNECT with a
  302 and the tunnel never establishes. This is a **forward-proxy artifact**:
  the device uses transparent `intercept`, which has no CONNECT, so the device
  template does not need it (see `run-transparent.sh`, which needs no such line).

## Proven config (verbatim from a passing run)

### Squid drop-in (added when Content Filtering is enabled)
```
icap_enable on
icap_preview_enable on
icap_preview_size 1024
icap_send_client_ip on
icap_send_client_username off
adaptation_masterx_shared_names X-ICAP-E2G
icap_service qf_req  reqmod_precache  icap://127.0.0.1:1344/request  bypass=off
icap_service qf_resp respmod_precache icap://127.0.0.1:1344/response bypass=off
adaptation_access qf_req  allow all
adaptation_access qf_resp allow all
icap_service_failure_limit -1
```
(`bypass=off` = fail closed. `bypass=on` when log-level policy chooses fail-open.)

### e2guardian.conf (feature-owned directives)
```
filterip = 127.0.0.1
icapport = 1344                 # defining this ENABLES ICAP server mode
transparenthttpsport =          # disable e2g's own TLS listener
filterports = 8080              # loopback only; harmless in ICAP mode
defaulticapfiltergroup = 1      # unmatched clients → group 1
filtergroups = <N>
authplugin = '/etc/e2guardian/authplugins/ip.conf'
loglevel = 3
```

### e2guardianf1.conf (per filter group)
```
groupname = 'default'
sitelist = 'name=banned,messageno=500,path=/etc/e2guardian/lists/quartzfire/f1-banned-sites'
sitelist = 'name=exception,messageno=602,path=/etc/e2guardian/lists/quartzfire/f1-allow-sites'
weightedphraselist = '/etc/e2guardian/lists/weightedphraselist'   # phrase scanning
naughtynesslimit = 150
```

### /etc/e2guardian/lists/authplugins/ipgroups
```
10.0.10.0/24 = filter1
10.0.20.0/24 = filter2
```
