export function ago(iso: string, now = Date.now()): string {
  const mins = Math.round((now - new Date(iso).getTime()) / 60_000);
  if (mins < 60) return `${Math.max(mins, 1)} min ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)} h ago`;
  return `${Math.round(mins / 1440)} days ago`;
}

export function money(n: number | null): string {
  return n == null ? "" : `$${Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}
