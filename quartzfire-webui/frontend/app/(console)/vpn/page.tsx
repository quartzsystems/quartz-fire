"use client";

import Link from "next/link";
import { Icon } from "@/components/ui/Icon";

/// VPN section overview. The real configuration lives on the four protocol
/// pages; this landing page just routes there with a one-line description each.
interface Entry {
  href: string;
  icon: string;
  title: string;
  desc: string;
}

const ENTRIES: Entry[] = [
  { href: "/vpn/wireguard", icon: "bolt", title: "WireGuard", desc: "Fast, modern point-to-point tunnels keyed by public/private key pairs." },
  { href: "/vpn/openvpn", icon: "world", title: "OpenVPN", desc: "TLS tunnels — site-to-site links, remote-access servers, and clients." },
  { href: "/vpn/ipsec", icon: "lock", title: "IPsec", desc: "Site-to-site IPsec with IKE/ESP proposals and policy- or route-based tunnels." },
  { href: "/vpn/l2tp", icon: "plug", title: "L2TP", desc: "L2TP/IPsec remote-access server for roaming dial-in clients." },
];

export default function VpnPage() {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2>VPN</h2>
        <p className="clr-secondary" style={{ marginTop: 4 }}>Site-to-site and remote-access tunnels</p>
      </div>

      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))" }}>
        {ENTRIES.map(({ href, icon, title, desc }) => (
          <Link key={href} href={href} className="card clickable no-underline">
            <div className="card-block flex items-start gap-[14px]">
              <Icon shape={icon} size={24} style={{ color: "var(--cds-alias-interaction-action)" }} />
              <div className="flex-1 min-w-0">
                <div className="text-[15px] font-semibold" style={{ color: "var(--cds-alias-typography-color-450)" }}>{title}</div>
                <div className="text-[12px] mt-1 leading-snug" style={{ color: "var(--cds-alias-typography-color-300)" }}>{desc}</div>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
