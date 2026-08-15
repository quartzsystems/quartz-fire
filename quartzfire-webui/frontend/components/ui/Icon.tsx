"use client";

import type { CSSProperties } from "react";

/// Clarity icon wrapper. Sizes per the design system: 12 inline, 14 nav
/// collapse trigger, 16 default (incl. vertical-nav items), 20 header icon
/// actions, 24 page headers. Icons inherit currentColor.
export function Icon({
  shape,
  size = 16,
  solid = false,
  dir,
  className,
  style,
  title,
}: {
  shape: string;
  size?: number;
  solid?: boolean;
  dir?: "up" | "down" | "left" | "right";
  className?: string;
  style?: CSSProperties;
  title?: string;
}) {
  const cls = [solid ? "is-solid" : "", className ?? ""].join(" ").trim();
  return (
    <clr-icon
      shape={shape}
      size={size}
      dir={dir}
      className={cls || undefined}
      style={style}
      title={title}
    />
  );
}
