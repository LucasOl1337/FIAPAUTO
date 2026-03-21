export function StatusCard({ label, value }: { label: string; value: string }) {
  return <div className="status-card"><span>{label}</span><strong>{value}</strong></div>
}
