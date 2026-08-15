/// Placeholder for a console section that hasn't been implemented yet. Every
/// left-nav destination renders one of these until the real page lands.
export function StubPage({ title }: { title: string }) {
  return (
    <div>
      <h2>{title}</h2>
      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-block" style={{ padding: "48px 24px", textAlign: "center" }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--cds-alias-typography-color-450)" }}>
            Not implemented yet
          </div>
          <p className="clr-secondary" style={{ marginTop: 8 }}>
            This section is a placeholder — {title} management will land here.
          </p>
        </div>
      </div>
    </div>
  );
}
