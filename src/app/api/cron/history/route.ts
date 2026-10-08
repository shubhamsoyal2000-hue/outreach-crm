import { cronAuthorized } from "@/lib/cron-auth";
import { runHistoryPass } from "@/lib/history/run";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Called every minute by the scheduler; does nothing unless a Gmail history scan is in progress. */
async function history(request: Request) {
  if (!(await cronAuthorized(request))) return Response.json({ error: "unauthorized" }, { status: 401 });
  const scans = await runHistoryPass(40_000);
  return Response.json({ at: new Date().toISOString(), scans });
}

export const GET = history;
export const POST = history;
