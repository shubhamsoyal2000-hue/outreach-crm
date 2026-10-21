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
  /** For bounces: Gmail itself refused to send ("Message rejected"), so the inbox is the problem, not the address. */
  senderBlocked?: boolean;
  /** For bounces: the address exists but the recipient's side refused it (their own forwarding broke, or their admin only takes mail from approved senders). */
  recipientRefused?: boolean;
  /** For auto-replies: the mailbox is no longer read (closed, person left), or it sends us to another address. */
  notMonitored?: boolean;
}

export function parseAddress(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).trim().toLowerCase();
}

const BOUNCE_SENDERS = /^(mailer-daemon|postmaster|mail-daemon|mailerdaemon)@/;
const BOUNCE_SUBJECT = /(delivery status notification|undeliverable|undelivered mail|delivery failure|returned mail|mail delivery (failed|subsystem)|failure notice|could not be delivered)/i;
// Gmail's own refusal to send ("Message blocked ... The response was: Message rejected"),
// usually because it reads the email as bulk or spam. The recipient never saw it.
const SENDER_BLOCKED = /(the response was: message rejected|support\.google\.com\/mail\/(answer\/69585|\?p=UnsolicitedMessageError))/i;
const SOFT_BOUNCE = /(\(delay\)|delayed|temporar|try again later|will retry|mailbox (is )?full|over quota|4\.\d\.\d|邮箱已满|邮箱空间不足|超过对方服务器的上限|容量不足)/i;
// Not a bad address and not our reputation: the recipient's own forwarding failed, or their admin
// lets only approved senders in. Stop emailing them, but don't count it against the inbox.
const RECIPIENT_REFUSED = /(couldn'?t be forwarded|could not be forwarded|delivery not authori[sz]ed|has restricted who can send|only accepts? (e-?mail|messages) from|not authori[sz]ed to send to this (group|recipient))/i;
const HARD_BOUNCE = /(address not found|does not exist|no such user|user unknown|recipient (address )?rejected|invalid (recipient|address|mailbox)|mailbox unavailable|5\.[0-7]\.\d+|couldn'?t be found|not found)/i;

const AUTO_SUBJECT = /^(automatic reply|auto(matic)?[- ]?reply|auto:|out of (the )?office|ooo\b|away from (the )?office|on vacation|on leave|autoreply|i am out|i'm out|currently out|r[ée]ponse automatique|respuesta autom[aá]tica|risposta automatica|automatische antwort|abwesenheit|resposta autom[aá]tica)/i;
const AUTO_BODY = /(out of (the )?office|on (annual |parental |maternity )?leave|limited access to (my )?email|will (be )?(back|return)|returning on|away until|on vacation|currently traveling)/i;

// "This mailbox is no longer monitored", "X is no longer with the company", "has left ..."
const NOT_MONITORED = /(no longer (being )?(monitored|checked|in use|active|valid)|(is|are) not (being )?monitored|not monitored|no longer (with (us|the company|our company|the organization|the firm)|employed|working (at|for|here)|part of (the|our) (team|company))|(is|am) no longer (with|at) |(has|have) (left|retired from) (the company|our company|the organization|[a-z0-9&.' -]{2,40}(inc|llc|ltd|corp|company))|mailbox (is|has been) (closed|deactivated|disabled|discontinued|inactive)|(email|e-mail) (address|account) (has been|is) (deactivated|disabled|closed|discontinued|inactive))/i;

// "Please use the address below for any request: x@acme.com"
const REDIRECT = /(please (use|contact|write to|e-?mail|reach out to|send (it |your (request|email|message)s? )?to|direct (all |your )?(requests|inquiries|emails) to)|for (any|all) (requests|inquiries|questions)[ ,:]+(please )?(contact|use|e-?mail))/i;
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
// "Out of the office until the 26th, please contact Steve": the person is coming back,
// so a redirect in a note like this does not mean the address is dead.
const TEMPORARY = /(out of (the )?office|\bOOO\b|on (annual |parental |maternity |paternity )?(vacation|holiday|leave|pto)|away from (the |my )?(office|desk)|(will|shall) (be )?(return|back)|returning (on|to)|back (in the office )?on|during my absence|in my absence|while i am (away|out)|limited access to (my )?e-?mail|travell?ing)/i;

/** True when an auto-reply says nobody reads this address any more. */
export function isNotMonitored(text: string): boolean {
  return NOT_MONITORED.test(text);
}

const OPT_OUT = /\b(unsubscribe|remove me|take me off|stop (emailing|e-mailing|sending|contacting)|do not (email|contact)|don'?t (email|contact)|no longer interested|opt[- ]?out|not interested,? (please )?(remove|stop))\b/i;

// Gmail snippets come HTML-escaped ("couldn&#39;t"), which would hide words from the patterns above.
function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function classifyInbound(msg: InboundMessage): Classification {
  const from = parseAddress(msg.from);
  const h = msg.headers;
  const text = decodeEntities(`${msg.subject}\n${msg.snippet}`);

  const isBounce =
    BOUNCE_SENDERS.test(from) ||
    !!h["x-failed-recipients"] ||
    /multipart\/report/i.test(h["content-type"] ?? "") ||
    (BOUNCE_SUBJECT.test(msg.subject) && /daemon|postmaster|mail delivery/i.test(msg.from));
  if (isBounce) {
    const failed = h["x-failed-recipients"]?.split(",")[0]?.trim().toLowerCase();
    const hard = !SOFT_BOUNCE.test(text) || HARD_BOUNCE.test(text);
    if (SENDER_BLOCKED.test(text)) return { kind: "bounce", failedRecipient: failed || undefined, hardBounce: false, senderBlocked: true };
    if (RECIPIENT_REFUSED.test(text)) return { kind: "bounce", failedRecipient: failed || undefined, hardBounce: false, recipientRefused: true };
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
    const elsewhere = isNotMonitored(text) || (REDIRECT.test(text) && EMAIL.test(text) && !TEMPORARY.test(text));
    return { kind: "auto_reply", ...(elsewhere ? { notMonitored: true } : {}) };
  }
  // Some servers send "no longer monitored" notes without auto-reply headers; they are not real replies.
  if (!/^re:/i.test(msg.subject) || msg.snippet.length < 400) {
    if (isNotMonitored(text)) return { kind: "auto_reply", notMonitored: true };
  }

  if (OPT_OUT.test(text)) return { kind: "unsubscribe_reply" };
  return { kind: "reply" };
}
