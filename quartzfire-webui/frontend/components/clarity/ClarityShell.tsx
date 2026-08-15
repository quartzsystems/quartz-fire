"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { NAV_SECTIONS, sectionForPath } from "@/components/clarity/nav-model";
import { AuthUserInfo, getCurrentUser, logout as apiLogout } from "@/lib/api";
import { fetchSystemConfig } from "@/lib/system";

/// Clarity Orchestrator chrome: 56px Header (brand + firewall context + icon
/// actions), 36px Subnav (top-level sections, green underline), 240px
/// VerticalNav (the active section's child pages, collapsible to a 48px icon
/// rail). The Dashboard section has no children, so it renders without a
/// vertical nav.

function useNormalizedPath(): string {
  // Static export emits trailing-slash routes, so normalise before comparing.
  return (usePathname() ?? "/").replace(/\/+$/, "") || "/";
}

export function AppHeader({ onOpenPalette }: { onOpenPalette: () => void }) {
  const router = useRouter();
  const [user, setUser] = useState<AuthUserInfo | null>(null);
  const [hostname, setHostname] = useState<string | null>(null);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // localStorage is unavailable during SSR/prerender — read it after mount.
  useEffect(() => {
    setUser(getCurrentUser());
    fetchSystemConfig()
      .then((cfg) => {
        const host = cfg.general.hostname || "quartzfire";
        const domain = cfg.general.domain_name;
        setHostname(domain ? `${host}.${domain}` : host);
      })
      .catch(() => setHostname(null));
  }, []);

  // Any click outside the header menus closes them.
  useEffect(() => {
    if (!userMenuOpen && !helpOpen) return;
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) {
        setUserMenuOpen(false);
        setHelpOpen(false);
      }
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [userMenuOpen, helpOpen]);

  const signOut = async () => {
    await apiLogout();
    router.push("/");
  };

  return (
    <header className="header">
      <div className="branding">
        <img src="/logo-mark.png" alt="Quartz Systems" />
        <span className="title">QuartzFire</span>
      </div>
      <div className="header-divider" />
      <div className="header-dropdown">
        <button type="button">
          <span className="hd-text">
            <span className="hd-label">Firewall</span>
            <span className="hd-value">{hostname ?? "…"}</span>
          </span>
          <Icon shape="angle" dir="down" size={12} />
        </button>
      </div>
      <div className="header-actions" ref={menuRef}>
        <button type="button" className="nav-icon" title="Search (Ctrl+K)" onClick={onOpenPalette}>
          <Icon shape="search" size={20} />
        </button>
        <button
          type="button"
          className="nav-icon"
          title="Alarms — unified logs"
          onClick={() => router.push("/monitoring/logs")}
        >
          <Icon shape="bell" size={20} />
        </button>
        <div className="clr-dropdown">
          <button
            type="button"
            className="nav-icon"
            title="Help"
            onClick={() => {
              setHelpOpen((v) => !v);
              setUserMenuOpen(false);
            }}
          >
            <Icon shape="help" size={20} />
          </button>
          {helpOpen && (
            <div className="dropdown-menu right">
              <button
                type="button"
                className="dropdown-item"
                onClick={() => {
                  setHelpOpen(false);
                  onOpenPalette();
                }}
              >
                <Icon shape="search" size={16} />
                Command palette
                <span
                  style={{
                    marginLeft: "auto",
                    fontFamily: "var(--qz-font-mono)",
                    fontSize: 10,
                    color: "var(--cds-alias-typography-color-200)",
                  }}
                >
                  Ctrl+K
                </span>
              </button>
              <button
                type="button"
                className="dropdown-item"
                onClick={() => {
                  setHelpOpen(false);
                  router.push("/system/general");
                }}
              >
                <Icon shape="info-circle" size={16} />
                About this firewall
              </button>
            </div>
          )}
        </div>
        <div className="clr-dropdown">
          <button
            type="button"
            className="nav-icon"
            title={user ? `${user.full_name || user.username}` : "Account"}
            onClick={() => {
              setUserMenuOpen((v) => !v);
              setHelpOpen(false);
            }}
          >
            <Icon shape="user" size={20} />
          </button>
          {userMenuOpen && (
            <div className="dropdown-menu right">
              <div className="dropdown-header">
                {user ? user.full_name || user.username : "Signed in"}
                {user?.full_name ? ` — ${user.username}` : ""}
              </div>
              <button type="button" className="dropdown-item" onClick={() => void signOut()}>
                <Icon shape="logout" size={16} />
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

export function AppSubnav() {
  const pathname = useNormalizedPath();
  const active = sectionForPath(pathname);
  return (
    <nav className="subnav">
      {NAV_SECTIONS.map((s) => (
        <Link
          key={s.id}
          href={s.href}
          className={`nav-link${active?.id === s.id ? " active" : ""}`}
        >
          {s.label}
        </Link>
      ))}
    </nav>
  );
}

export function AppVerticalNav() {
  const pathname = useNormalizedPath();
  const [collapsed, setCollapsed] = useState(false);
  const section = sectionForPath(pathname);

  if (!section?.children) return null;

  // The most specific child whose href prefixes the current path is active
  // (so "/vpn" Overview doesn't light up while viewing "/vpn/wireguard").
  const activeHref = section.children
    .filter((p) => pathname === p.href || pathname.startsWith(`${p.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;

  return (
    <nav className={`clr-vertical-nav${collapsed ? " is-collapsed" : ""}`}>
      <button
        type="button"
        className="clr-vertical-nav-trigger"
        title={collapsed ? "Expand navigation" : "Collapse navigation"}
        onClick={() => setCollapsed((v) => !v)}
      >
        <Icon shape="angle-double" size={16} dir={collapsed ? "right" : "left"} />
      </button>
      {!collapsed && <div className="nav-group-text">{section.label}</div>}
      {section.children.map((p) => (
        <Link
          key={p.id}
          href={p.href}
          className={`nav-link${p.href === activeHref ? " active" : ""}`}
          title={collapsed ? p.label : undefined}
        >
          <Icon shape={p.icon} size={20} />
          {!collapsed && <span>{p.label}</span>}
        </Link>
      ))}
    </nav>
  );
}
