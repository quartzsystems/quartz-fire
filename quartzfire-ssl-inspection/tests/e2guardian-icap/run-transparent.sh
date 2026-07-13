#!/bin/bash
# Runs INSIDE a debian:bookworm container started with --cap-add=NET_ADMIN
# (see smoke.sh). This is the DEVICE-REPRESENTATIVE proof: TRANSPARENT
# interception via an nft/iptables REDIRECT (exactly like qz_ssl's prerouting
# redirect on the appliance), squid-openssl ssl_bump, and a REAL stock
# e2guardian in ICAP server mode. No forward proxy, so no CONNECT tunnel — the
# decrypted GET reaches REQMOD directly, which is how the block page is served
# INLINE through the bump (the forward-proxy harness's 302-on-CONNECT is an
# artifact of CONNECT, not how the device behaves).
#
# Asserts acceptance criteria #1/#2/#6:
#   * bumped HTTPS to a BANNED domain → QuartzFire block page THROUGH the bump;
#   * bumped HTTPS to an ALLOWED domain → origin body (no over-block);
#   * e2guardian DOWN + Squid bypass=off → FAIL CLOSED.
set -uo pipefail
log()  { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
fail() { printf '\033[31mFAIL: %s\033[0m\n' "$*"; exit 1; }
pass() { printf '\033[32mPASS: %s\033[0m\n' "$*"; }

export DEBIAN_FRONTEND=noninteractive
log "Installing squid-openssl + e2guardian + iptables"
apt-get update -qq
apt-get install -y --no-install-recommends \
  squid-openssl e2guardian openssl python3 curl iptables ca-certificates >/dev/null

e2guardian -v 2>&1 | grep -q -- '--enable-icap=yes' || fail "e2guardian lacks --enable-icap=yes"
pass "stock e2guardian 5.3.5 has ICAP server mode"

CA=/tmp/ca; mkdir -p "$CA"; DB=/var/lib/squid/ssl_db
INTERCEPT=3129
echo "127.0.0.1 banned.test allowed.test" >> /etc/hosts

log "CA + certgen"
openssl req -x509 -newkey rsa:2048 -sha256 -days 1 -nodes \
  -keyout "$CA/ca.key" -out "$CA/ca.crt" \
  -subj "/CN=QuartzFire SSL Inspection/O=Quartz Systems" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:0" 2>/dev/null
chmod 600 "$CA/ca.key"
mkdir -p "$(dirname "$DB")" /var/spool/squid; rm -rf "$DB"
/usr/lib/squid/security_file_certgen -c -s "$DB" -M 4MB >/dev/null
chown -R proxy:proxy "$DB" 2>/dev/null || true

log "Local HTTPS origin on :8443 (SANs cover both test hosts)"
openssl req -x509 -newkey rsa:2048 -sha256 -days 1 -nodes \
  -keyout /tmp/o.key -out /tmp/o.crt -subj "/CN=origin.test" \
  -addext "subjectAltName=DNS:origin.test,DNS:banned.test,DNS:allowed.test" 2>/dev/null
cat > /tmp/origin.py <<'PY'
import http.server, ssl
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        b=b"HELLO-PLAINTEXT-BODY-42\n"
        self.send_response(200); self.send_header("Content-Type","text/plain")
        self.send_header("Content-Length",str(len(b))); self.end_headers(); self.wfile.write(b)
    def log_message(self,*a): pass
ctx=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); ctx.load_cert_chain("/tmp/o.crt","/tmp/o.key")
s=http.server.HTTPServer(("127.0.0.1",8443),H); s.socket=ctx.wrap_socket(s.socket,server_side=True)
s.serve_forever()
PY
python3 /tmp/origin.py & ORIGIN_PID=$!; sleep 1

# ── e2guardian: ICAP server, loopback, group 1 bans banned.test (v5 format) ──
log "Configuring e2guardian ICAP server + group 1"
CONF=/etc/e2guardian/e2guardian.conf
sed -i \
  -e 's/^filterip =.*/filterip = 127.0.0.1/' \
  -e 's/^#\?icapport =.*/icapport = 1344/' \
  -e 's/^#\?transparenthttpsport =.*/transparenthttpsport =/' \
  -e 's/^#\?defaulticapfiltergroup =.*/defaulticapfiltergroup = 1/' \
  -e 's/^loglevel =.*/loglevel = 3/' "$CONF"
grep -q '^icapport = 1344' "$CONF" || echo 'icapport = 1344' >> "$CONF"
mkdir -p /etc/e2guardian/lists/quartzfire
echo "banned.test" > /etc/e2guardian/lists/quartzfire/f1-banned-sites
echo "sitelist = 'name=banned,messageno=500,path=/etc/e2guardian/lists/quartzfire/f1-banned-sites'" \
  >> /etc/e2guardian/e2guardianf1.conf
