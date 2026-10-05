import { resolveMx } from "node:dns/promises";
import { emailDomain, precheck } from "../email-rules";
import type { Verifier, VerifyResult } from "../engine/ports";

// The provider calls below follow each provider's public API as of 2026.
// Check the response fields against their docs when you sign up.

async function millionVerifier(apiKey: string, email: string): Promise<VerifyResult> {
  const url = `https://api.millionverifier.com/api/v3/?api=${encodeURIComponent(apiKey)}&email=${encodeURIComponent(email)}&timeout=20`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`MillionVerifier HTTP ${res.status}`);
  const data = (await res.json()) as { result?: string; subresult?: string; error?: string };
  if (data.error) throw new Error(`MillionVerifier: ${data.error}`);
  const detail = [data.result, data.subresult].filter(Boolean).join(" / ");
  switch (data.result) {
    case "ok": return { status: "valid", detail };
    case "catch_all": return { status: "catch_all", detail };
    case "invalid": return { status: "invalid", detail };
    case "disposable": return { status: "disposable", detail };
    default: return { status: "unknown", detail };
  }
}

async function zeroBounce(apiKey: string, email: string): Promise<VerifyResult> {
  const url = `https://api.zerobounce.net/v2/validate?api_key=${encodeURIComponent(apiKey)}&email=${encodeURIComponent(email)}&ip_address=`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ZeroBounce HTTP ${res.status}`);
  const data = (await res.json()) as { status?: string; sub_status?: string; error?: string };
  if (data.error) throw new Error(`ZeroBounce: ${data.error}`);
  const detail = [data.status, data.sub_status].filter(Boolean).join(" / ");
  switch (data.status) {
    case "valid": return { status: "valid", detail };
    case "catch-all": return { status: "catch_all", detail };
    case "invalid": return { status: "invalid", detail };
    case "spamtrap":
    case "abuse":
    case "do_not_mail": return { status: "risky", detail };
    default: return { status: "unknown", detail };
  }
}

/** Free checks first (syntax, role address, disposable domain, MX records), then the paid API. */
export function makeVerifier(provider: string | undefined, apiKey: string | undefined): Verifier | null {
  if (!provider || !apiKey) return null;
  const call = provider === "zerobounce" ? zeroBounce : provider === "millionverifier" ? millionVerifier : null;
  if (!call) throw new Error(`Unknown VERIFIER "${provider}". Use millionverifier or zerobounce.`);
  return {
    async verify(email, opts) {
      const pre = precheck(email, opts);
      if (!pre.ok) return { status: pre.reason === "disposable" ? "disposable" : pre.reason === "role" ? "risky" : "invalid", detail: pre.reason };
      try {
        const mx = await resolveMx(emailDomain(email));
        if (!mx.length) return { status: "invalid", detail: "domain has no mail server" };
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOTFOUND" || code === "ENODATA") return { status: "invalid", detail: "domain has no mail server" };
      }
      return call(apiKey, email);
    },
  };
}
