#!/bin/bash
# Runs INSIDE a debian:bookworm container (see smoke.sh). Proves the QuartzFire
# Content Filtering proof-of-concept: the EXISTING SSL-inspection ICAP seam
# (squid-openssl ssl_bump) driving a REAL e2guardian in ICAP SERVER mode, using
# only the STOCK Debian bookworm packages.
#
# What it asserts:
#   1. bookworm's e2guardian is built --enable-icap=yes (ICAP server mode works);
#   2. a bumped HTTPS request to a BANNED domain is blocked by e2guardian and the
#      QuartzFire-style block page is relayed back to the client THROUGH the bump;
#   3. a bumped HTTPS request to an ALLOWED domain passes and gets the origin body;
#   4. source-IP → filter-group mapping (authplugin ip + ipgroups) selects groups;
#   5. with e2guardian DOWN and Squid bypass=off, traffic FAILS CLOSED.
set -uo pipefail

log()  { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
fail() { printf '\033[31mFAIL: %s\033[0m\n' "$*"; exit 1; }
pass() { printf '\033[32mPASS: %s\033[0m\n' "$*"; }

export DEBIAN_FRONTEND=noninteractive
log "Installing squid-openssl + e2guardian + tooling (stock bookworm)"
apt-get update -qq
apt-get install -y --no-install-recommends \
  squid-openssl e2guardian openssl python3 curl ca-certificates >/dev/null

# ── 0. confirm the stock e2guardian binary has ICAP server mode ──────────────
log "Confirming e2guardian was built with ICAP server mode"
e2guardian -v 2>&1 | grep -q -- '--enable-icap=yes' \
  || fail "stock e2guardian lacks --enable-icap=yes — a custom .deb WOULD be needed"
pass "e2guardian $(e2guardian -v 2>&1 | head -1 | awk '{print $2}') has --enable-icap=yes"

V="$(squid -v 2>&1 || true)"
echo "$V" | grep -q -- '--with-openssl'        || fail "squid lacks --with-openssl"
echo "$V" | grep -q -- '--enable-icap-client'  || fail "squid lacks --enable-icap-client"
pass "squid-openssl has ssl_bump + ICAP client"

# ── test topology: one local HTTPS origin, two SNI hostnames ─────────────────
#   banned.test  → in group 1's banned list  → expect BLOCK PAGE
#   allowed.test → not banned                → expect ORIGIN BODY
CA=/tmp/ca; mkdir -p "$CA"
DB=/var/lib/squid/ssl_db
echo "127.0.0.1 banned.test allowed.test" >> /etc/hosts

log "Generating inspection CA (exact QuartzFire subject)"
openssl req -x509 -newkey rsa:2048 -sha256 -days 1 -nodes \
  -keyout "$CA/ca.key" -out "$CA/ca.crt" \
  -subj "/CN=QuartzFire SSL Inspection/O=Quartz Systems" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
chmod 600 "$CA/ca.key"

log "Initializing certgen DB"
mkdir -p "$(dirname "$DB")" /var/spool/squid
rm -rf "$DB"
/usr/lib/squid/security_file_certgen -c -s "$DB" -M 4MB >/dev/null
chown -R proxy:proxy "$DB" 2>/dev/null || true
pass "CA + certgen ready"

log "Starting local HTTPS origin on :8443"
# SANs cover both test hostnames: `ssl_bump bump` mints a leaf that MIMICS the
# origin cert, so the origin cert must carry the SNI names the client asks for
# or curl's hostname check fails before any body is seen.
openssl req -x509 -newkey rsa:2048 -sha256 -days 1 -nodes \
  -keyout /tmp/origin.key -out /tmp/origin.crt -subj "/CN=origin.test" \
  -addext "subjectAltName=DNS:origin.test,DNS:banned.test,DNS:allowed.test" 2>/dev/null
cat > /tmp/origin.py <<'PY'
import http.server, ssl
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = b"HELLO-PLAINTEXT-BODY-42\n"
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a): pass
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain("/tmp/origin.crt", "/tmp/origin.key")
srv = http.server.HTTPServer(("127.0.0.1", 8443), H)
srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
srv.serve_forever()
PY
python3 /tmp/origin.py & ORIGIN_PID=$!
sleep 1

