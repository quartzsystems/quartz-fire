"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { Button } from "@/components/ui/Button";
import { ModalShell, ModalHeader, ModalFooter } from "@/components/ui/Modal";
import {
  addImage,
  cancelScheduledReboot,
  cleanupImageUpload,
  deleteImage,
  downloadConfigBackup,
  factoryReset,
  fetchImages,
  fetchShutdownSchedule,
  type ImageJob,
  type ImagePhase,
  imageNameFromIsoName,
  rebootSystem,
  restoreConfigBackup,
  scheduleReboot,
  shutdownSystem,
  ShutdownSchedule,
  SystemImage,
  uploadImageFile,
} from "@/lib/system";
import { useDashboard } from "@/lib/DashboardContext";

const monoSt = { fontFamily: "var(--qz-font-mono)", maxWidth: "none" } as const;

/// Clarity status pill — mono uppercase label.
function Pill({ tone, children }: { tone?: "success" | "info"; children: React.ReactNode }) {
  return (
    <span
      className={`label${tone ? ` label-${tone}` : ""}`}
      style={{
        fontFamily: "var(--qz-font-mono)",
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        width: "fit-content",
      }}
    >
      {children}
    </span>
  );
}

type PowerAction = "reboot" | "shutdown";

/// Confirmation dialog for reboot/shutdown — both cut this session off, so
/// spell out what happens before firing.
function PowerConfirmModal({
  action,
  onClose,
  onConfirmed,
}: {
  action: PowerAction;
  onClose: () => void;
  onConfirmed: (message: string) => void;
}) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");

  const isReboot = action === "reboot";

  const run = async () => {
    setWorking(true);
    setError("");
    try {
      if (isReboot) await rebootSystem();
      else await shutdownSystem();
      onConfirmed(
        isReboot
          ? "Reboot initiated — the WebUI will be unreachable until the firewall is back up."
          : "Shutdown initiated — the firewall must be powered on manually to come back.",
      );
    } catch (e) {
      // The device may drop the connection before answering — that's success.
      const msg = e instanceof Error ? e.message : "";
      if (/network|fetch|unreachable|gateway/i.test(msg)) {
        onConfirmed(isReboot ? "Reboot initiated." : "Shutdown initiated.");
        return;
      }
      setError(msg || `Failed to ${action}.`);
      setWorking(false);
    }
  };

  return (
    <ModalShell onClose={onClose} maxWidth={440}>
      <ModalHeader
        title={isReboot ? "Reboot Firewall" : "Shut Down Firewall"}
        onClose={onClose}
      />
      <div className="flex flex-col gap-4">
        <p className="m-0" style={{ fontSize: 13, color: "var(--cds-alias-typography-color-400)" }}>
          {isReboot
            ? "All traffic through the firewall stops until it has booted again (typically a minute or two). Unsaved config changes are already persisted automatically after each apply."
            : "All traffic through the firewall stops, and it will stay off until powered on at the console or via out-of-band management. Are you sure?"}
        </p>
        {error && (
          <p className="m-0" style={{ fontSize: 12, color: "var(--cds-alias-status-danger)" }}>
            {error}
          </p>
        )}
        <ModalFooter>
          <button type="button" className="btn btn-neutral" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-danger" disabled={working} onClick={run}>
            {working ? "Sending…" : isReboot ? "Reboot Now" : "Shut Down Now"}
          </button>
        </ModalFooter>
      </div>
    </ModalShell>
  );
}

