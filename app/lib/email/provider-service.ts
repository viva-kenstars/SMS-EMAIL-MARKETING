/** All API and worker imports use the same provider router. */
import { env } from "cloudflare:workers";
import { handleEmailApi as legacyApi, advanceEmailQueue as legacyQueue } from "./service.ts";
import { createVerificationRouter } from "./provider-router.ts";
export { EmailServiceError } from "./service.ts";
const router = createVerificationRouter({
  legacyApi, legacyQueue,
  connection: () => {
    const e = env as unknown as Record<string, string | undefined>;
    return { url: e.SENDZAD_VERIFIER_URL || "", token: e.SENDZAD_VERIFIER_TOKEN || "" };
  },
});
export const handleEmailApi = router.handleEmailApi;
export const advanceEmailQueue = router.advanceEmailQueue;
