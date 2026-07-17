// Donut-segment geometry for the application-mix charts (TopAppsDonut).
//
// Split out of the component so it's reachable from the test harness, which
// runs plain TS via `--experimental-strip-types` and can't load JSX.

/// SVG path for a donut segment from `a0` to `a1` (radians, 0 = 12 o'clock).
///
/// Both rings are emitted as arcs with opposite sweep directions, so the
/// nonzero fill rule leaves the middle hollow.
export function arcPath(
  cx: number,
  cy: number,
  rOut: number,
  rIn: number,
  a0: number,
  a1: number,
): string {
  const x = (r: number, a: number) => cx + r * Math.sin(a);
  const y = (r: number, a: number) => cy - r * Math.cos(a);
  const p = (r: number, a: number) => `${x(r, a).toFixed(2)} ${y(r, a).toFixed(2)}`;

  // A 360° segment (one app at 100%) can't be drawn as a single arc: its start
  // and end coincide, and SVG drops an arc whose endpoints are equal. Rounding
  // left the *outer* arc a hair short of closing — so it survived — while the
  // inner one collapsed, filling the hole and rendering a solid pie. Draw each
  // ring as two half-circles instead, which never degenerate.
  if (a1 - a0 >= Math.PI * 2 - 1e-6) {
    const mid = a0 + Math.PI;
    return [
      `M ${p(rOut, a0)}`,
      `A ${rOut} ${rOut} 0 0 1 ${p(rOut, mid)}`,
      `A ${rOut} ${rOut} 0 0 1 ${p(rOut, a0)}`,
      "Z",
      `M ${p(rIn, a0)}`,
      `A ${rIn} ${rIn} 0 0 0 ${p(rIn, mid)}`,
      `A ${rIn} ${rIn} 0 0 0 ${p(rIn, a0)}`,
      "Z",
    ].join(" ");
  }

  const large = a1 - a0 > Math.PI ? 1 : 0;
  return [
    `M ${p(rOut, a0)}`,
    `A ${rOut} ${rOut} 0 ${large} 1 ${p(rOut, a1)}`,
    `L ${p(rIn, a1)}`,
    `A ${rIn} ${rIn} 0 ${large} 0 ${p(rIn, a0)}`,
    "Z",
  ].join(" ");
}
