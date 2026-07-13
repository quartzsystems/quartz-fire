#!/bin/bash
# Runs INSIDE a rust:1-bookworm container (debian bookworm + cargo). Proves that
# the config qfcf RENDERS (not a hand-written config) actually filters behind a
# real squid-openssl bump + stock e2guardian ICAP server.
#
#   1. build qfcf from /src;
#   2. `qfcf render model.json` writes the e2guardian config from a Model;
#   3. seed a category list, start e2guardian with the RENDERED config;
#   4. drive bumped HTTPS through Squid (ICAP → e2guardian) and assert:
#        banned category domain  → QuartzFire block page (our rendered template),
#        custom block-domain      → blocked,
#        allow-domain override    → allowed even though its parent is blocked,
#        unrelated domain         → origin body.
set -uo pipefail
log()  { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
fail() { printf '\033[31mFAIL: %s\033[0m\n' "$*"; exit 1; }
pass() { printf '\033[32mPASS: %s\033[0m\n' "$*"; }

export DEBIAN_FRONTEND=noninteractive
log "Installing squid-openssl + e2guardian"
apt-get update -qq
apt-get install -y --no-install-recommends \
  squid-openssl e2guardian openssl curl ca-certificates >/dev/null

log "Building qfcf"
cd /src
cargo build --release --quiet 2>/dev/null || cargo build --release
QFCF=/src/target/release/qfcf
"$QFCF" 2>&1 | head -1 || true

# ── the Model qfcf will render (as the conf-mode owner would produce) ─────────
# default group: block category "malware", custom block-domain, and an
# allow-domain that overrides the category for one subdomain.
cat > /tmp/model.json <<'JSON'
{
  "enabled": true,
  "listen_port": 1344,
  "ssl_inspection_enabled": true,
  "log_level": "All",
  "blocklists": { "sources": [], "auto_update": false, "update_interval_hours": 24 },
  "block_page": { "message": "BLOCKED-BY-QFCF-RENDER", "contact": "it@quartz.systems" },
  "groups": [
    {
      "name": "default",
      "description": null,
      "source_address": [],
      "blanket_block": false,
      "categories": ["malware"],
      "block_domains": ["evil.test"],
      "allow_domains": ["safe.malware-host.test"],
      "block_url_regex": [],
      "phrase_filtering": false,
      "naughtyness_limit": 150,
      "safe_search": false,
      "block_file_extensions": [],
      "block_mime_types": []
    }
  ]
}
JSON

# Category data the render references (BLACKLIST_DIR/malware/domains).
mkdir -p /var/lib/quartzfire/content-filtering/blacklists/malware
cat > /var/lib/quartzfire/content-filtering/blacklists/malware/domains <<'EOF'
malware-host.test
EOF
: > /var/lib/quartzfire/content-filtering/blacklists/malware/urls

log "Rendering e2guardian config with qfcf"
"$QFCF" render /tmp/model.json || fail "qfcf render failed"
echo "--- generated e2guardianf1.conf QuartzFire block ---"
sed -n '/>>> QuartzFire/,/<<< QuartzFire/p' /etc/e2guardian/e2guardianf1.conf
echo "--- key e2guardian.conf overrides ---"
grep -E '^(icapport|transparenthttpsport|defaulticapfiltergroup|reportinglevel|language|filterip) ' /etc/e2guardian/e2guardian.conf

# ── test topology ─────────────────────────────────────────────────────────────
CA=/tmp/ca; mkdir -p "$CA"; DB=/var/lib/squid/ssl_db
# malware-host.test (blocked by category), safe.malware-host.test (allow override),
# evil.test (custom block), ok.test (allowed).
echo "127.0.0.1 malware-host.test safe.malware-host.test evil.test ok.test" >> /etc/hosts
openssl req -x509 -newkey rsa:2048 -sha256 -days 1 -nodes -keyout "$CA/ca.key" -out "$CA/ca.crt" \
  -subj "/CN=QuartzFire SSL Inspection/O=Quartz Systems" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:0" 2>/dev/null
chmod 600 "$CA/ca.key"
mkdir -p "$(dirname "$DB")" /var/spool/squid; rm -rf "$DB"
/usr/lib/squid/security_file_certgen -c -s "$DB" -M 4MB >/dev/null
chown -R proxy:proxy "$DB" 2>/dev/null || true

openssl req -x509 -newkey rsa:2048 -sha256 -days 1 -nodes -keyout /tmp/o.key -out /tmp/o.crt \
  -subj "/CN=ok.test" \
  -addext "subjectAltName=DNS:malware-host.test,DNS:safe.malware-host.test,DNS:evil.test,DNS:ok.test" 2>/dev/null
cat > /tmp/origin.py <<'PY'
import http.server, ssl
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        b=b"ORIGIN-BODY-OK\n"
        self.send_response(200); self.send_header("Content-Type","text/plain")
        self.send_header("Content-Length",str(len(b))); self.end_headers(); self.wfile.write(b)
    def log_message(self,*a): pass
ctx=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); ctx.load_cert_chain("/tmp/o.crt","/tmp/o.key")
s=http.server.HTTPServer(("127.0.0.1",8443),H); s.socket=ctx.wrap_socket(s.socket,server_side=True)
s.serve_forever()
PY
python3 /tmp/origin.py & ORIGIN_PID=$!; sleep 1