/// Format a Date as the datetime-local input value (local wall time).
function toLocalInputValue(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/// Schedule a reboot for a specific date/time via the device's own scheduler
/// (`reboot at HH:MM date DD/MM/YYYY` → systemd shutdown). The chosen moment
/// is interpreted in the FIREWALL's timezone.
function ScheduleRebootModal({
  onClose,
  onScheduled,
}: {
  onClose: () => void;
  onScheduled: () => void;
}) {
  // Default to one hour from now, on a whole minute.
  const [when, setWhen] = useState(() => toLocalInputValue(new Date(Date.now() + 60 * 60 * 1000)));
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");

  const run = async () => {
    const d = new Date(when);
    if (Number.isNaN(d.getTime())) {
      setError("Pick a date and time.");
      return;
    }
    if (d.getTime() <= Date.now()) {
      setError("The scheduled time must be in the future.");
      return;
    }
    setWorking(true);
    setError("");
    const p = (n: number) => String(n).padStart(2, "0");
    try {
      await scheduleReboot(
        `${p(d.getHours())}:${p(d.getMinutes())}`,
        `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`,
      );
      onScheduled();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Scheduling failed.");
      setWorking(false);
    }
  };

  return (
    <ModalShell onClose={onClose} maxWidth={440}>
      <ModalHeader
        title="Schedule Reboot"
        subtitle="Reboot the firewall at a chosen date and time"
        onClose={onClose}
      />
      <div className="flex flex-col gap-4">
        <div className="clr-form-control">
          <label className="clr-control-label">Reboot at</label>
          <input
            type="datetime-local"
            value={when}
            min={toLocalInputValue(new Date())}
            onChange={(e) => setWhen(e.target.value)}
            className="clr-input"
            style={monoSt}
          />
        </div>
        <p className="m-0" style={{ fontSize: 12, color: "var(--cds-alias-typography-color-200)" }}>
          The time is interpreted in the firewall&apos;s timezone (System → General). The schedule
          survives WebUI sessions and can be cancelled here any time before it fires; users logged in
          at the console are warned by the system shortly before the reboot.
        </p>
        {error && (
          <p className="m-0" style={{ fontSize: 12, color: "var(--cds-alias-status-danger)" }}>
            {error}
          </p>
        )}
        <ModalFooter>
          <button type="button" className="btn btn-neutral" onClick={onClose} disabled={working}>
            Cancel
          </button>
          <Button kind="primary" icon="history" onClick={run} disabled={working}>
            {working ? "Scheduling…" : "Schedule Reboot"}
          </Button>
        </ModalFooter>
      </div>
    </ModalShell>
  );
}

/// Install a new system image, either from a URL the device downloads or
/// from an ISO uploaded straight out of the browser (drag & drop or file
/// picker). Both are long operations — the modal stays up with a busy state
/// until the device answers.
function AddImageModal({
  installed,
  onClose,
  onSaved,
}: {
  installed: SystemImage[];
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [phase, setPhase] = useState<"idle" | "uploading" | "installing">("idle");
  const [progress, setProgress] = useState(0);
  // Live phase + download fraction of the device-side background install, fed by
  // addImage's status polling (null download fraction = size unknown / N/A).
  const [jobPhase, setJobPhase] = useState<ImagePhase | null>(null);
  const [dlFraction, setDlFraction] = useState<number | null>(null);
  const [error, setError] = useState("");
  const isoInput = useRef<HTMLInputElement>(null);

  // Reflect the device's background install progress in the modal.
  const onJobStatus = (job: ImageJob) => {
    setJobPhase(job.phase);
    setDlFraction(
      job.phase === "downloading" && job.total_bytes ? job.downloaded_bytes / job.total_bytes : null,
    );
  };

  const working = phase !== "idle";

  // An install in flight can't be cancelled from here — closing the modal
  // would just hide it, so the modal stays up until the device answers.
  const close = () => {
    if (!working) onClose();
  };

  const pickFile = (f: File | null) => {
    setError("");
    if (f && !/\.iso$/i.test(f.name)) {
      setError(`"${f.name}" is not an .iso file.`);
      return;
    }
    setFile(f);
  };

  /// The installer names the image after the ISO's embedded version and
  /// refuses to install over an existing name — catch the obvious collision
  /// from the filename before spending minutes uploading the ISO.
  const nameClash = (isoName: string): string | null => {
    const candidate = imageNameFromIsoName(isoName);
    const clash = candidate ? installed.find((i) => i.name === candidate) : undefined;
    if (!clash) return null;
    return clash.running
      ? `The firewall is already running "${clash.name}" — an image can't be installed over itself. Build the ISO with a new version number first.`
      : `An image named "${clash.name}" is already installed. Delete it from the System Images list, then retry.`;
  };

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");

    if (file) {
      const clash = nameClash(file.name);
      if (clash) {
        setError(clash);
        return;
      }
      setPhase("uploading");
      setProgress(0);
      try {
        const path = await uploadImageFile(file, setProgress);
        setPhase("installing");
        setJobPhase(null);
        try {
          await addImage(path, onJobStatus);
        } finally {
          // The staged ISO is dead weight either way once the install ends.
          await cleanupImageUpload();
        }
        onSaved("Image installed. It becomes the default boot image — reboot to run it.");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to install the image.");
        setPhase("idle");
      }
      return;
    }

    const u = url.trim();
    if (!/^https?:\/\/.+/i.test(u)) {
      setError("Enter the http(s) URL of a QuartzFire/VyOS ISO image, or drop an .iso file below.");
      return;
    }
    const clash = nameClash(u.split("?")[0].split("/").pop() ?? "");
    if (clash) {
      setError(clash);
      return;
    }
    setPhase("installing");
    setJobPhase(null);
    try {
      await addImage(u, onJobStatus);
      onSaved("Image installed. It becomes the default boot image — reboot to run it.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to install the image.");
      setPhase("idle");
    }
  };

  return (
    <ModalShell onClose={close} maxWidth={520}>
      <ModalHeader
        title="Add System Image"
        subtitle="Install an upgrade image alongside the running one"
        onClose={close}
      />
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="clr-form-control">
          <label className="clr-control-label">Image URL</label>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/quartzfire-1.5-rolling.iso"
            disabled={working || file !== null}
            className="clr-input"
            style={monoSt}
          />
        </div>

        {/* Upload alternative: drag & drop or pick a local ISO. */}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            if (!working) setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            if (!working) pickFile(e.dataTransfer.files?.[0] ?? null);
          }}
          onClick={() => !working && isoInput.current?.click()}
          role="button"
          aria-label="Upload an ISO file"
          className="rounded-lg px-4 py-4 text-center cursor-pointer select-none"
          style={{
            border: `1px dashed ${dragOver ? "var(--cds-alias-interaction-action)" : "var(--cds-alias-object-border-color)"}`,
            background: dragOver
              ? "var(--qz-accent-soft)"
              : "var(--cds-alias-object-container-background-shade)",
            opacity: working ? 0.6 : 1,
          }}
        >
          {file ? (
            <div
              className="flex items-center justify-center gap-2"
              style={{ fontSize: 13, color: "var(--cds-alias-typography-color-450)" }}
            >
              <span style={{ fontFamily: "var(--qz-font-mono)" }}>{file.name}</span>
              <span style={{ fontSize: 12, color: "var(--cds-alias-typography-color-200)" }}>
                {(file.size / (1024 * 1024)).toFixed(0)} MB
              </span>
              {!working && (
                <button
                  type="button"
                  aria-label="Remove selected file"
                  onClick={(e) => {
                    e.stopPropagation();
                    pickFile(null);
                  }}
                  className="btn btn-sm btn-link-neutral btn-icon"
                  style={{ margin: 0 }}
                >
                  <Icon shape="trash" size={13} />
                </button>
              )}
            </div>
          ) : (
            <p className="m-0" style={{ fontSize: 13, color: "var(--cds-alias-typography-color-300)" }}>
              …or drop a QuartzFire <span style={{ fontFamily: "var(--qz-font-mono)" }}>.iso</span> here
              (or click to browse)
            </p>
          )}
          <input
            ref={isoInput}
            type="file"
            accept=".iso"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              e.target.value = "";
              if (f) pickFile(f);
            }}
          />
        </div>

        <p className="clr-subtext" style={{ margin: 0 }}>
          The image installs next to the current one, so the running system is untouched until you reboot —
          and the previous image stays available as a rollback boot entry.
        </p>

        {phase === "uploading" && (
          <div className="flex flex-col gap-1">
            <div className="progress">
              <div className="progress-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
            <p className="m-0" style={{ fontSize: 12, color: "var(--cds-alias-typography-color-300)" }}>
              Uploading… {Math.round(progress * 100)}%. Keep this page open.
            </p>
          </div>
        )}
        {phase === "installing" && (
          <div className="flex flex-col gap-1">
            {jobPhase === "downloading" && dlFraction !== null && (
              <div className="progress">
                <div className="progress-fill" style={{ width: `${Math.round(dlFraction * 100)}%` }} />
              </div>
            )}
            <p className="m-0" style={{ fontSize: 12, color: "var(--cds-alias-typography-color-300)" }}>
              {jobPhase === "downloading"
                ? `Downloading the image${dlFraction !== null ? ` — ${Math.round(dlFraction * 100)}%` : "…"}`
                : jobPhase === "verifying"
                  ? "Verifying the download…"
                  : jobPhase === "installing"
                    ? "Unpacking and installing the image…"
                    : file
                      ? "Installing the uploaded image…"
                      : "Downloading and installing…"}{" "}
              this can take several minutes. Keep this page open.
            </p>
          </div>
        )}
        {error && (
          <p className="m-0" style={{ fontSize: 12, color: "var(--cds-alias-status-danger)" }}>
            {error}
          </p>
        )}

        <ModalFooter>
          <button type="button" className="btn btn-neutral" onClick={close} disabled={working}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={working || (!file && url.trim() === "")}
          >
            {phase === "uploading" ? "Uploading…" : phase === "installing" ? "Installing…" : file ? "Upload & Install" : "Install Image"}
          </button>
        </ModalFooter>
      </form>
    </ModalShell>
  );
}

