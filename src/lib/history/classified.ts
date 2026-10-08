import "server-only";
import { emailDomain, isFreemailDomain } from "../email-rules";
import { db, SupabaseStore } from "../store/supabase";
import { classifyHistory, companyToken, type ClassifiedAddress } from "./parse";
import { loadHistoryAddresses } from "./supabase";

/** The scan's addresses, sorted into groups the same way the review page shows them. */
export async function classifiedHistory(): Promise<ClassifiedAddress[]> {
  const store = new SupabaseStore();
  const [settings, inboxes, rows, blocked] = await Promise.all([
    store.getSettings(),
    store.listInboxes(),
    loadHistoryAddresses(),
    db().from("suppressions").select("domain").not("domain", "is", null),
  ]);
  if (blocked.error) throw new Error(blocked.error.message);
  const ownDomains = [...new Set(inboxes.map((i) => emailDomain(i.email)).filter((d) => !isFreemailDomain(d)))];
  return classifyHistory(rows, {
    now: new Date(),
    recentDays: 92,
    ownEmails: [...inboxes.map((i) => i.email), settings.alert_email].filter(Boolean),
    ownDomains,
    companyToken: companyToken(settings.company_name),
    allowShared: settings.allow_shared_inboxes,
    blockedDomains: (blocked.data ?? []).map((b: { domain: string }) => b.domain),
  });
}