# QuartzFire-branded block template.
cat > /usr/share/e2guardian/languages/ukenglish/template.html <<'HTML'
<!DOCTYPE html><html><head><title>QuartzFire — Blocked</title></head>
<body><h1>QUARTZFIRE-BLOCK-PAGE</h1>
<p>Access to <b>-URL-</b> was denied by QuartzFire Content Filtering.</p></body></html>
HTML
mkdir -p /var/log/e2guardian && chown -R e2guardian:e2guardian /var/log/e2guardian
rm -f /run/e2guardian.pid
e2guardian -c "$CONF"
for i in $(seq 1 30); do (exec 3<>/dev/tcp/127.0.0.1/1344) 2>/dev/null && { exec 3>&-; break; }; sleep 0.5; done
(exec 3<>/dev/tcp/127.0.0.1/1344) 2>/dev/null && { exec 3>&-; pass "e2guardian ICAP up on :1344"; } || fail "e2guardian ICAP port not open"

# ── Squid: transparent intercept + ICAP → e2guardian (/request,/response) ────
log "Squid transparent intercept + ICAP"
cat > /etc/squid/squid.conf <<EOF
http_port 3128
https_port $INTERCEPT intercept ssl-bump generate-host-certificates=on dynamic_cert_mem_cache_size=4MB tls-cert=$CA/ca.crt tls-key=$CA/ca.key
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
icap_service qf_req reqmod_precache icap://127.0.0.1:1344/request bypass=off
icap_service qf_resp respmod_precache icap://127.0.0.1:1344/response bypass=off
adaptation_access qf_req allow all
adaptation_access qf_resp allow all
icap_service_failure_limit -1
cache deny all
cache_log /tmp/squid.log
pid_filename /tmp/squid.pid
EOF
squid -k parse -f /etc/squid/squid.conf
squid -N -f /etc/squid/squid.conf & SQUID_PID=$!
for i in $(seq 1 30); do (exec 3<>/dev/tcp/127.0.0.1/$INTERCEPT) 2>/dev/null && { exec 3>&-; break; }; sleep 0.5; done

# ── Transparent REDIRECT: client 443→intercept, EXEMPT the proxy's own egress ─
# Mirrors qz_ssl prerouting redirect on the box. `owner ! --uid-owner proxy`
# stops Squid's origin fetch (also :8443) from looping back into itself.
log "Installing REDIRECT (dport 8443 → :$INTERCEPT, proxy-exempt)"
PROXY_UID="$(id -u proxy)"
iptables -t nat -A OUTPUT -p tcp --dport 8443 -m owner --uid-owner "$PROXY_UID" -j RETURN
iptables -t nat -A OUTPUT -p tcp --dport 8443 -j REDIRECT --to-ports $INTERCEPT
pass "redirect installed"

# ── BANNED: block page THROUGH the bump ──────────────────────────────────────
log "GET https://banned.test:8443/x (transparent, expect block page)"
BAN="$(curl -sS --cacert "$CA/ca.crt" https://banned.test:8443/x 2>/tmp/c.ban || true)"
echo "banned body: [$BAN]"
if echo "$BAN" | grep -q "QUARTZFIRE-BLOCK-PAGE"; then
  pass "BANNED → QuartzFire block page served through the bumped HTTPS session"
elif echo "$BAN" | grep -q "HELLO-PLAINTEXT-BODY-42"; then
  fail "BANNED leaked origin body — e2guardian did not block"
else
  fail "BANNED: unexpected ($(cat /tmp/c.ban))"
fi

# ── ALLOWED: origin body ─────────────────────────────────────────────────────
log "GET https://allowed.test:8443/y (transparent, expect origin body)"
OK="$(curl -sS --cacert "$CA/ca.crt" https://allowed.test:8443/y 2>/tmp/c.ok || true)"
echo "allowed body: [$OK]"
echo "$OK" | grep -q "HELLO-PLAINTEXT-BODY-42" || fail "ALLOWED did not get origin body ($(cat /tmp/c.ok))"
echo "$OK" | grep -q "QUARTZFIRE-BLOCK-PAGE" && fail "ALLOWED got block page (over-block)"
pass "ALLOWED → origin body (no over-block)"

log "e2guardian access log:"; tail -n 10 /var/log/e2guardian/access.log 2>/dev/null || echo "(none)"

# ── FAIL CLOSED ──────────────────────────────────────────────────────────────
log "Stop e2guardian — bypass=off must FAIL CLOSED"
pkill -9 -f 'e2guardian -c' 2>/dev/null || true; rm -f /run/e2guardian.pid; sleep 2
CODE="$(curl -s -o /dev/null -w '%{http_code}' --cacert "$CA/ca.crt" https://allowed.test:8443/y 2>/dev/null || echo 000)"
echo "code with e2guardian down: $CODE"
[ "$CODE" = "200" ] && fail "passed uninspected with filter DOWN — not fail-closed"
pass "filter down → fail closed (code=$CODE)"

kill "$SQUID_PID" "$ORIGIN_PID" 2>/dev/null || true
log "ALL CHECKS PASSED — transparent bump + stock e2guardian ICAP serves the block page inline."
