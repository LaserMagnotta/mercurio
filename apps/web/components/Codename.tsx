// The shipment codename ("Tasso-Ambrato-742") rendered as a monospace chip —
// the single presentational home for a codename, so every surface (board,
// tracking, hub dashboard, account list, detail) shows it identically and
// Fase 5 can restyle it in one place. It is a LABEL, never a link or an
// action: nothing authorizes on a codename (ARCHITECTURE.md §7).

export function Codename({ value, className }: { value: string; className?: string }) {
  return <span className={className ? `codename ${className}` : 'codename'}>{value}</span>;
}
