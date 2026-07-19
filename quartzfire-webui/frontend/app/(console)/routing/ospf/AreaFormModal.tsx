"use client";

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { ModalShell, ModalHeader } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import { Switch } from "@/components/ui/Switch";
import { applyOspfArea, emptyOspfArea, OspfArea, OspfAreaType } from "@/lib/ospf";

const inputCls = "w-full rounded-md px-3 py-[9px] text-[13px] text-[var(--qz-fg-1)] outline-none";
const inputSt = { background: "var(--qz-input-bg)", border: "1px solid var(--qz-border)" } as const;
const monoSt = { ...inputSt, fontFamily: "var(--qz-font-mono)" } as const;

function focusBorder(e: React.FocusEvent<HTMLInputElement>) {
  e.currentTarget.style.borderColor = "var(--qz-accent)";
}
function blurBorder(e: React.FocusEvent<HTMLInputElement>) {
  e.currentTarget.style.borderColor = "var(--qz-border)";
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[12px] text-[var(--qz-fg-3)] mb-[6px]">{label}</label>
      {children}
      {hint && <p className="text-[11px] text-[var(--qz-fg-4)] m-0 mt-[5px]">{hint}</p>}
    </div>
  );
}

let keyCounter = 0;
const nextKey = () => `ospf-area-row-${keyCounter++}`;
interface ListRow { key: string; value: string }
const toRows = (values: string[]): ListRow[] => values.map((value) => ({ key: nextKey(), value }));

function ListEditor({ label, addLabel, placeholder, emptyText, rows, setRows }: {
  label: string;
  addLabel: string;
  placeholder: string;
  emptyText: string;
  rows: ListRow[];
  setRows: (u: (p: ListRow[]) => ListRow[]) => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-[6px]">
        <label className="block text-[12px] text-[var(--qz-fg-3)]">{label}</label>
        <button type="button" onClick={() => setRows((p) => [...p, { key: nextKey(), value: "" }])} className="flex items-center gap-[5px] text-[12px] text-[var(--qz-fg-3)] hover:text-[var(--qz-accent)] transition-colors cursor-pointer bg-transparent border-0 p-0">
          <Plus size={13} /> {addLabel}
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="text-[12px] text-[var(--qz-fg-4)] m-0">{emptyText}</p>
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((r) => (
            <div key={r.key} className="flex items-center gap-2">
              <input value={r.value} onChange={(e) => setRows((p) => p.map((x) => (x.key === r.key ? { ...x, value: e.target.value } : x)))} placeholder={placeholder} className={inputCls} style={monoSt} onFocus={focusBorder} onBlur={blurBorder} />
              <button type="button" onClick={() => setRows((p) => p.filter((x) => x.key !== r.key))} title="Remove" className="grid place-items-center w-9 h-9 flex-shrink-0 rounded-md text-[var(--qz-fg-4)] hover:text-[var(--qz-danger)] transition-colors cursor-pointer bg-transparent" style={{ border: "1px solid var(--qz-border)" }}>
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/// Create/edit an OSPF area. Diffs against the live config and commits under
/// commit-confirm.
export function AreaFormModal({ initial, existingAreas, onClose, onSaved }: {
  initial?: OspfArea;
  existingAreas: string[];
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const isEdit = !!initial;
  const base = initial ?? emptyOspfArea();
  const [area, setArea] = useState(base.area);
  const [areaType, setAreaType] = useState<OspfAreaType>(base.area_type);
  const [noSummary, setNoSummary] = useState(base.no_summary);
  const [networks, setNetworks] = useState<ListRow[]>(toRows(base.networks));
  const [ranges, setRanges] = useState<ListRow[]>(toRows(base.ranges));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");
    const id = area.trim();
    if (!id) {
      setError("Enter an area id (a number like 0, or a dotted-quad like 0.0.0.0).");
      return;
    }
    if (!isEdit && existingAreas.includes(id)) {
      setError(`Area ${id} already exists.`);
      return;
    }
    const desired: OspfArea = {
      area: id,
      area_type: areaType,
      no_summary: areaType !== "normal" && noSummary,
      networks: networks.map((r) => r.value.trim()).filter(Boolean),
      ranges: ranges.map((r) => r.value.trim()).filter(Boolean),
    };
    setSaving(true);
    try {
      const applied = await applyOspfArea(initial ?? null, desired);
      onSaved(applied === 0 ? "No changes — config already matches." : `Applied ${applied} change${applied === 1 ? "" : "s"} to area ${id}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply changes.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell onClose={onClose} maxWidth={560}>
      <ModalHeader title={`${isEdit ? "Edit" : "Add"} Area`} subtitle={isEdit ? `Area ${initial!.area}` : "OSPF area"} onClose={onClose} />
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Field label="Area ID" hint="A number (0) or dotted-quad (0.0.0.0).">
            <input value={area} disabled={isEdit} onChange={(e) => setArea(e.target.value)} placeholder="0" className={`${inputCls} disabled:opacity-70`} style={monoSt} onFocus={focusBorder} onBlur={blurBorder} />
          </Field>
          <Field label="Area type">
            <Segmented
              items={[
                { value: "normal", label: "Normal" },
                { value: "stub", label: "Stub" },
                { value: "nssa", label: "NSSA" },
              ]}
              value={areaType}
              onChange={(v) => setAreaType(v as OspfAreaType)}
            />
          </Field>
        </div>

        {areaType !== "normal" && (
          <label className="flex items-center gap-2 cursor-pointer select-none text-[13px] text-[var(--qz-fg-2)]">
            <Switch on={noSummary} onChange={setNoSummary} />
            No summary (totally stubby — block inter-area summaries)
          </label>
        )}

        <ListEditor
          label="Networks"
          addLabel="Add network"
          placeholder="10.0.0.0/24"
          emptyText="No networks — interfaces join this area explicitly instead."
          rows={networks}
          setRows={setNetworks}
        />

        <ListEditor
          label="Ranges"
          addLabel="Add range"
          placeholder="10.0.0.0/16"
          emptyText="No area ranges (summarisation) configured."
          rows={ranges}
          setRows={setRanges}
        />

        {error && <p className="text-[12px] m-0" style={{ color: "var(--qz-danger)" }}>{error}</p>}

        <div className="flex gap-2 justify-end mt-1">
          <button type="button" onClick={onClose} className="px-4 py-[9px] rounded-md text-[13px] font-medium cursor-pointer" style={{ background: "transparent", border: "1px solid var(--qz-border)", color: "var(--qz-fg-2)" }}>
            Cancel
          </button>
          <button type="submit" disabled={saving} className="px-4 py-[9px] rounded-md text-[13px] font-semibold cursor-pointer border-0" style={{ background: "var(--qz-accent)", color: "var(--qz-fg-on-accent)", opacity: saving ? 0.7 : 1 }}>
            {saving ? "Applying…" : isEdit ? "Apply changes" : "Add area"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
