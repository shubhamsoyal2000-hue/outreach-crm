export type VerificationStatus =
  | "unverified"
  | "valid"
  | "catch_all"
  | "risky"
  | "invalid"
  | "disposable"
  | "unknown";

export interface Settings {
  sending_enabled: boolean;
  company_name: string;
  postal_address: string;
  opt_out_line: string;
  /** Email info@, sales@ style shared inboxes (no-reply, abuse, hr... stay blocked). */
  allow_shared_inboxes: boolean;
  default_timezone: string;
  send_window_start_hour: number;
  send_window_end_hour: number;
  ramp_start_per_day: number;
  ramp_step_per_business_day: number;
  catch_all_max_share: number;
  verification_max_age_days: number;
  bounce_pause_rate: number;
  bounce_window_sends: number;
  bounce_min_sends: number;
  out_of_office_hold_business_days: number;
}

export interface Inbox {
  id: string;
  email: string;
  sender_name: string;
  signature: string;
  status: "active" | "paused" | "disconnected";
  paused_reason: string | null;
  cold_start_date: string | null;
  max_daily: number;
  refresh_token_enc: string | null;
  last_synced_at: string | null;
  last_sent_at: string | null;
  next_send_after: string | null;
}

export interface Company {
  id: string;
  name: string;
  domain: string | null;
  state: string | null;
  status: "active" | "replied" | "do_not_contact";
  facts: Record<string, string>;
}

export interface Contact {
  id: string;
  company_id: string | null;
  email: string;
  first_name: string;
  last_name: string;
  title: string;
  timezone: string | null;
  fields: Record<string, string>;
  verification_status: VerificationStatus;
  verified_at: string | null;
}

export interface SequenceStep {
  step_number: number;
  delay_business_days: number;
  subject_a: string | null;
  subject_b: string | null;
  body: string;
}

export type StopReason =
  | "replied"
  | "company_replied"
  | "unsubscribed"
  | "bounced"
  | "suppressed"
  | "verification_failed"
  | "missing_field"
  | "company_do_not_contact"
  | "manual";

export interface Enrollment {
  id: string;
  sequence_id: string;
  contact_id: string;
  inbox_id: string;
  status: "active" | "completed" | "stopped";
  stop_reason: string | null;
  next_step: number;
  next_send_at: string;
  subject_variant: "a" | "b";
  thread_subject: string | null;
  gmail_thread_id: string | null;
  last_rfc_message_id: string | null;
}

/** An enrollment that is due, with everything needed to decide and send. */
export interface DueItem {
  enrollment: Enrollment;
  contact: Contact;
  company: Company | null;
  sequenceStatus: "draft" | "active" | "paused";
  steps: SequenceStep[];
}

export type InboundKind = "reply" | "auto_reply" | "bounce" | "unsubscribe_reply" | "other";
