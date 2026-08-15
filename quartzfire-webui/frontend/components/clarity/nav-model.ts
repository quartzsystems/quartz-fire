/// Navigation model for the Clarity Orchestrator shell — the single source of
/// truth behind the Subnav (top-level sections), the VerticalNav (the active
/// section's child pages), and the command palette's "Go to" list.
/// Icon names are Clarity Icons shapes (see the vendored clr-icons runtime).

export interface NavPage {
  id: string;
  label: string;
  href: string;
  icon: string;
}

export interface NavSection {
  id: string;
  label: string;
  href: string;
  /** ⌘K palette shortcut hint (display only). */
  kbd?: string;
  children?: NavPage[];
}

export const NAV_SECTIONS: NavSection[] = [
  { id: "dashboard", label: "Dashboard", href: "/dashboard", kbd: "G D" },
  {
    id: "interfaces",
    label: "Interfaces",
    href: "/interfaces/ethernet",
    kbd: "G I",
    children: [
      { id: "if-ethernet", label: "Ethernet", href: "/interfaces/ethernet", icon: "network-settings" },
      { id: "if-vlan", label: "VLAN", href: "/interfaces/vlan", icon: "tag" },
      { id: "if-bonding", label: "Bonding", href: "/interfaces/bonding", icon: "link" },
      { id: "if-bridge", label: "Bridge", href: "/interfaces/bridge", icon: "network-switch" },
      { id: "if-vxlan", label: "VXLAN", href: "/interfaces/vxlan", icon: "cloud" },
      { id: "if-loopback", label: "Loopback", href: "/interfaces/loopback", icon: "sync" },
    ],
  },
  {
    id: "nat",
    label: "NAT",
    href: "/nat/nat44",
    kbd: "G N",
    children: [{ id: "nat44", label: "NAT44", href: "/nat/nat44", icon: "two-way-arrows" }],
  },
  {
    id: "firewall",
    label: "Firewall",
    href: "/firewall/rules",
    kbd: "G F",
    children: [
      { id: "fw-rules", label: "Rules", href: "/firewall/rules", icon: "list" },
      { id: "fw-zones", label: "Zones", href: "/firewall/zones", icon: "organization" },
      { id: "fw-policies", label: "Policies", href: "/firewall/policies", icon: "grid-view" },
      { id: "fw-aliases", label: "Aliases", href: "/firewall/aliases", icon: "bookmark" },
      { id: "fw-monitor", label: "Traffic Monitor", href: "/firewall/monitor", icon: "line-chart" },
    ],
  },
  {
    id: "routing",
    label: "Routing",
    href: "/routing/static",
    kbd: "G R",
    children: [
      { id: "rt-static", label: "Static", href: "/routing/static", icon: "map-marker" },
      { id: "rt-ospf", label: "OSPF", href: "/routing/ospf", icon: "network-globe" },
      { id: "rt-isis", label: "IS-IS", href: "/routing/isis", icon: "network-switch" },
      { id: "rt-bgp", label: "BGP", href: "/routing/bgp", icon: "share" },
      { id: "rt-mpls", label: "MPLS", href: "/routing/mpls", icon: "layers" },
      { id: "rt-policy", label: "Policy", href: "/routing/policy", icon: "filter" },
    ],
  },
  {
    id: "vpn",
    label: "VPN",
    href: "/vpn",
    children: [
      { id: "vpn-overview", label: "Overview", href: "/vpn", icon: "dashboard" },
      { id: "vpn-wireguard", label: "WireGuard", href: "/vpn/wireguard", icon: "bolt" },
      { id: "vpn-openvpn", label: "OpenVPN", href: "/vpn/openvpn", icon: "world" },
      { id: "vpn-ipsec", label: "IPsec", href: "/vpn/ipsec", icon: "lock" },
      { id: "vpn-l2tp", label: "L2TP", href: "/vpn/l2tp", icon: "plug" },
    ],
  },
  {
    id: "services",
    label: "Services",
    href: "/services/dhcp-server",
    kbd: "G V",
    children: [
      { id: "svc-dhcp", label: "DHCP Server", href: "/services/dhcp-server", icon: "router" },
      { id: "svc-relay", label: "DHCP Relay", href: "/services/dhcp-relay", icon: "share" },
      { id: "svc-dns", label: "DNS Forwarding", href: "/services/dns-forwarding", icon: "world" },
      { id: "svc-ips", label: "Intrusion Prevention", href: "/services/intrusion-prevention", icon: "shield-x" },
      { id: "svc-appcontrol", label: "Application Control", href: "/services/application-control", icon: "applications" },
      { id: "svc-geo", label: "Geolocation", href: "/services/geolocation", icon: "map" },
      { id: "svc-ssl", label: "SSL Inspection", href: "/services/ssl-inspection", icon: "certificate" },
      { id: "svc-content", label: "Content Filtering", href: "/services/content-filtering", icon: "ban" },
    ],
  },
  {
    id: "high-availability",
    label: "High Availability",
    href: "/high-availability/vrrp",
    children: [
      { id: "ha-vrrp", label: "VRRP", href: "/high-availability/vrrp", icon: "cluster" },
      { id: "ha-virtual", label: "Virtual Servers", href: "/high-availability/virtual-servers", icon: "load-balancer" },
      { id: "ha-sync", label: "Config Sync", href: "/high-availability/config-sync", icon: "sync" },
    ],
  },
  {
    id: "monitoring",
    label: "Monitoring",
    href: "/monitoring/devices",
    kbd: "G M",
    children: [
      { id: "mon-devices", label: "Devices", href: "/monitoring/devices", icon: "devices" },
      { id: "mon-flow", label: "Traffic Flow", href: "/monitoring/traffic-flow", icon: "flow-chart" },
      { id: "mon-logs", label: "Logs", href: "/monitoring/logs", icon: "file-group" },
    ],
  },
  {
    id: "system",
    label: "System",
    href: "/system/general",
    kbd: "G S",
    children: [
      { id: "sys-general", label: "General", href: "/system/general", icon: "cog" },
      { id: "sys-management", label: "Management", href: "/system/management", icon: "cloud" },
      { id: "sys-users", label: "Users", href: "/system/users", icon: "users" },
      { id: "sys-ssh", label: "SSH", href: "/system/ssh", icon: "key" },
      { id: "sys-maintenance", label: "Maintenance", href: "/system/maintenance", icon: "wrench" },
      { id: "sys-audit", label: "Audit Log", href: "/system/audit", icon: "history" },
    ],
  },
];

/// The section a pathname belongs to. Trailing slashes are stripped by callers.
export function sectionForPath(pathname: string): NavSection | undefined {
  if (pathname === "/dashboard") return NAV_SECTIONS[0];
  return NAV_SECTIONS.find((s) => s.id !== "dashboard" && pathname.startsWith(`/${s.id}`));
}
