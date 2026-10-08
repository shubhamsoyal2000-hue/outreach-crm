"use server";

import { redirect } from "next/navigation";
import { approveLine, lineStatus, skipLine } from "@/lib/opening-lines";
import { db } from "@/lib/store/supabase";

function back(tab: string, msg: string): never {
  redirect(`/lines?tab=${encodeURIComponent(tab || "pending")}&msg=${encodeURIComponent(msg)}`);
}

async function loadFacts(ids: string[]) {
  const res = await db().from("companies").select("id, facts").in("id", ids);
  if (res.error) throw new Error(res.error.message);
  return (res.data ?? []) as { id: string; facts: Record<string, string> | null }[];
}

async function saveFacts(id: string, facts: Record<string, string>) {
  const res = await db().from("companies").update({ facts }).eq("id", id);
  if (res.error) throw new Error(res.error.message);
}

/** One row's Approve or Skip button, with the line as edited in the box. */
export async function reviewLine(fd: FormData) {
  const id = String(fd.get("company_id") ?? "");
  const tab = String(fd.get("tab") ?? "pending");
  const decision = String(fd.get("decision") ?? "");
  const [company] = await loadFacts([id]);
  if (!company) back(tab, "That company is gone.");
  if (decision === "skip") {
    await saveFacts(id, skipLine(company.facts));
    back(tab, "Skipped. That company won't get the researched email.");
  }
  const facts = approveLine(company.facts, String(fd.get("line") ?? ""));
  await saveFacts(id, facts);
  back(tab, facts.custom_line ? "Approved." : "The line was empty, so it was skipped.");
}

/** Approves every pending line at the given confidence levels, word for word as researched. */
export async function approveAllLines(fd: FormData) {
  const levels = fd.getAll("confidence").map(String);
  if (!levels.length) back("pending", "Tick at least one confidence level.");
  const res = await db().from("companies").select("id, facts").not("facts->>line_draft", "is", null);
  if (res.error) throw new Error(res.error.message);
  let n = 0;
  for (const c of (res.data ?? []) as { id: string; facts: Record<string, string> }[]) {
    if (lineStatus(c.facts) !== "pending" || !levels.includes(c.facts.line_confidence ?? "low")) continue;
    await saveFacts(c.id, approveLine(c.facts, c.facts.line_draft));
    n++;
  }
  back("approved", `Approved ${n} lines.`);
}