/// Delete-only row action with inline confirmation (RowActions assumes an
/// edit affordance images don't have).
function DeleteImageAction({ name, onDelete }: { name: string; onDelete: () => Promise<unknown> }) {
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);

  if (confirming) {
    return (
      <span className="inline-flex items-center gap-1 justify-end">
        <button
          type="button"
          disabled={working}
          onClick={async () => {
            setWorking(true);
            try {
              await onDelete();
            } finally {
              setWorking(false);
              setConfirming(false);
            }
          }}
          className="btn btn-sm btn-danger"
          style={{ margin: 0 }}
        >
          {working ? "…" : "Confirm"}
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="btn btn-sm btn-neutral"
          style={{ margin: 0 }}
        >
          Cancel
        </button>
      </span>
    );
  }
  return (
    <button
      type="button"
      title={`Delete image ${name}`}
      aria-label="Delete"
      onClick={() => setConfirming(true)}
      className="btn btn-sm btn-link-neutral btn-icon"
      style={{ margin: 0 }}
    >
      <Icon shape="trash" size={14} />
    </button>
  );
}

/// Restore an uploaded config.boot backup, replacing the whole configuration.
/// The heavy lifting (validation, snapshot, commit-confirm) is the backend's;
/// this modal makes sure the user understands the blast radius first.
function RestoreConfigModal({
  file,
  onClose,
  onStarted,
}: {
  file: File;
  onClose: () => void;
  onStarted: () => void;
}) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");

  const run = async () => {
    setWorking(true);
    setError("");
    try {
      await restoreConfigBackup(await file.text());
      onStarted();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Restore failed.");
      setWorking(false);
    }
  };

  return (
    <ModalShell onClose={onClose} maxWidth={520}>
      <ModalHeader
        title="Restore Configuration"
        subtitle={`Replace the entire configuration with ${file.name}`}
        onClose={onClose}
      />
      <div className="flex flex-col gap-4">
        <p className="m-0" style={{ fontSize: 13, color: "var(--cds-alias-typography-color-400)" }}>
          Every current setting — interfaces, firewall, NAT, users, services — is replaced by the
          uploaded file, which must be a config.boot-style backup (the format the download produces).
        </p>
        <p className="m-0" style={{ fontSize: 12, color: "var(--cds-alias-typography-color-200)" }}>
          The restore applies under commit-confirm: unless you confirm it in the banner within 2 minutes,
          the current configuration is restored automatically. Plain VyOS config.boot files (migrating
          from a stock VyOS box) work too — this WebUI&apos;s own access settings
          (<span className="mono">service https</span>) are preserved from the running configuration,
          so a restore can never lock the UI out.
        </p>
        {error && (
          <p className="m-0" style={{ fontSize: 12, color: "var(--cds-alias-status-danger)" }}>
            {error}
          </p>
        )}
        <ModalFooter>
          <button type="button" className="btn btn-neutral" onClick={onClose} disabled={working}>
            Cancel
          </button>
          <button type="button" className="btn btn-danger" disabled={working} onClick={run}>
            {working ? "Restoring…" : "Restore Configuration"}
          </button>
        </ModalFooter>
      </div>
    </ModalShell>
  );
}

