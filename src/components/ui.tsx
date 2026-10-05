export function Flash({ msg, kind = "info" }: { msg?: string | string[]; kind?: "info" | "warn" | "bad" }) {
  const text = Array.isArray(msg) ? msg[0] : msg;
  if (!text) return null;
  return <div className={`notice ${kind === "info" ? "" : kind}`}>{text}</div>;
}

const TONE: Record<string, "good" | "warn" | "bad" | ""> = {
  active: "good",
  valid: "good",
  completed: "good",
  sent: "good",
  paused: "warn",
  draft: "",
  catch_all: "warn",
  unverified: "",
  unknown: "warn",
  replied: "good",
  reply: "good",
  stopped: "",
  disconnected: "bad",
  invalid: "bad",
  risky: "bad",
  disposable: "bad",
  bounce: "bad",
  do_not_contact: "bad",
};

export function Badge({ value }: { value: string | null | undefined }) {
  if (!value) return null;
  return <span className={`badge ${TONE[value] ?? ""}`}>{value.replace(/_/g, " ")}</span>;
}

export function Stat({ n, label }: { n: number | string; label: string }) {
  return (
    <div className="stat">
      <div className="n">{n}</div>
      <div className="l">{label}</div>
    </div>
  );
}

export function pct(part: number, whole: number): string {
  if (!whole) return "–";
  return `${((part / whole) * 100).toFixed(1)}%`;
}
