declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    TERMII_API_KEY?: string;
    TERMII_BASE_URL?: string;
    SMS_LIVE_ENABLED?: string;
    SMS_SETTINGS_ENCRYPTION_KEY?: string;
    EMAIL_WORKER_TOKEN_SHA256?: string;
    APP_ORIGIN?: string;
  }
}
