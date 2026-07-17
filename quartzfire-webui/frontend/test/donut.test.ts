// Geometry tests for the application-mix donut (Monitoring → Devices, and the
// dashboard's Top Applications tile).
//
// The case that matters is a single app at 100%, which is the norm in a
// device's detail panel — one client often talks to exactly one classified
// application. That used to render as a solid pie instead of a donut, so the
// styling silently diverged from every other instance of the same chart.

import { test } from "node:test";
import assert from "node:assert/strict";

import { arcPath } from "../lib/donut.ts";

const TAU = Math.PI * 2;

/// Every `A` command's start/end point pair in a path, in emission order.
/// SVG omits an elliptical arc whose endpoints are equal, so an arc whose start
/// coincides with its end is not drawn at all — the bug this file guards.
function arcs(path: string): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  // Commands are space-joined: "M x y", "A rx ry rot large sweep x y", "L x y",
  // "Z". Slice on the command letters themselves — splitting on a "letter then
  // space" lookahead silently swallows the trailing Z into the arc before it,
  // which makes a degenerate arc look like it moved.
  let cursor = "";
  for (const t of path.match(/[MALZ][^MALZ]*/g) ?? []) {
    const cmd = t[0];
    if (cmd === "Z") continue;
    const args = t.slice(1).trim().split(/\s+/);
    const to = args.slice(-2).join(" ");
    if (cmd === "A") out.push({ from: cursor, to });
    cursor = to;
  }
  return out;
}

test("a 100% slice still draws both rings (donut, not a solid pie)", () => {
  const path = arcPath(80, 80, 78, 48, 0, TAU);
  for (const a of arcs(path)) {
    assert.notEqual(a.from, a.to, `degenerate arc ${a.from} → ${a.to} would be dropped by SVG, filling the hole`);
  }
});

test("a 100% slice emits an inner ring as its own subpath", () => {
  const path = arcPath(80, 80, 78, 48, 0, TAU);
  // Two subpaths: the outer ring and the inner (hole) ring.
  assert.equal(path.match(/M /g)?.length, 2);
  assert.equal(arcs(path).length, 4); // two half-circles per ring
  // The rings wind in opposite directions, so the nonzero fill rule leaves the
  // middle hollow. Outer arcs sweep 1, inner arcs sweep 0.
  assert.equal((path.match(/A 78 78 0 0 1 /g) ?? []).length, 2);
  assert.equal((path.match(/A 48 48 0 0 0 /g) ?? []).length, 2);
});

test("a partial slice keeps the single-arc wedge form", () => {
  const path = arcPath(80, 80, 78, 48, 0, Math.PI / 2);
  assert.equal(path.match(/M /g)?.length, 1);
  assert.equal(arcs(path).length, 2); // one outer arc, one inner arc
  for (const a of arcs(path)) assert.notEqual(a.from, a.to);
});

test("the large-arc flag is set only past a half turn", () => {
  assert.match(arcPath(80, 80, 78, 48, 0, Math.PI * 1.5), /A 78 78 0 1 1 /);
  assert.match(arcPath(80, 80, 78, 48, 0, Math.PI * 0.5), /A 78 78 0 0 1 /);
});

test("slices start at 12 o'clock and run clockwise", () => {
  const path = arcPath(80, 80, 78, 48, 0, Math.PI / 2);
  assert.ok(path.startsWith("M 80.00 2.00"), `expected to open at top center, got: ${path}`);
  // A quarter turn clockwise lands at 3 o'clock.
  assert.match(path, /A 78 78 0 0 1 158\.00 80\.00/);
});
