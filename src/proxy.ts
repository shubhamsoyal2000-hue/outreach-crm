import { NextResponse, type NextRequest } from "next/server";
import { isValidSession, SESSION_COOKIE } from "@/lib/session";

// Everything is behind the team login except the pages prospects and the
// scheduler reach: unsubscribe links and the cron endpoint (which checks its own secret).
const PUBLIC = [/^\/login$/, /^\/unsubscribe$/, /^\/api\/cron\//];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (PUBLIC.some((re) => re.test(pathname))) return NextResponse.next();
  const secret = process.env.SESSION_SECRET;
  if (secret && isValidSession(secret, request.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();
  if (pathname.startsWith("/api/")) return NextResponse.json({ error: "not signed in" }, { status: 401 });
  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
