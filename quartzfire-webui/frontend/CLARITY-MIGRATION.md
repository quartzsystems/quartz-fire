# Clarity migration contract (page sweeps)

The frontend is moving to the **Quartz Clarity Design System** (see the handoff at
`C:\Users\cwellman\Downloads\QuartzFire Clarity Redesign\QuartzFire Clarity Handoff.md`).
The foundation is DONE: tokens + Clarity class framework are imported globally
(`app/globals.css` ← `styles/tokens/*.css`, `styles/clarity/*.css`), the shell is the
Clarity Orchestrator (Header/Subnav/VerticalNav in `components/clarity/`), and the shared
UI kit is converted (`Button`, `IconButton`, `ModalShell/ModalHeader/ModalFooter`, `Tabs`,
`Segmented`, `Switch`, `DataTable`, `RowActions`, `Icon`).

Page sweeps convert each page's own markup. **Feature parity is absolute**: do not change
routes, data flows, API calls, validation, semantics, or any explanatory sentence (the
info-bar copy is part of the product's voice). This is a re-skin, not a rewrite.

## Rules

1. **Icons** — replace every `lucide-react` import with `Icon` from `@/components/ui/Icon`
   (`<Icon shape="…" size={16} />`). Clarity shape names (all valid): search, refresh, plus,
   pencil, trash, times, check, check-circle, exclamation-triangle, exclamation-circle,
   info-circle, arrow (with `dir`), angle (with `dir`), angle-double, filter, cog, world,
   download, upload, copy, play, pause, stop, eye, eye-hide, lock, unlock, shield, shield-x,
   shield-check, key, user, users, cloud, network-globe, network-settings, network-switch,
   link, unlink, tag, bookmark, list, grid-view, organization, layers, map, map-marker,
   line-chart, bar-chart, pie-chart, flow-chart, file, file-group, folder, history, sync,
   wrench, bolt, plug, ban, certificate, cluster, router, devices, applications, dashboard,
   host, storage, memory, cpu, hard-disk, disconnect, connect, warning-standard, bell,
   trash, undo, redo, login, logout, two-way-arrows, share, star, clipboard, note, minus,
   dot-circle, circle, help. Sizes: 12 inline, 14 small buttons, 16 default, 20 nav,
   24 page headers. `Button`/`IconButton` accept `icon="shape-name"` strings.
2. **Page header** — every page starts:
   ```tsx
   <h2>Page Title</h2>
   <p className="clr-secondary" style={{ marginTop: 4 }}>Existing one-line sub, verbatim.</p>
   ```
   (h2 is Clarity's 24/32 weight-400 title via base.css.) **Title Case** for page titles,
   card headers, tab labels, buttons, and modal titles; body copy stays sentence case.
3. **Info/notice bars** → Clarity alerts:
   ```tsx
   <div className="alert alert-info alert-sm">
     <Icon shape="info-circle" size={14} className="alert-icon" />
     <div className="alert-text">…existing copy verbatim…</div>
     <div className="alert-actions"><button className="alert-action">…</button></div>
   </div>
   ```
   Variants: alert-info / alert-warning / alert-danger / alert-success. Keep every sentence.
4. **Forms in modals** — each field becomes:
   ```tsx
   <div className="clr-form-control">
     <label className="clr-control-label">Label</label>
     <input className="clr-input" style={{ maxWidth: "none" }} … />
     <div className="clr-subtext">helper text</div>
   </div>
   ```
   Selects: `<div className="clr-select-wrapper"><select className="clr-select">…`
   Textareas: `clr-textarea`. Checkbox rows: `clr-checkbox-wrapper` + label. Radios:
   `clr-radio-wrapper`. Toggles: keep the shared `Switch`. `Segmented` stays for 2–4-way
   choices. Modal footers: use `ModalFooter` from `@/components/ui/Modal` with
   `btn btn-neutral` (Cancel) + `btn btn-primary` (action; "Applying…" while busy).
   Danger actions: `btn btn-danger`.
5. **Buttons** — raw `<button>` styling → `.btn` classes: `btn btn-primary` (one per view),
   `btn btn-neutral` (secondary), `btn btn-link-neutral` (ghost), `btn btn-danger`,
   `btn btn-danger-outline` / `btn btn-warning-outline`, `btn-sm`, `btn-icon`.
   The shared `Button` component already emits these — prefer it.
6. **Pills** — StatusBadge and `.badge badge-*` classes already render Clarity-style mono
   uppercase pills; leave them. Convert hand-rolled colored `<span>` status chips to
   `.label label-success|danger|warning|info` (mono uppercase text). When a pill sits
   beside buttons in a header row, wrap pill + buttons in one
   `display:flex; align-items:center` group.
7. **Cards** — `.surface`-based tiles → Clarity card anatomy where straightforward:
   `<div className="card"><div className="card-header">Title</div><div className="card-block">…`
   (`.surface` itself is restyled, so only convert when it doesn't disturb layout.)
8. **Tables** — pages using the shared `DataTable` get the datagrid look for free. New
   optional props: `onRowOpen` (double-click → open the row's edit modal — wire it on
   primary tables), `footerHint` (move existing per-page footer notes here),
   `onDeleteSelected` (bulk delete — only wire where single-row delete already exists and
   batching is obviously safe; otherwise skip). The row count now lives in the datagrid
   footer — remove duplicated "N rows" chips. Card-embedded mini tables → Clarity
   `.table table-noborder table-compact`.
9. **Tokens** — replace `--qz-*` var references you touch with the Clarity aliases where
   natural: text `--cds-alias-typography-color-450/400/300/200`, borders
   `--cds-alias-object-border-*`, surfaces `--cds-alias-object-container-*`, status
   `--cds-alias-status-*`, accent `--cds-alias-interaction-action`. Mono font:
   `var(--qz-font-mono)` is still valid. Don't chase every var — priority is markup.
10. **Charts use greens only** — download/RX `#00d992`, upload/TX `#7be8c4`. Blue
    `#4fb3ff` is reserved for info states, never traffic. Allowed/blocked in diagrams:
    green `rgba(0,217,146,.28)` / red `rgba(255,93,108,.38)`.
11. **Do not edit shared components** (`components/ui/*`, `components/clarity/*`,
    `components/dashboard/DataTable.tsx`, `RowActions.tsx`, shell, globals.css,
    styles/**). If a shared change seems needed, note it in your report instead.
12. **No new dependencies. No route changes. Don't run the build** — the orchestrator
    builds at the end.

Reference implementation of every screen: `C:\Users\cwellman\Downloads\QuartzFire Clarity
Redesign\QuartzFire Console.dc.html` (search it for your page's markup). Field/column
inventory: `…\notes\inventory.md`.
