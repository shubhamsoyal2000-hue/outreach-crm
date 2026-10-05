import "server-only";
import { env } from "../config";
import { gmailMailer } from "../gmail";
import { unsubscribeUrl } from "../unsubscribe";
import { makeVerifier } from "../verify";
import type { EngineDeps } from "./ports";

export function productionDeps(): EngineDeps {
  return {
    mailer: gmailMailer,
    verifier: makeVerifier(env.verifier, env.verifierApiKey),
    unsubscribeUrl,
    now: () => new Date(),
    rng: Math.random,
  };
}
