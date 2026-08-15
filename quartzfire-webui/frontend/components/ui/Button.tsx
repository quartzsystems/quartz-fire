"use client";

import { Icon } from "@/components/ui/Icon";

type ButtonKind = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md";

interface ButtonProps {
  kind?: ButtonKind;
  size?: ButtonSize;
  /** Clarity icon shape name (e.g. "plus", "refresh"). */
  icon?: string;
  iconRight?: string;
  onClick?: () => void;
  type?: "button" | "submit";
  children?: React.ReactNode;
  disabled?: boolean;
}

const kindClass: Record<ButtonKind, string> = {
  primary: "btn btn-primary",
  secondary: "btn btn-neutral",
  ghost: "btn btn-link-neutral",
  danger: "btn btn-danger",
};

export function Button({
  kind = "primary",
  size = "md",
  icon,
  iconRight,
  onClick,
  type = "button",
  children,
  disabled,
}: ButtonProps) {
  const iconSize = size === "sm" ? 14 : 16;
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`${kindClass[kind]}${size === "sm" ? " btn-sm" : ""}`}
    >
      {icon && <Icon shape={icon} size={iconSize} />}
      {children}
      {iconRight && <Icon shape={iconRight} size={iconSize} />}
    </button>
  );
}

export function IconButton({
  icon,
  onClick,
  label,
}: {
  icon: string;
  onClick?: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="btn btn-link-neutral btn-icon"
    >
      <Icon shape={icon} size={16} />
    </button>
  );
}
