import { login } from "../actions";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <main style={{ maxWidth: 360, margin: "18vh auto", padding: "0 16px" }}>
      <div className="panel">
        <h1>Outreach CRM</h1>
        {error && <div className="notice bad">Wrong password.</div>}
        <form action={login}>
          <label htmlFor="password">Team password</label>
          <input id="password" name="password" type="password" autoFocus required />
          <div className="actions">
            <button type="submit">Sign in</button>
          </div>
        </form>
      </div>
    </main>
  );
}
