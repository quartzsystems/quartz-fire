"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { AppHeader, AppSubnav, AppVerticalNav } from "@/components/clarity/ClarityShell";
import { CommandPalette } from "@/components/dashboard/CommandPalette";
import { CommitGuard } from "@/components/dashboard/CommitGuard";
import { SaveIndicator } from "@/components/dashboard/SaveIndicator";
import { Toast } from "@/components/dashboard/Toast";
import { DefaultPasswordGate } from "@/components/DefaultPasswordGate";
import { DashboardProvider, useDashboard } from "@/lib/DashboardContext";

function Shell({ children }: { children: React.ReactNode }) {
  const nextRouter = useRouter();
  const { toast, setToast } = useDashboard();
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  return (
    <div className="main-container">
      {/* App-level alert slot — commit-confirm banners render above the header. */}
      <CommitGuard />
      <AppHeader onOpenPalette={() => setPaletteOpen(true)} />
      <AppSubnav />
      <div className="content-container">
        <AppVerticalNav />
        <main className="content-area">{children}</main>
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onNavigate={(href) => nextRouter.push(href)}
      />
      <SaveIndicator />
      <DefaultPasswordGate />
      {toast && <Toast message={toast} onDismiss={() => setToast(null)} />}
    </div>
  );
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  return (
    <DashboardProvider>
      <Shell>{children}</Shell>
    </DashboardProvider>
  );
}
