"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { fetchMe, login } from "@/lib/api";
import pkg from "@/package.json";

/// Sign-in page at the root of the WebUI — Clarity split layout: brand panel
/// (dot grid, mark, tagline) beside the form card. Credentials are the users
/// configured on VyOS itself (`system login user …`); the backend verifies
/// them and sets an httpOnly session cookie.
export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // Already signed in? Skip straight to the console.
  useEffect(() => {
    fetchMe()
      .then(() => router.replace("/dashboard"))
      .catch(() => {});
  }, [router]);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!username || !password) {
      setError("Username and password are required.");
      return;
    }
    setError("");
    setLoading(true);
    try {
      await login(username, password);
      router.push("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reach the server.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-wrapper">
      <div className="login-brand">
        <img src="/logo-mark.png" alt="Quartz Systems" />
        <div className="login-brand-title">
          The firewall OS that
          <br />
          holds the line.
        </div>
        <div className="login-brand-sub">
          Zones, rules, NAT, routing, VPN, and deep-inspection services on a VyOS core — managed
          from the console this firewall serves itself.
        </div>
        {/* position:relative lifts the line above the brand panel's dot-grid overlay. */}
        <div
          style={{
            position: "relative",
            fontFamily: "var(--qz-font-mono)",
            fontSize: 11,
            letterSpacing: "0.08em",
            color: "var(--cds-alias-typography-color-200)",
          }}
        >
          QUARTZFIRE {pkg.version} · QUARTZ SYSTEMS
        </div>
      </div>

      <div className="login">
        <div className="title">QuartzFire</div>
        <div className="subtitle">Sign in to this firewall</div>

        <form onSubmit={handleSubmit}>
          <div className="clr-form-control">
            <label className="clr-control-label" htmlFor="login-username">
              Username
            </label>
            <input
              id="login-username"
              type="text"
              className="clr-input"
              style={{ maxWidth: "none" }}
              placeholder="admin"
              spellCheck={false}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoFocus
            />
          </div>

          <div className="clr-form-control">
            <label className="clr-control-label" htmlFor="login-password">
              Password
            </label>
            <div className="clr-password-wrapper" style={{ maxWidth: "none" }}>
              <input
                id="login-password"
                type={showPassword ? "text" : "password"}
                className="clr-input"
                placeholder="••••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
              <button
                type="button"
                className="clr-password-toggle"
                aria-label={showPassword ? "Hide password" : "Show password"}
                onClick={() => setShowPassword((v) => !v)}
              >
                <Icon shape={showPassword ? "eye-hide" : "eye"} size={16} />
              </button>
            </div>
          </div>

          {error && (
            <div className="alert alert-danger alert-sm error" style={{ marginTop: 16 }}>
              <Icon shape="exclamation-circle" size={14} className="alert-icon" />
              <div className="alert-text">{error}</div>
            </div>
          )}

          <button type="submit" className="btn btn-primary btn-block" disabled={loading}>
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <div style={{ fontSize: 12, color: "var(--cds-alias-typography-color-200)", marginTop: 16 }}>
          Sign in with a user account configured on this firewall. An account still on the
          factory-default password must change it before the console opens.
        </div>
      </div>
    </div>
  );
}