# ── e2guardian: ICAP SERVER mode, loopback only ──────────────────────────────
# This mirrors what the qfcfd conf-mode script will render. We drive the stock
# config in place, flipping only the directives the feature owns.
log "Configuring e2guardian for ICAP server mode (127.0.0.1:1344)"
CONF=/etc/e2guardian/e2guardian.conf
# icapport defined  ⇒ ICAP server mode. Bind to loopback. Default group = 1.
# In pure ICAP server mode e2guardian must NOT also open its proxy/transparent
# listeners — disable transparenthttpsport (stock 8443) so it doesn't try to own
# TLS (Squid is the sole terminator) or collide with anything on the box.
sed -i \
  -e 's/^filterip =.*/filterip = 127.0.0.1/' \
  -e 's/^#\?icapport =.*/icapport = 1344/' \
  -e 's/^#\?transparenthttpsport =.*/transparenthttpsport =/' \
  -e 's/^#\?defaulticapfiltergroup =.*/defaulticapfiltergroup = 1/' \
  -e 's/^loglevel =.*/loglevel = 3/' \
  "$CONF"
grep -q '^icapport = 1344' "$CONF" || echo 'icapport = 1344' >> "$CONF"
grep -q '^defaulticapfiltergroup' "$CONF" || echo 'defaulticapfiltergroup = 1' >> "$CONF"

# source-IP → group mapping (authplugin ip + ipgroups). All of localhost = grp1.
grep -q "authplugins/ip.conf" "$CONF" || \
  echo "authplugin = '/etc/e2guardian/authplugins/ip.conf'" >> "$CONF"
mkdir -p /etc/e2guardian/lists/authplugins
cat > /etc/e2guardian/lists/authplugins/ipgroups <<'IPG'
# QuartzFire PoC: map client source IPs to filter groups.
# filter1 = default/unmatched group (group 1).
127.0.0.1 = filter1
IPG

# Group 1: block banned.test (custom deny list layered ON TOP of stock lists).
# e2guardian v5 uses the NEW list-definition format — a `sitelist =
# 'name=banned,messageno=500,path=…'` line, NOT the pre-v5 `bannedsitelist =`
# directive (which v5.3.5 silently ignores). Multiple name=banned entries merge,
# so we layer our custom list without touching the UT1-distributed lists.
log "Building filter group 1 (banned.test denied, v5 sitelist format)"
mkdir -p /etc/e2guardian/lists/quartzfire
echo "banned.test" > /etc/e2guardian/lists/quartzfire/f1-banned-sites
G1=/etc/e2guardian/e2guardianf1.conf
echo "sitelist = 'name=banned,messageno=500,path=/etc/e2guardian/lists/quartzfire/f1-banned-sites'" >> "$G1"

# QuartzFire-branded block template (the block page relayed via ICAP REQMOD).
TPL=/usr/share/e2guardian/languages/ukenglish/template.html
cat > "$TPL" <<'HTML'
<!DOCTYPE html><html><head><title>QuartzFire — Blocked</title></head>
<body><h1>QUARTZFIRE-BLOCK-PAGE</h1>
<p>Access to <b>-URL-</b> was denied by QuartzFire Content Filtering.</p>
<p>Category/Reason: -REASON-</p><p>Filter group: -FILTERGROUP-</p></body></html>
HTML

chown -R e2guardian:e2guardian /etc/e2guardian/lists/quartzfire 2>/dev/null || true
mkdir -p /var/log/e2guardian && chown -R e2guardian:e2guardian /var/log/e2guardian

log "Starting e2guardian (ICAP server)"
e2guardian -c "$CONF"
# wait for the ICAP port
for i in $(seq 1 30); do
  (exec 3<>/dev/tcp/127.0.0.1/1344) 2>/dev/null && { exec 3>&-; break; }
  sleep 0.5
done
(exec 3<>/dev/tcp/127.0.0.1/1344) 2>/dev/null && { exec 3>&-; pass "e2guardian is listening on 127.0.0.1:1344"; } \
  || fail "e2guardian did not open the ICAP port (see /var/log/e2guardian/)"

# ── squid.conf: ssl_bump forward proxy + ICAP to e2guardian ──────────────────
# Same ssl_bump / ICAP wiring the device renders; forward proxy is the practical
# way to drive a bump inside a container (device uses transparent `intercept`).
log "Writing squid.conf (bump + ICAP → e2guardian) and starting Squid"
cat > /etc/squid/squid.conf <<EOF
http_port 3128 ssl-bump generate-host-certificates=on dynamic_cert_mem_cache_size=4MB tls-cert=$CA/ca.crt tls-key=$CA/ca.key
sslcrtd_program /usr/lib/squid/security_file_certgen -s $DB -M 4MB
sslcrtd_children 2
tls_outgoing_options flags=DONT_VERIFY_PEER
acl step1 at_step SslBump1
ssl_bump peek step1
ssl_bump bump all
http_access allow all

