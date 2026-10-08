import Link from "next/link";
import { logout } from "../actions";

export default function CrmLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="shell">
      <nav className="nav">
        <div className="brand">Outreach CRM</div>
        <Link href="/">Dashboard</Link>
        <Link href="/quotes">Quotes</Link>
        <Link href="/contacts">Leads</Link>
        <Link href="/lookup">ImportInfo list</Link>
        <Link href="/lines">Opening lines</Link>
        <Link href="/history">Gmail history</Link>
        <Link href="/sequences">Sequences</Link>
        <Link href="/inboxes">Inboxes</Link>
        <Link href="/suppressions">Do not email</Link>
        <Link href="/settings">Settings</Link>
        <form action={logout}>
          <button type="submit">Sign out</button>
        </form>
      </nav>
      <main className="main">{children}</main>
    </div>
  );
}
