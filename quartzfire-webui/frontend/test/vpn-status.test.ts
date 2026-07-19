// Parser tests for the VPN Status tabs (op-mode text → structured data).
//
// These exercise the REAL parsers in lib/vpn-status against realistically
// column-aligned op-mode output (VyOS uses `tabulate`, which pads columns to a
// fixed width — the crucial property the fixed-width parser relies on). Run
// with `npm test`.

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseFixedTable, colIndex, parseWireguardStatus } from "../lib/vpn-status.ts";

/// Build a tabulate-style block: every column padded to a fixed width so header
/// and data offsets line up exactly, the way VyOS emits them.
function aligned(headers: string[], rows: string[][], widths: number[]): string {
  const fmt = (cells: string[]) => cells.map((c, i) => (c ?? "").padEnd(widths[i])).join("").trimEnd();
  return [fmt(headers), ...rows.map(fmt)].join("\n");
}

test("parseFixedTable recovers headers and cells", () => {
  const text = aligned(
    ["Connection", "State", "Uptime", "Bytes In/Out", "Remote ID", "Proposal"],
    [
      ["PEER-tunnel-1", "up", "16m30s", "168B/168B", "192.168.1.2", "AES_CBC_128/HMAC_SHA1_96/MODP_2048"],
      ["PEER2-tunnel-1", "down", "N/A", "0B/0B", "198.51.100.1", "N/A"],
    ],
    [18, 8, 10, 16, 16, 40],
  );

  const table = parseFixedTable(text, "Connection");
  assert.deepEqual(table.headers, ["Connection", "State", "Uptime", "Bytes In/Out", "Remote ID", "Proposal"]);
  assert.equal(table.rows.length, 2);
  assert.equal(table.rows[0][0], "PEER-tunnel-1");
  assert.equal(table.rows[0][1], "up");
  // "Bytes In/Out" has a single internal space and must stay one column.
  assert.equal(table.rows[0][3], "168B/168B");
  assert.equal(table.rows[0][5], "AES_CBC_128/HMAC_SHA1_96/MODP_2048");
  assert.equal(table.rows[1][1], "down");
});

test("parseFixedTable keeps empty cells aligned (no column shift)", () => {
  // The middle 'Static IP' cell is empty for the first row — a naive whitespace
  // split would shift 'State' left into it. Fixed-offset slicing must not.
  const text = aligned(
    ["Username", "Static IP", "State"],
    [
      ["alice", "", "active"],
      ["bob", "10.10.0.50", "active"],
    ],
    [14, 16, 10],
  );

  const table = parseFixedTable(text, "Username");
  const stateCol = colIndex(table, "State");
  assert.equal(stateCol, 2);
  assert.equal(table.rows[0][1], ""); // alice has no static IP
  assert.equal(table.rows[0][stateCol], "active"); // still aligned
  assert.equal(table.rows[1][1], "10.10.0.50");
});

test("parseFixedTable skips legend/title and separator lines", () => {
  const text = [
    "Codes: S - State, L - Link, u - Up, D - Down",
    "",
    "Interface    IP Address       S/L    Description",
    "-----------  ---------------  -----  -----------",
    "vtun0        10.255.0.1/30    u/u    branch",
    "vtun1        -                D/D    ",
  ].join("\n");

  const table = parseFixedTable(text, "Interface");
  assert.deepEqual(table.headers, ["Interface", "IP Address", "S/L", "Description"]);
  assert.equal(table.rows.length, 2);
  assert.equal(table.rows[0][0], "vtun0");
  assert.equal(colIndex(table, "S/L"), 2);
  assert.equal(table.rows[0][2], "u/u");
  assert.equal(table.rows[1][2], "D/D");
});

test("parseFixedTable returns empty when the header keyword is absent", () => {
  const table = parseFixedTable("IPsec process is not running\n", "Connection");
  assert.deepEqual(table.headers, []);
  assert.deepEqual(table.rows, []);
});

test("parseWireguardStatus parses interface/peer blocks", () => {
  const text = [
    "interface: wg0",
    "  address: 10.0.0.1/24",
    "  public key: AbCdEf0123456789PublicKeyValue=",
    "  private key: (hidden)",
    "  listening port: 51820",
    "",
    "  peer: office",
    "    public key: PeerPubKeyOfficeValue000000000=",
    "    endpoint: 203.0.113.5:51820",
    "    allowed ips: 10.0.0.2/32",
    "    latest handshake: 1 minute, 5 seconds ago",
    "    transfer: 1.23 MiB received, 4.56 MiB sent",
    "    persistent keepalive: every 25 seconds",
    "",
    "  peer: roaming",
    "    public key: PeerPubKeyRoamingValue00000000=",
    "    allowed ips: 10.0.0.3/32",
    "    latest handshake: (never)",
  ].join("\n");

  const ifaces = parseWireguardStatus(text);
  assert.equal(ifaces.length, 1);
  assert.equal(ifaces[0].name, "wg0");
  assert.equal(ifaces[0].address, "10.0.0.1/24");
  assert.equal(ifaces[0].listening_port, "51820");
  assert.equal(ifaces[0].peers.length, 2);

  const office = ifaces[0].peers[0];
  assert.equal(office.name, "office");
  assert.equal(office.endpoint, "203.0.113.5:51820");
  assert.equal(office.allowed_ips, "10.0.0.2/32");
  assert.equal(office.transfer, "1.23 MiB received, 4.56 MiB sent");
  assert.equal(office.latest_handshake, "1 minute, 5 seconds ago");

  const roaming = ifaces[0].peers[1];
  assert.equal(roaming.name, "roaming");
  assert.equal(roaming.endpoint, null);
  assert.equal(roaming.latest_handshake, "(never)");
});

test("parseWireguardStatus tolerates empty input", () => {
  assert.deepEqual(parseWireguardStatus(""), []);
});
