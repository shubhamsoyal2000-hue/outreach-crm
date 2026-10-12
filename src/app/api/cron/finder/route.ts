import { cronAuthorized } from "@/lib/cron-auth";
import { runFinderPass } from "@/lib/finder/run";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Called every minute by the scheduler; reads a batch of company websites for emails (Email finder page). */
async function finder(request: Request) {
  if (!(await cronAuthorized(request))) return Response.json({ error: "unauthorized" }, { status: 401 });
  const outcome = await runFinderPass(45_000);
  return Response.json({ at: new Date().toISOString(), ...outcome });
}

export const GET = finder;
export const POST = finder;
