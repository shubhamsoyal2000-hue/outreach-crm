import "server-only";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}. See .env.example.`);
  return v;
}

export const env = {
  get supabaseUrl() { return required("SUPABASE_URL"); },
  get supabaseServiceKey() { return required("SUPABASE_SERVICE_ROLE_KEY"); },
  get appUrl() { return required("APP_URL").replace(/\/$/, ""); },
  get appPassword() { return required("APP_PASSWORD"); },
  get sessionSecret() { return required("SESSION_SECRET"); },
  get encryptionKey() { return required("ENCRYPTION_KEY"); },
  /** Optional: the scheduler secret normally lives in Supabase Vault (see scheduler.sql). */
  get cronSecret() { return process.env.CRON_SECRET; },
  get googleClientId() { return required("GOOGLE_CLIENT_ID"); },
  get googleClientSecret() { return required("GOOGLE_CLIENT_SECRET"); },
  get verifier() { return process.env.VERIFIER; },
  get verifierApiKey() { return process.env.VERIFIER_API_KEY; },
};
