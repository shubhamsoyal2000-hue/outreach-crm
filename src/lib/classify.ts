import type { InboundKind } from "./types";

export interface InboundMessage {
  from: string;
  subject: string;
  snippet: string;
  /** Header names lower-cased. */
  headers: Record<string, string>;
}

export interface Classification {
  kind: InboundKind;
  /** For bounces: the address that failed, when the message says. */
  failedRecipient?: string;
  /** For bounces: true when the failure is permanent (5.x.x, address not found). */
  hardBounce?: boolean;
  /** For auto-replies: the mailbox is no longer read (closed, person left), or it sends us to another address. */
  notMonitored?: boolean;
}

export function parseAddress(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).trim().toLowerCase();
}

const BOUNCE_SENDERS = /^(mailer-daemon|postmaster|mail-daemon|mailerdaemon)@/;
const BOUNCE_SUBJECT = /(delivery status notification|undeliverable|undelivered mail|delivery failure|returned mail|mail delivery (failed|subsystem)|failure notice|could not be delivered)/i;
const SOFT_BOUNCE = /(\(delay\)|delayed|temporar|try again later|will retry|mailbox (is )?full|over quota|4\.\d\.\d)/i;
const HARD_BOUNCE = /(address not found|does not exist|no such user|user unknown|recipient (address )?rejected|invalid (recipient|address|mailbox)|mailbox unavailable|5\.[0-7]\.\d+|couldn'?t be found|not found)/i;

const AUTO_SUBJECT = /^(automatic reply|auto(matic)?[- ]?reply|auto:|out of (the )?office|ooo\b|away from (the )?office|on vacation|on leave|autoreply|i am out|i'm out|currently out|r[ée]ponse automatique|respuesta autom[aá]tica|risposta automatica|automatische antwort|abwesenheit|resposta autom[aá]tica)/i;
const AUTO_BODY = /(out of (the )?office|on (annual |parental |maternity )?leave|limited access to (my )?email|will (be )?(back|return)|returning on|away until|on vacation|currently traveling)/i;

// "This mailbox is no longer monitored", "X is no longer with the company", "has left ..."
const NOT_MONITORED = /(no longer (being )?(monitored|checked|in use|active|valid)|(is|are) not (being )?monitored|not monitored|no longer (with (us|the company|our company|the organization|the firm)|employed|working (at|for|here)|part of (the|our) (team|company))|(is|am) no longer (with|at) |(has|have) (left|retired from) (the company|our company|the organization|[a-z0-9&.' -]{2,40}(inc|llc|ltd|corp|company))|mailbox (is|has been) (closed|deactivated|disabled|discontinued|inactive)|(email|e-mail) (address|account) (has been|is) (deactivated|disabled|closed|discontinued|inactive))/i;

// "Please use the address below for any request: x@acme.com"
const REDIRECT = /(please (use|contact|write to|e-?mail|reach out to|send (it |your (request|email|message)s? )?to|direct (all |your )?(requests|inquiries|emails) to)|for (any|all) (requests|inquiries|questions)[ ,:]+(please )?(contact|use|e-?mail))/i;
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

/** True when an auto-reply says nobody reads this address any more. */
export function isNotMonitored(text: string): boolean {
  return NOT_MONITORED.test(text);
}

const OPT_OUT = /\b(unsubscribe|remove me|take me off|stop (emailing|e-mailing|sending|contacting)|do not (email|contact)|don'?t (email|contact)|no longer interested|opt[- ]?out|not interested,? (please )?(remove|stop))\b/i;

export function classifyInbound(msg: InboundMessage): Classification {
  const from = parseAddress(msg.from);
  const h = msg.headers;
  const text = `${msg.subject}\n${msg.snippet}`;

  const isBounce =
    BOUNCE_SENDERS.test(from) ||
    !!h["x-failed-recipients"] ||
    /multipart\/report/i.test(h["content-type"] ?? "") ||
    (BOUNCE_SUBJECT.test(msg.subject) && /daemon|postmaster|mail delivery/i.test(msg.from));
  if (isBounce) {
    const failed = h["x-failed-recipients"]?.split(",")[0]?.trim().toLowerCase();
    const hard = !SOFT_BOUNCE.test(text) || HARD_BOUNCE.test(text);
    return { kind: "bounce", failedRecipient: failed || undefined, hardBounce: hard && !/\(delay\)/i.test(msg.subject) };
  }

  const autoSubmitted = (h["auto-submitted"] ?? "").toLowerCase();
  const precedence = (h["precedence"] ?? "").toLowerCase();
  const isAuto =
    (autoSubmitted !== "" && autoSubmitted !== "no") ||
    "x-autoreply" in h ||
    "x-autorespond" in h ||
    ["auto_reply", "bulk", "junk"].includes(precedence) ||
    AUTO_SUBJECT.test(msg.subject.trim()) ||
    // A real reply keeps our "Re:" subject; a short "I'm away" note under a new subject is an auto-reply.
    (!/^re:/i.test(msg.subject) && AUTO_BODY.test(msg.snippet) && msg.snippet.length < 400);
  if (isAuto) {
    const elsewhere = isNotMonitored(text) || (REDIRECT.test(text) && EMAIL.test(text));
    return { kind: "auto_reply", ...(elsewhere ? { notMonitored: true } : {}) };
  }
  // Some servers send "no longer monitored" notes without auto-reply headers; they are not real replies.
  if (!/^re:/i.test(msg.subject) || msg.snippet.length < 400) {
    if (isNotMonitored(text)) return { kind: "auto_reply", notMonitored: true };
  }

  if (OPT_OUT.test(text)) return { kind: "unsubscribe_reply" };
  return { kind: "reply" };
}
