import type { Inbox, VerificationStatus } from "../types";

export interface SentMessage {
  messageId: string;
  threadId: string;
  rfcMessageId: string | null;
}

export interface FetchedMessage {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  snippet: string;
  headers: Record<string, string>;
  internalDate: Date;
}

export type MailerErrorCode = "auth" | "rate_limit" | "suspended" | "other";

export class MailerError extends Error {
  constructor(
    public code: MailerErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface Mailer {
  send(inbox: Inbox, rawMessage: string, threadId: string | null): Promise<SentMessage>;
  listInbound(inbox: Inbox, since: Date): Promise<FetchedMessage[]>;
}

export interface VerifyResult {
  status: Exclude<VerificationStatus, "unverified">;
  detail: string | null;
}

export interface Verifier {
  verify(email: string): Promise<VerifyResult>;
}

export interface EngineDeps {
  mailer: Mailer;
  /** Null when no verification API key is configured: unverified contacts then wait. */
  verifier: Verifier | null;
  unsubscribeUrl: (contactId: string) => string;
  now: () => Date;
  rng: () => number;
}
