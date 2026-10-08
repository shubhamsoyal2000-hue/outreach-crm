import "server-only";
import { env } from "./config";
import { decrypt } from "./crypto";
import { MailerError, type FetchedMessage, type Mailer, type SentMessage } from "./engine/ports";
import { toBase64Url } from "./mime";
import { htmlToText } from "./referrals";
import type { HistoryMessage, HistoryReader } from "./history/scan";
import type { Inbox } from "./types";

// Gmail over plain REST calls with OAuth, no stored passwords. gmail.modify
// covers sending and reading; it is a restricted scope, which an Internal app
// in your own Google Workspace can use without Google's app review.
const SCOPES = ["https://www.googleapis.com/auth/gmail.modify"];
const API = "https://gmail.googleapis.com/gmail/v1/users/me";

export function redirectUri(): string {
  return `${env.appUrl}/api/oauth/google/callback`;
}

export function authUrl(state: string, loginHint?: string): string {
  const params = new URLSearchParams({
    client_id: env.googleClientId,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  if (loginHint) params.set("login_hint", loginHint);
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function tokenRequest(body: Record<string, string>) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.googleClientId, client_secret: env.googleClientSecret, ...body }),
  });
  const data = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !data.access_token) {
    const msg = data.error_description || data.error || `HTTP ${res.status}`;
    throw new MailerError(data.error === "invalid_grant" || res.status === 401 ? "auth" : "other", `Google token: ${msg}`);
  }
  return data as { access_token: string; refresh_token?: string; expires_in: number };
}

export async function exchangeCode(code: string) {
  return tokenRequest({ code, grant_type: "authorization_code", redirect_uri: redirectUri() });
}

const tokenCache = new Map<string, { token: string; expires: number }>();

async function accessToken(inbox: Inbox): Promise<string> {
  if (!inbox.refresh_token_enc) throw new MailerError("auth", "inbox is not connected");
  const cached = tokenCache.get(inbox.id);
  if (cached && cached.expires > Date.now() + 60_000) return cached.token;
  const refresh = decrypt(env.encryptionKey, inbox.refresh_token_enc);
  const t = await tokenRequest({ refresh_token: refresh, grant_type: "refresh_token" });
  tokenCache.set(inbox.id, { token: t.access_token, expires: Date.now() + t.expires_in * 1000 });
  return t.access_token;
}

/**
 * Runs a Gmail call, and if Google rejects the access token (401) gets a fresh
 * one and tries once more. A cached token can be revoked before it expires, and
 * one rejected token must not mark the inbox disconnected while the saved
 * connection still works. A 401 means nothing was sent, so the retry is safe.
 */
async function withToken<T>(inbox: Inbox, run: (token: string) => Promise<T>): Promise<T> {
  try {
    return await run(await accessToken(inbox));
  } catch (err) {
    if (!(err instanceof MailerError && err.code === "auth" && err.fromGmailApi)) throw err;
    tokenCache.delete(inbox.id);
    return run(await accessToken(inbox));
  }
}

async function gmail<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init?.headers },
  });
  if (res.ok) return (await res.json()) as T;
  const text = await res.text();
  let reason = "";
  try {
    const err = JSON.parse(text).error;
    reason = `${err?.errors?.[0]?.reason ?? err?.status ?? ""}: ${err?.message ?? ""}`;
  } catch {
    reason = text.slice(0, 200);
  }
  if (res.status === 401) throw new MailerError("auth", reason, true);
  if (res.status === 429 || /rateLimit|dailyLimit|quota/i.test(reason)) throw new MailerError("rate_limit", reason);
  if (res.status === 403) throw new MailerError("suspended", reason);
  throw new MailerError("other", `Gmail HTTP ${res.status} ${reason}`);
}

export async function profileEmail(token: string): Promise<string> {
  const p = await gmail<{ emailAddress: string }>(token, "/profile");
  return p.emailAddress.toLowerCase();
}

interface GmailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
}

interface GmailMessage {
  id: string;
  threadId: string;
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart & { headers?: { name: string; value: string }[] };
}

function partText(part: GmailPart | undefined, mime: string): string {
  if (!part) return "";
  if (part.mimeType === mime && part.body?.data) return Buffer.from(part.body.data, "base64url").toString("utf8");
  return (part.parts ?? []).map((p) => partText(p, mime)).join("\n");
}

const METADATA_HEADERS = ["From", "Subject", "Message-ID", "Auto-Submitted", "Precedence", "X-Autoreply", "X-Autorespond", "X-Failed-Recipients", "Content-Type"];

function headerMap(m: GmailMessage): Record<string, string> {
  return Object.fromEntries((m.payload?.headers ?? []).map((h) => [h.name.toLowerCase(), h.value]));
}

