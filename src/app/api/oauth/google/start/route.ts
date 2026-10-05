import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { authUrl } from "@/lib/gmail";

export async function GET(request: Request) {
  const hint = new URL(request.url).searchParams.get("hint") ?? undefined;
  const state = randomBytes(16).toString("base64url");
  (await cookies()).set("oauth_state", state, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", maxAge: 600, path: "/" });
  redirect(authUrl(state, hint));
}