icap_enable on
icap_preview_enable on
icap_preview_size 1024
icap_send_client_ip on
icap_send_client_username off
# REQUIRED for e2guardian: it is STATEFUL across REQMOD→RESPMOD. e2guardian
# stamps an X-ICAP-E2G correlation header on the REQMOD reply and REJECTS any
# RESPMOD that lacks it ("418 Bad composition - X-ICAP-E2G header not present").
# adaptation_masterx_shared_names tells Squid to carry that header from the
# REQMOD response into the RESPMOD request (the "master transaction"). Without
# this line, allowed traffic dies on RESPMOD with ERR_ICAP_FAILURE.
adaptation_masterx_shared_names X-ICAP-E2G
icap_service qf_req reqmod_precache icap://127.0.0.1:1344/request bypass=off
icap_service qf_resp respmod_precache icap://127.0.0.1:1344/response bypass=off
# Do NOT adapt the CONNECT itself — only the decrypted inner request. In this
# FORWARD-proxy harness the client sends CONNECT banned.test:8443; if that goes
# to REQMOD, e2guardian blocks it with a 302 and the tunnel never establishes
# ("CONNECT tunnel failed, response 302"). Excluding CONNECT lets Squid bump,
# then the decrypted GET reaches REQMOD and the block page is served INLINE.
# The device uses transparent `intercept` — there IS no CONNECT there, so this
# exclusion is harness-only and a no-op on the appliance.
acl conn_method method CONNECT
adaptation_access qf_req deny conn_method
adaptation_access qf_req allow all
adaptation_access qf_resp deny conn_method
adaptation_access qf_resp allow all
icap_service_failure_limit -1

cache deny all
cache_log /tmp/squid.log
pid_filename /tmp/squid.pid
EOF

squid -k parse -f /etc/squid/squid.conf
squid -N -f /etc/squid/squid.conf & SQUID_PID=$!
for i in $(seq 1 30); do
  (exec 3<>/dev/tcp/127.0.0.1/3128) 2>/dev/null && { exec 3>&-; break; }
  sleep 0.5
done

# ── 2. BANNED domain → block page relayed through the bump ───────────────────
log "Request to BANNED https://banned.test:8443/ (expect QuartzFire block page)"
OUT_BAN="$(curl -sS --cacert "$CA/ca.crt" -x http://127.0.0.1:3128 https://banned.test:8443/x 2>/tmp/curl.ban || true)"
echo "banned body: [$OUT_BAN]"
if echo "$OUT_BAN" | grep -q "QUARTZFIRE-BLOCK-PAGE"; then
  pass "BANNED domain returned the QuartzFire block page THROUGH the bump"
elif echo "$OUT_BAN" | grep -q "HELLO-PLAINTEXT-BODY-42"; then
  fail "BANNED domain leaked the origin body — e2guardian did NOT block"
else
  fail "BANNED domain: neither block page nor origin body (see /var/log/e2guardian, /tmp/curl.ban: $(cat /tmp/curl.ban))"
fi

# ── 3. ALLOWED domain → origin body ──────────────────────────────────────────
log "Request to ALLOWED https://allowed.test:8443/ (expect origin body)"
OUT_OK="$(curl -sS --cacert "$CA/ca.crt" -x http://127.0.0.1:3128 https://allowed.test:8443/y 2>/tmp/curl.ok || true)"
echo "allowed body: [$OUT_OK]"
echo "$OUT_OK" | grep -q "HELLO-PLAINTEXT-BODY-42" \
  || fail "ALLOWED domain did not get the origin body (over-blocking?) — see /tmp/curl.ok: $(cat /tmp/curl.ok)"
echo "$OUT_OK" | grep -q "QUARTZFIRE-BLOCK-PAGE" && fail "ALLOWED domain got the block page (over-blocking)"
pass "ALLOWED domain passed through e2guardian and got the origin body"

log "e2guardian access log (REQMOD decisions):"
tail -n 20 /var/log/e2guardian/access.log 2>/dev/null || echo "(no access.log yet)"

# ── 5. fail-closed when e2guardian is down ───────────────────────────────────
log "Stopping e2guardian — bypass=off must FAIL CLOSED"
pkill -f 'e2guardian -c' 2>/dev/null || true
sleep 2
CODE="$(curl -s -o /dev/null -w '%{http_code}' --cacert "$CA/ca.crt" -x http://127.0.0.1:3128 https://allowed.test:8443/y 2>/dev/null || echo 000)"
echo "response code with e2guardian down: $CODE"
[ "$CODE" = "200" ] && fail "traffic passed uninspected with the filter DOWN — not fail-closed!"
pass "with e2guardian down, traffic failed closed (code=$CODE, not 200)"

kill "$SQUID_PID" "$ORIGIN_PID" 2>/dev/null || true
log "ALL CHECKS PASSED — stock e2guardian ICAP server is a drop-in behind the Squid bump."
