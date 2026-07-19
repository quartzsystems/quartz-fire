// Tests for the audit page's data layer: commit-history parsing and the
// per-commit diff summarizer behind the Config Changes "Changes" column.
// Run with `npm test` (node --test + strip-types; see register.mjs).

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCommitHistory, summarizeCommitDiff } from "../lib/audit";

test("parseCommitHistory parses revisions and trailing comments", () => {
  const out = parseCommitHistory(
    [
      "Revisions:",
      "0   2026-07-19 12:34:56 by vyos via api",
      "1   2026-07-18 09:00:00 by admin via cli",
      "    tightened WAN rules",
    ].join("\n"),
  );
  assert.equal(out.length, 2);
  assert.equal(out[0].revision, 0);
  assert.equal(out[0].via, "api");
  assert.equal(out[1].comment, "tightened WAN rules");
});

test("summarizeCommitDiff handles the config-tree +/- shape", () => {
  const diff = [
    "firewall {",
    "    ipv4 {",
    "        forward {",
    "            filter {",
    '+                rule 20 {',
    '+                    action "drop"',
    "+                }",
    "            }",
    "        }",
    "    }",
    "}",
    "nat {",
    "    source {",
    '-        rule 100 {',
    '-            translation address masquerade',
    "-        }",
    "    }",
    "}",
  ].join("\n");
  const s = summarizeCommitDiff(diff);
  // Marked brace-only lines must not count; firewall gained 2, nat lost 2.
  assert.equal(s, "firewall +2 · nat −2");
});

test("summarizeCommitDiff handles the [edit path] shape", () => {
  const diff = [
    "[edit interfaces ethernet eth0]",
    "+address 192.0.2.2/24",
    "-address 192.0.2.1/24",
    "[edit service ssh]",
    "+port 2222",
  ].join("\n");
  assert.equal(summarizeCommitDiff(diff), "interfaces +1 −1 · service +1");
});

test("summarizeCommitDiff caps sections and reports the rest", () => {
  const diff = ["+firewall x", "+nat x", "+system x", "+interfaces x"]
    .map((l, i) => `[edit ${l.slice(1).split(" ")[0]}]\n+leaf${i} on`)
    .join("\n");
  const s = summarizeCommitDiff(diff);
  assert.match(s, /· \+1 more$/);
});

test("summarizeCommitDiff returns empty for no-change diffs", () => {
  assert.equal(summarizeCommitDiff(""), "");
  assert.equal(summarizeCommitDiff("firewall {\n    ipv4 {\n    }\n}\n"), "");
});
