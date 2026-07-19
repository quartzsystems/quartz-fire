"use client";

import Link from "next/link";
import { Globe, Lock, Spline, Waypoints, ChevronRight, LucideIcon } from "lucide-react";

/// VPN section overview. The real configuration lives on the four protocol
/// pages; this landing page just routes there with a one-line description each.
interface Entry {
  href: string;
  icon: LucideIcon;
  title: string;
  desc: string;
}

const ENTRIES: Entry[] = [
  { href: "/vpn/wireguard", icon: Spline, title: "WireGuard", desc: "Fast, modern point-to-point tunnels keyed by public/private key pairs." },
  { href: "/vpn/openvpn", icon: Globe, title: "OpenVPN", desc: "TLS tunnels — site-to-site links, remote-access servers, and clients." },
  { href: "/vpn/ipsec", icon: Lock, title: "IPsec", desc: "Site-to-site IPsec with IKE/ESP proposals and policy- or route-based tunnels." },
  { href: "/vpn/l2tp", icon: Waypoints, title: "L2TP", desc: "L2TP/IPsec remote-access server for roaming dial-in clients." },
];

export default function VpnPage() {
  return (
    <div className="flex flex-col h-full">
      <div className="px-[36px] pt-[28px] pb-5 flex-shrink-0">
        <h1 className="text-[28px] font-bold text-[var(--qz-fg-1)] m-0" style={{ letterSpacing: "-0.015em" }}>
          VPN
        </h1>
        <p className="text-[13px] text-[var(--qz-fg-4)] mt-1">
          Site-to-site and remote-access tunnels
        </p>
      </div>

      <div className="flex-1 overflow-auto px-[36px] pb-[28px]">
        <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))" }}>
          {ENTRIES.map(({ href, icon: Icon, title, desc }) => (
            <Link
              key={href}
              href={href}
              className="group flex items-start gap-4 rounded-lg p-5 no-underline transition-colors"
              style={{ background: "var(--qz-surface)", border: "1px solid var(--qz-border)" }}
            >
              <div className="w-10 h-10 rounded-md grid place-items-center flex-shrink-0" style={{ background: "var(--qz-accent-soft)", color: "var(--qz-accent)" }}>
                <Icon size={20} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1 text-[15px] font-semibold text-[var(--qz-fg-1)]">
                  {title}
                  <ChevronRight size={16} className="text-[var(--qz-fg-4)] group-hover:text-[var(--qz-accent)] transition-colors" />
                </div>
                <p className="text-[12.5px] text-[var(--qz-fg-4)] m-0 mt-1 leading-snug">{desc}</p>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
