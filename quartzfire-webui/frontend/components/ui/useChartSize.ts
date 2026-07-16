"use client";

import { useEffect, useRef, useState } from "react";

/// Measure a chart's wrapper so the SVG can be drawn at 1:1 pixels.
///
/// A fixed `viewBox` scaled by CSS shrinks the *labels* along with the plot —
/// in a narrow column an 11px axis label lands at ~4px. Drawing to the measured
/// width keeps type at its intended size no matter how wide the container is.
export function useChartSize(initial = 600) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(initial);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return { ref, width };
}
