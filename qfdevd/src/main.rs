//! qfdevd — QuartzFire device/client monitoring daemon.
//!
//! Aggregates the neighbor table, Kea DHCP leases, and conntrack byte
//! accounting into a shared SQLite inventory (`/config/quartzfire/devices.db`,
//! WAL) that the WebUI backend reads for the Monitoring → Devices page.
//!
//! Linux-only at runtime (needs `ip`, `conntrack`, the Kea lease file). The
//! non-Linux build exists so the pure-logic modules compile and unit-test on a
//! dev host; it refuses to run.

use clap::{Parser, Subcommand};

// Pure / cross-platform modules — their unit tests run on any dev host.
mod conntrack;
mod db;
mod fingerprint;
mod leases;
mod neigh;

mod config;

// Linux-only orchestration (spawns the collector tasks, talks to systemd).
#[cfg(target_os = "linux")]
mod daemon;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Parser)]
#[command(name = "qfdevd", version, about = "QuartzFire device/client monitoring daemon")]
struct Cli {
    /// Path to the daemon configuration file.
    #[arg(long, default_value = "/etc/qfdevd/qfdevd.toml")]
    config: std::path::PathBuf,

    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Run the collector daemon (default when no subcommand is given).
    Run,
    /// Print the resolved configuration and exit (diagnostics).
    ShowConfig,
}

fn main() -> anyhow::Result<()> {
    // Structured logs to stderr; JSON event/status output goes to the files.
    // Journald tags these under SyslogIdentifier=qfdevd (see the unit).
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("qfdevd=info")),
        )
        .with_writer(std::io::stderr)
        .init();

    let cli = Cli::parse();
    let config = config::Config::load(&cli.config)?;

    match cli.command.unwrap_or(Command::Run) {
        Command::ShowConfig => {
            println!("{config:#?}");
            Ok(())
        }
        Command::Run => run(config),
    }
}

#[cfg(target_os = "linux")]
fn run(config: config::Config) -> anyhow::Result<()> {
    tracing::info!("qfdevd {VERSION} starting");
    daemon::run(config)
}

#[cfg(not(target_os = "linux"))]
fn run(_config: config::Config) -> anyhow::Result<()> {
    anyhow::bail!("qfdevd only runs on Linux (ip/conntrack/Kea); this build is for development only")
}