/// Factory reset — the most destructive action in the WebUI. Wipes the whole
/// configuration back to defaults and reboots; the box comes back at vyos/vyos
/// on the console with no WebUI/SSH until reconfigured. Gated by a
/// type-to-confirm so it can't be fired by a stray click.
const RESET_PHRASE = "factory reset";

function FactoryResetModal({
  onClose,
  onConfirmed,
}: {
  onClose: () => void;
  onConfirmed: (message: string) => void;
}) {
  const [phrase, setPhrase] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");

  const armed = phrase.trim().toLowerCase() === RESET_PHRASE;

  const run = async () => {
    if (!armed) return;
    setWorking(true);
    setError("");
    try {
      await factoryReset();
      onConfirmed(
        "Factory reset started — the firewall wipes its configuration and reboots to defaults. The WebUI will be unreachable until it's reconfigured at the console.",
      );
    } catch (e) {
      // The reboot severs the connection before answering — treat that as success.
      const msg = e instanceof Error ? e.message : "";
      if (/network|fetch|unreachable|gateway/i.test(msg)) {
        onConfirmed("Factory reset started — the firewall is resetting and rebooting.");
        return;
      }
      setError(msg || "Failed to start the factory reset.");
      setWorking(false);
    }
  };

  return (
    <ModalShell onClose={onClose} maxWidth={480}>
      <ModalHeader
        title="Factory Reset"
        subtitle="Erase all configuration and reboot to defaults"
        onClose={onClose}
      />
      <div className="flex flex-col gap-4">
        <p className="m-0" style={{ fontSize: 13, color: "var(--cds-alias-typography-color-400)" }}>
          This replaces the boot configuration with the factory default and reboots. Every setting —
          interfaces, firewall, NAT, users, services, this WebUI&apos;s own API access — is erased.
          The firewall comes back with the default <span className="mono">vyos</span>/<span className="mono">vyos</span>{" "}
          login, reachable only at the console until it&apos;s reconfigured. There is no undo and no
          auto-revert.
        </p>
        <p className="m-0" style={{ fontSize: 12, color: "var(--cds-alias-typography-color-200)" }}>
          Download a configuration backup first if you might want any of it back. Type
          {" "}
          <span className="mono" style={{ color: "var(--cds-alias-typography-color-400)" }}>{RESET_PHRASE}</span>{" "}
          below to confirm.
        </p>
        <div className="clr-form-control">
          <label className="clr-control-label" htmlFor="factory-reset-phrase">Confirmation phrase</label>
          <input
            id="factory-reset-phrase"
            value={phrase}
            onChange={(e) => setPhrase(e.target.value)}
            placeholder={RESET_PHRASE}
            className="clr-input"
            style={monoSt}
            autoFocus
          />
        </div>
        {error && (
          <p className="m-0" style={{ fontSize: 12, color: "var(--cds-alias-status-danger)" }}>
            {error}
          </p>
        )}
        <ModalFooter>
          <button type="button" className="btn btn-neutral" onClick={onClose} disabled={working}>
            Cancel
          </button>
          <button type="button" className="btn btn-danger" disabled={working || !armed} onClick={run}>
            {working ? "Resetting…" : "Erase & Reset to Defaults"}
          </button>
        </ModalFooter>
      </div>
    </ModalShell>
  );
}

