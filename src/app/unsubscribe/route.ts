import { contactIdFromToken, unsubscribeContact } from "@/lib/unsubscribe";

export const dynamic = "force-dynamic";

function page(title: string, body: string, status = 200) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:15vh auto;padding:0 16px;color:#1a1a1a;line-height:1.5}button{font:inherit;padding:10px 18px;border-radius:6px;border:0;background:#1a1a1a;color:#fff;cursor:pointer}</style>
</head><body><h1 style="font-size:22px">${title}</h1>${body}</body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex" } });
}

/** The link in the email footer: one page, one button. */
export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("t");
  if (!contactIdFromToken(token)) return page("Link not recognised", "<p>This unsubscribe link is incomplete. Reply to the email with \"unsubscribe\" and we will remove you.</p>", 400);
  return page(
    "Stop these emails?",
    `<p>Click below and you will not get any more emails from us.</p><form method="post"><button type="submit">Unsubscribe</button></form>`,
  );
}

/** The form above, and one-click unsubscribe from Gmail and Yahoo (RFC 8058). */
export async function POST(request: Request) {
  const contactId = contactIdFromToken(new URL(request.url).searchParams.get("t"));
  if (!contactId) return page("Link not recognised", "<p>Reply to the email with \"unsubscribe\" and we will remove you.</p>", 400);
  await unsubscribeContact(contactId);
  return page("You are unsubscribed", "<p>You will not receive any more emails from us. Sorry for the interruption.</p>");
}
