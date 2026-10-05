import "server-only";
import { env } from "./config";
import { sign, unsign } from "./crypto";
import { SupabaseStore } from "./store/supabase";

export function unsubscribeToken(contactId: string): string {
  return sign(env.sessionSecret, `u.${contactId}`);
}

export function unsubscribeUrl(contactId: string): string {
  return `${env.appUrl}/unsubscribe?t=${encodeURIComponent(unsubscribeToken(contactId))}`;
}

export function contactIdFromToken(token: string | null): string | null {
  if (!token) return null;
  const value = unsign(env.sessionSecret, token);
  return value?.startsWith("u.") ? value.slice(2) : null;
}

/** Suppresses the address everywhere and stops every sequence at the contact's company. */
export async function unsubscribeContact(contactId: string): Promise<boolean> {
  const store = new SupabaseStore();
  const contact = await store.getContact(contactId);
  if (!contact) return false;
  await store.addSuppression({ email: contact.email, reason: "unsubscribe", note: "unsubscribe link" });
  await store.stopContactEnrollments(contact.id, "unsubscribed");
  if (contact.company_id) await store.stopCompany(contact.company_id, "replied", "unsubscribed via link", "company_replied");
  return true;
}