export default function MaintenancePage() {
  const { setToast } = useDashboard();
  const [images, setImages] = useState<SystemImage[] | null>(null);
  const [loading, setLoading] = useState(true);

  const [powerModal, setPowerModal] = useState<PowerAction | null>(null);
  const [scheduleModal, setScheduleModal] = useState(false);
  const [schedule, setSchedule] = useState<ShutdownSchedule | null>(null);
  const [resetModal, setResetModal] = useState(false);

  const refreshSchedule = useCallback(() => {
    fetchShutdownSchedule()
      .then(setSchedule)
      .catch(() => setSchedule(null));
  }, []);
  useEffect(() => {
    refreshSchedule();
  }, [refreshSchedule]);
  const [addModal, setAddModal] = useState(false);
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [downloading, setDownloading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      setImages(await fetchImages());
    } catch {
      setImages([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const removeImage = async (img: SystemImage) => {
    try {
      await deleteImage(img.name);
      setToast(`Deleted image ${img.name}.`);
      await load();
    } catch (e) {
      setToast(e instanceof Error ? e.message : `Failed to delete image ${img.name}.`);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h2 className="m-0">Maintenance</h2>
        <p className="clr-secondary" style={{ marginTop: 4 }}>
          Configuration backups, power, system images, and the factory-reset escape hatch.
        </p>
      </div>

      <div className="flex flex-col gap-4">
        {/* Configuration backup / restore */}
        <div className="card">
          <div className="card-header">Configuration</div>
          <div className="card-block">
            <p className="clr-secondary" style={{ marginTop: 0, marginBottom: 16 }}>
              Download the running configuration as a config.boot file, or restore one. A restore replaces
              the entire configuration and must be confirmed within 2 minutes or it reverts automatically —
              per-commit rollback lives on the Audit Log page.
            </p>
            <div className="flex gap-2">
              <Button
                kind="secondary"
                icon="download"
                disabled={downloading}
                onClick={async () => {
                  setDownloading(true);
                  try {
                    await downloadConfigBackup();
                  } catch (e) {
                    setToast(e instanceof Error ? e.message : "Backup download failed.");
                  } finally {
                    setDownloading(false);
                  }
                }}
              >
                {downloading ? "Preparing…" : "Download Backup"}
              </Button>
              <Button kind="secondary" icon="upload" onClick={() => fileInput.current?.click()}>
                Restore from Backup…
              </Button>
              <input
                ref={fileInput}
                type="file"
                accept=".boot,.conf,.cfg,.txt,text/plain"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  // Reset so picking the same file again re-fires onChange.
                  e.target.value = "";
                  if (f) setRestoreFile(f);
                }}
              />
            </div>
          </div>
        </div>

        {/* Power */}
        <div className="card">
          <div className="card-header">Power</div>
          <div className="card-block">
            <p className="clr-secondary" style={{ marginTop: 0, marginBottom: 16 }}>
              Both actions interrupt all traffic through the firewall. Configuration is already saved to the
              boot config after every apply, so nothing is lost by rebooting.
            </p>
            {schedule?.scheduled && (
              <div className="alert alert-warning alert-sm" style={{ marginBottom: 16 }}>
                <Icon shape="history" size={14} className="alert-icon" />
                <div className="alert-text">
                  {schedule.mode === "poweroff" ? "Shutdown" : "Reboot"} scheduled for{" "}
                  {schedule.at_ms ? (
                    <span className="mono">{new Date(schedule.at_ms).toLocaleString()}</span>
                  ) : (
                    "an unknown time"
                  )}.
                </div>
                <div className="alert-actions">
                  <button
                    type="button"
                    className="alert-action"
                    onClick={async () => {
                      try {
                        await cancelScheduledReboot();
                        setToast("Scheduled reboot cancelled.");
                      } catch (e) {
                        setToast(e instanceof Error ? e.message : "Cancel failed.");
                      }
                      refreshSchedule();
                    }}
                  >
                    Cancel schedule
                  </button>
                </div>
              </div>
            )}
            <div className="flex gap-2">
              <button type="button" className="btn btn-warning-outline" onClick={() => setPowerModal("reboot")}>
                <Icon shape="refresh" size={16} />
                Reboot
              </button>
              <Button kind="secondary" icon="history" onClick={() => setScheduleModal(true)}>
                Schedule Reboot…
              </Button>
              <button type="button" className="btn btn-danger-outline" onClick={() => setPowerModal("shutdown")}>
                Shut Down
              </button>
            </div>
          </div>
        </div>

        {/* Factory reset */}
        <div className="card">
          <div className="card-header">Factory Reset</div>
          <div className="card-block">
            <p className="clr-secondary" style={{ marginTop: 0, marginBottom: 16 }}>
              Erase the entire configuration and reboot to factory defaults. The firewall comes back at the
              default <span className="mono">vyos</span>/<span className="mono">vyos</span> login, reachable
              only at the console until reconfigured — there is no undo. Download a configuration backup
              first if you might want any of it back.
            </p>
            <div className="flex gap-2">
              <button type="button" className="btn btn-danger-outline" onClick={() => setResetModal(true)}>
                Reset to Factory Defaults…
              </button>
            </div>
          </div>
        </div>

        {/* System images */}
        <div className="card">
          <div className="card-header">
            System Images
            <span style={{ marginLeft: "auto" }}>
              <Button kind="primary" size="sm" icon="plus" onClick={() => setAddModal(true)}>
                Add Image
              </Button>
            </span>
          </div>
          <div className="card-block">
            <p className="clr-secondary" style={{ marginTop: 0, marginBottom: 16 }}>
              QuartzFire is image-based: upgrades install a whole new image next to the running one, and a
              reboot switches over. The previous image stays installed as a rollback boot entry.
            </p>

            {loading ? (
              <div className="clr-secondary">Loading images…</div>
            ) : images && images.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="table table-noborder table-compact">
                  <thead>
                    <tr>
                      <th>Image</th>
                      <th style={{ width: 130 }}>Default boot</th>
                      <th style={{ width: 110 }}>Running</th>
                      <th className="right" style={{ width: 150 }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {images.map((img) => (
                      <tr key={img.name}>
                        <td className="mono">{img.name}</td>
                        <td>
                          {img.default_boot ? (
                            <Pill tone="success">Default</Pill>
                          ) : (
                            <span style={{ color: "var(--cds-alias-typography-color-200)" }}>—</span>
                          )}
                        </td>
                        <td>
                          {img.running ? (
                            <Pill tone="info">Running</Pill>
                          ) : (
                            <span style={{ color: "var(--cds-alias-typography-color-200)" }}>—</span>
                          )}
                        </td>
                        <td className="right">
                          {img.running ? (
                            <span title="The running image can't delete itself.">
                              <Pill tone="info">In Use</Pill>
                            </span>
                          ) : (
                            <DeleteImageAction name={img.name} onDelete={() => removeImage(img)} />
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="flex items-center gap-2 clr-secondary">
                <Icon shape="exclamation-triangle" size={14} />
                Could not read the installed images (older or non-image installs don&apos;t report them). Adding an
                image and power actions still work.
              </div>
            )}
          </div>
        </div>
      </div>

      {powerModal && (
        <PowerConfirmModal
          action={powerModal}
          onClose={() => setPowerModal(null)}
          onConfirmed={(msg) => {
            setPowerModal(null);
            setToast(msg);
          }}
        />
      )}

      {scheduleModal && (
        <ScheduleRebootModal
          onClose={() => setScheduleModal(false)}
          onScheduled={() => {
            setScheduleModal(false);
            setToast("Reboot scheduled.");
            refreshSchedule();
          }}
        />
      )}

      {resetModal && (
        <FactoryResetModal
          onClose={() => setResetModal(false)}
          onConfirmed={(msg) => {
            setResetModal(false);
            setToast(msg);
          }}
        />
      )}

      {restoreFile && (
        <RestoreConfigModal
          file={restoreFile}
          onClose={() => setRestoreFile(null)}
          onStarted={() => {
            setRestoreFile(null);
            setToast("Configuration restored — confirm it in the banner to keep it.");
          }}
        />
      )}

      {addModal && (
        <AddImageModal
          installed={images ?? []}
          onClose={() => setAddModal(false)}
          onSaved={(msg) => {
            setAddModal(false);
            setToast(msg);
            load();
          }}
        />
      )}
    </div>
  );
}
