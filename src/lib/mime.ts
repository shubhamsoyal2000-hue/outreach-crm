// Builds the raw RFC 5322 message the Gmail API sends. Plain text only.

export interface OutgoingEmail {
  fromName: string;
  fromEmail: string;
  to: string;
  subject: string;
  body: string;
  inReplyTo?: string | null;
  references?: string | null;
  /** Omitted for internal alerts, which are not marketing email. */
  listUnsubscribeUrl?: string;
  listUnsubscribeMailto?: string;
}

function needsEncoding(s: string): boolean {
  return /[^\x20-\x7e]/.test(s);
}

/** RFC 2047 encoded word for headers with non-ASCII text. */
export function encodeHeader(s: string): string {
  return needsEncoding(s) ? `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=` : s;
}

function encodeDisplayName(name: string): string {
  if (needsEncoding(name)) return encodeHeader(name);
  return `"${name.replace(/["\\]/g, "\\$&")}"`;
}

/** Quoted-printable body encoding with soft breaks at 76 characters. */
export function quotedPrintable(text: string): string {
  const lines = text.replace(/\r\n|\r/g, "\n").split("\n");
  return lines
    .map((line) => {
      const bytes = Buffer.from(line, "utf8");
      let encoded = "";
      for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        const isLast = i === bytes.length - 1;
        const printable = (b >= 33 && b <= 126 && b !== 61) || ((b === 32 || b === 9) && !isLast);
        encoded += printable ? String.fromCharCode(b) : `=${b.toString(16).toUpperCase().padStart(2, "0")}`;
      }
      const out: string[] = [];
      while (encoded.length > 76) {
        let cut = 75;
        // Do not split an =XX escape across lines.
        const eq = encoded.lastIndexOf("=", cut);
        if (eq > cut - 3) cut = eq;
        out.push(encoded.slice(0, cut) + "=");
        encoded = encoded.slice(cut);
      }
      out.push(encoded);
      return out.join("\r\n");
    })
    .join("\r\n");
}

export function buildRawMessage(email: OutgoingEmail): string {
  const headers = [
    `From: ${encodeDisplayName(email.fromName)} <${email.fromEmail}>`,
    `To: ${email.to}`,
    `Subject: ${encodeHeader(email.subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: quoted-printable",
  ];
  if (email.listUnsubscribeUrl && email.listUnsubscribeMailto) {
    headers.push(`List-Unsubscribe: <${email.listUnsubscribeUrl}>, <${email.listUnsubscribeMailto}>`, "List-Unsubscribe-Post: List-Unsubscribe=One-Click");
  }
  if (email.inReplyTo) headers.push(`In-Reply-To: ${email.inReplyTo}`);
  if (email.references) headers.push(`References: ${email.references}`);
  return `${headers.join("\r\n")}\r\n\r\n${quotedPrintable(email.body)}`;
}

export function toBase64Url(raw: string): string {
  return Buffer.from(raw, "utf8").toString("base64url");
}