async function getMetadata(token: string, id: string): Promise<GmailMessage> {
  const qs = METADATA_HEADERS.map((h) => `metadataHeaders=${encodeURIComponent(h)}`).join("&");
  return gmail<GmailMessage>(token, `/messages/${id}?format=metadata&${qs}`);
}

export const gmailMailer: Mailer = {
  async send(inbox, raw, threadId): Promise<SentMessage> {
    return withToken(inbox, async (token) => {
      const sent = await gmail<GmailMessage>(token, "/messages/send", {
        method: "POST",
        body: JSON.stringify({ raw: toBase64Url(raw), ...(threadId ? { threadId } : {}) }),
      });
      // Gmail writes its own Message-ID; follow-ups need it for In-Reply-To.
      let rfcMessageId: string | null = null;
      try {
        rfcMessageId = headerMap(await getMetadata(token, sent.id))["message-id"] ?? null;
      } catch {
        rfcMessageId = null;
      }
      return { messageId: sent.id, threadId: sent.threadId, rfcMessageId };
    });
  },

  async listInbound(inbox, since): Promise<FetchedMessage[]> {
    return withToken(inbox, async (token) => {
      const q = `after:${Math.floor(since.getTime() / 1000)} -in:sent -in:drafts -in:chats`;
      const ids: string[] = [];
      let pageToken: string | undefined;
      do {
        const page = await gmail<{ messages?: { id: string }[]; nextPageToken?: string }>(
          token,
          `/messages?maxResults=100&q=${encodeURIComponent(q)}${pageToken ? `&pageToken=${pageToken}` : ""}`,
        );
        ids.push(...(page.messages ?? []).map((m) => m.id));
        pageToken = page.nextPageToken;
      } while (pageToken && ids.length < 500);

      const out: FetchedMessage[] = [];
      for (const id of ids.reverse()) {
        const m = await getMetadata(token, id);
        const h = headerMap(m);
        out.push({
          id: m.id,
          threadId: m.threadId,
          from: h["from"] ?? "",
          subject: h["subject"] ?? "",
          snippet: m.snippet ?? "",
          headers: h,
          internalDate: new Date(Number(m.internalDate ?? Date.now())),
        });
      }
      return out;
    });
  },

  async getText(inbox, messageId): Promise<string> {
    return withToken(inbox, async (token) => {
      const m = await gmail<GmailMessage>(token, `/messages/${messageId}?format=full`);
      const plain = partText(m.payload, "text/plain");
      const html = partText(m.payload, "text/html");
      // Links like <a href="mailto:x@y.com"> only show up in the HTML part, so read both.
      return `${plain}\n${html ? htmlToText(html) : ""}`.slice(0, 20_000);
    });
  },
};

export async function accessTokenFromCode(code: string) {
  const t = await exchangeCode(code);
  return { accessToken: t.access_token, refreshToken: t.refresh_token ?? null, email: await profileEmail(t.access_token) };
}

const HISTORY_HEADERS = ["From", "To", "Cc", "Bcc", "Subject", ...METADATA_HEADERS.filter((h) => !["From", "Subject", "Message-ID"].includes(h))];

/** Read-only access for the Gmail history scan: search, then headers only (never bodies). */
export const gmailHistoryReader: HistoryReader = {
  async list(inbox, q, pageToken, max) {
    return withToken(inbox, async (token) => {
      const page = await gmail<{ messages?: { id: string; threadId: string }[]; nextPageToken?: string; resultSizeEstimate?: number }>(
        token,
        `/messages?maxResults=${max}&q=${encodeURIComponent(q)}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`,
      );
      return { messages: page.messages ?? [], next: page.nextPageToken ?? null, estimate: page.resultSizeEstimate ?? 0 };
    });
  },

  async get(inbox, ids) {
    if (!ids.length) return [];
    return withToken(inbox, async (token) => {
      const qs = HISTORY_HEADERS.map((h) => `metadataHeaders=${encodeURIComponent(h)}`).join("&");
      const out: HistoryMessage[] = [];
      // A few at a time stays well under Gmail's per-user rate limit.
      for (let i = 0; i < ids.length; i += 5) {
        const batch = await Promise.all(ids.slice(i, i + 5).map((id) => gmail<GmailMessage>(token, `/messages/${id}?format=metadata&${qs}`)));
        for (const m of batch) {
          out.push({ id: m.id, threadId: m.threadId, headers: headerMap(m), snippet: m.snippet ?? "", internalDate: new Date(Number(m.internalDate ?? Date.now())) });
        }
      }
      return out;
    });
  },
};