log "Starting e2guardian (rendered config)"
mkdir -p /var/log/e2guardian && chown -R e2guardian:e2guardian /var/log/e2guardian
rm -f /run/e2guardian.pid
e2guardian -c /etc/e2guardian/e2guardian.conf
for i in $(seq 1 30); do (exec 3<>/dev/tcp/127.0.0.1/1344) 2>/dev/null && { exec 3>&-; break; }; sleep 0.5; done
(exec 3<>/dev/tcp/127.0.0.1/1344) 2>/dev/null && { exec 3>&-; pass "e2guardian ICAP up (rendered config parsed & bound)"; } \
  || fail "e2guardian did not start on the rendered config"

log "Starting Squid (bump + ICAP, proven directives incl. masterx)"
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
adaptation_masterx_shared_names X-ICAP-E2G
icap_service qf_req reqmod_precache icap://127.0.0.1:1344/request bypass=off
icap_service qf_resp respmod_precache icap://127.0.0.1:1344/response bypass=off
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
for i in $(seq 1 30); do (exec 3<>/dev/tcp/127.0.0.1/3128) 2>/dev/null && { exec 3>&-; break; }; sleep 0.5; done

get() { curl -sS --cacert "$CA/ca.crt" -x http://127.0.0.1:3128 "$1" 2>/dev/null; }

log "category block: https://malware-host.test:8443/"
B="$(get https://malware-host.test:8443/x)"
echo "$B" | grep -q "BLOCKED-BY-QFCF-RENDER" && pass "category domain blocked with rendered block page" \
  || { echo "$B" | head -c 200; fail "category domain not blocked by rendered config"; }

log "custom block-domain: https://evil.test:8443/"
E="$(get https://evil.test:8443/x)"
echo "$E" | grep -q "BLOCKED-BY-QFCF-RENDER" && pass "custom block-domain blocked" \
  || fail "custom block-domain not blocked"

log "allow-domain override: https://safe.malware-host.test:8443/"
S="$(get https://safe.malware-host.test:8443/x)"
echo "$S" | grep -q "ORIGIN-BODY-OK" && pass "allow-domain overrode the category block" \
  || { echo "$S" | head -c 200; fail "allow-domain did not override the category block"; }

log "unrelated allowed: https://ok.test:8443/"
O="$(get https://ok.test:8443/y)"
echo "$O" | grep -q "ORIGIN-BODY-OK" && pass "unrelated domain allowed (RESPMOD passthrough via masterx)" \
  || { echo "$O" | head -c 200; fail "unrelated domain blocked (over-block or RESPMOD failure)"; }

kill "$SQUID_PID" "$ORIGIN_PID" 2>/dev/null || true
log "ALL CHECKS PASSED — the qfcf-RENDERED e2guardian config filters correctly behind the bump."
