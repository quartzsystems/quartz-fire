"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { fetchMe, login } from "@/lib/api";

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
        <div className="login-brand-title">QuartzFire</div>
        <div className="login-brand-sub">
          The Quartz Systems firewall — routing, security services, and monitoring for your network
          edge, managed from one console.
        </div>
      </div>

      <div className="login">
        <div className="title">Sign In</div>
        <div className="subtitle">Use an administrator account configured on this firewall.</div>

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
            {loading ? "Signing In…" : "Sign In"}
          </button>
        </form>

        <div className="signup">
          Sign in with a user account configured on this firewall. An account still on the
          factory-default password must change it before the console opens.
        </div>
      </div>
    </div>
  );
}
