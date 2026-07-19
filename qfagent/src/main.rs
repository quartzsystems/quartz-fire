//! qfagent — QuartzFire cloud management agent (QuartzCommand client).
//!
//! One multi-call binary at /usr/libexec/quartzfire/qfagent, dispatched on
//! argv[0] (same pattern as quartzfire-geoip's qzgeo) with symlinks
//! providing the stable entry-point names:
//!
//!   system_quartz-command.py → commit   (conf-mode owner, in conf_mode/;
//!                              the .py suffix is required by vyos-configd's
//!                              script-path regex and stripped by file_stem)
//!   qf                       → the operator CLI (status / identity
//!                              regenerate / prepare-template), also used by
//!                              the op-mode `show quartz-command status`
//!
//! Invoked as plain `qfagent`, subcommands select the same operations plus
//! the daemon (`run`, the systemd unit's entry) and `scrub` (the post-commit
//! enroll-token removal one-shot).

use clap::{Parser, Subcommand};

mod commands;
#[cfg(target_os = "linux")]
mod control;
mod deviceid;
mod enroll;
#[cfg(test)]
mod enroll_mock_tests;
mod identity;
mod state;
mod tls;
mod token;
mod vyoscfg;

#[cfg(target_os = "linux")]
mod daemon;

/// Generated tonic stubs for the QuartzCommand protos (see build.rs).
pub mod proto {
    pub mod enrollment {
        tonic::include_proto!("quartzcommand.enrollment.v1");
    }
    pub mod device {
        tonic::include_proto!("quartzcommand.device.v1");
    }
}

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Parser)]
#[command(name = "qfagent", version, about = "QuartzFire cloud management agent")]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Run the agent daemon (default; the systemd unit's entry point).
    Run,
    /// Conf-mode owner of `system quartz-command` (invoked by VyOS commit).
    Commit {
        /// Print the commit decision without acting (tests/diagnostics).
        #[arg(long)]
        decide: bool,
    },
    /// Post-commit one-shot: remove a consumed enroll-token from the config
    /// and persist the token's gateway (root; path-unit triggered).
    Scrub,
    /// Show enrollment / control-channel status.
    Status {
        /// Machine-readable output.
        #[arg(long)]
        json: bool,
    },
    /// Device identity lifecycle.
    Identity {
        #[command(subcommand)]
        cmd: IdentityCmd,
    },
    /// Wipe identity, enrollment state and machine-id for VM templating.
    PrepareTemplate {
        /// Skip the confirmation prompt.
        #[arg(long)]
        yes: bool,
    },
}

#[derive(Subcommand)]
enum IdentityCmd {
    /// Wipe and regenerate the device identity (returns to unenrolled).
    Regenerate {
        /// Skip the confirmation prompt.
        #[arg(long)]
        force: bool,
    },
}

fn main() {
    // Structured logs to stderr; journald tags them via SyslogIdentifier.
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("qfagent=info")),
        )
        .with_writer(std::io::stderr)
        .init();

    // Symlink dispatch: the conf-mode owner name maps straight to commit.
    let argv0 = std::env::args()
        .next()
        .map(|a| {
            std::path::Path::new(&a)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string()
        })
        .unwrap_or_default();
    if argv0 == "system_quartz-command" {
        std::process::exit(commands::commit(false));
    }

    // `qf` and `qfagent` share the clap grammar.
    let cli = Cli::parse();
    let code = match cli.command.unwrap_or(Command::Run) {
        Command::Run => match run_daemon() {
            Ok(()) => 0,
            Err(e) => {
                eprintln!("qfagent: {e:#}");
                1
            }
        },
        Command::Commit { decide } => commands::commit(decide),
        Command::Scrub => commands::scrub(),
        Command::Status { json } => commands::status(json),
        Command::Identity { cmd: IdentityCmd::Regenerate { force } } => {
            commands::identity_regenerate(force)
        }
        Command::PrepareTemplate { yes } => commands::prepare_template(yes),
    };
    std::process::exit(code);
}

#[cfg(target_os = "linux")]
fn run_daemon() -> anyhow::Result<()> {
    daemon::run()
}

#[cfg(not(target_os = "linux"))]
fn run_daemon() -> anyhow::Result<()> {
    anyhow::bail!(
        "the qfagent daemon only runs on Linux (VyOS); this build is for development/testing"
    )
}
