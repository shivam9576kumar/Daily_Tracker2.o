import dotenv from 'dotenv';
import path from 'path';

// Load .env from backend and project root
dotenv.config();
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

function validateTimezone(tz: string): string {
  if (!tz || tz.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(tz)) {
    throw new Error('DEFAULT_TIMEZONE must be a valid IANA timezone');
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    throw new Error('DEFAULT_TIMEZONE must be a valid IANA timezone');
  }
}

const defaultTimezone = validateTimezone(process.env.DEFAULT_TIMEZONE || 'Asia/Kolkata');

const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';

export const env = {
  // Server
  PORT: parseInt(process.env.PORT || '3001', 10),
  NODE_ENV,

  // Database
  DATABASE_URL: process.env.DATABASE_URL || '',

  // JWT
  JWT_SECRET: process.env.JWT_SECRET || (IS_PROD ? '' : 'dev-secret-change-me'),
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '7d',

  // Google OAuth
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || '',
  GOOGLE_CALLBACK_URL:
    process.env.GOOGLE_CALLBACK_URL ||
    'http://localhost:3001/api/auth/google/callback',

  // Gemini AI
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
  // No hardcoded default: the operator must choose a model that ListModels reports.
  GEMINI_MODEL: (process.env.GEMINI_MODEL || '').trim(),
  // Fallbacks are opt-in only. Empty by default.
  GEMINI_MODEL_FALLBACKS: (process.env.GEMINI_MODEL_FALLBACKS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // CORS
  FRONTEND_URL: process.env.FRONTEND_URL || 'http://localhost:5173',

  // Timezone used when the client does not send X-Timezone
  DEFAULT_TIMEZONE: defaultTimezone,

  // Helpers
  isDev: NODE_ENV === 'development',
  isProd: IS_PROD,

  // Scheduled maintenance endpoint (/api/cron/daily). Required to use that endpoint.
  CRON_SECRET: process.env.CRON_SECRET || '',
} as const;

/**
 * Fails loudly at startup if a production deployment is still using the
 * localhost default — this previously failed silently, producing a
 * confusing browser-side CORS error for real users instead of an
 * obvious deployment misconfiguration at boot time.
 */
export function assertProductionConfig(e: typeof env = env): void {
  if (process.env.VERCEL) return;
  const firstOrigin = e.FRONTEND_URL.split(',')[0]?.trim();
  if (e.isProd && firstOrigin === 'http://localhost:5173') {
    throw new Error(
      'FRONTEND_URL is not configured for production (still the localhost default). ' +
      'Set FRONTEND_URL to your deployed frontend origin(s) before starting in production.'
    );
  }
}

const WEAK_JWT_SECRETS = new Set(['', 'dev-secret-change-me', 'changeme']);

/**
 * Refuses to start in production with secrets that are missing or known-weak.
 * Separate from assertProductionConfig so Bug 6's FRONTEND_URL test is unaffected.
 */
export function assertProductionSecrets(e: typeof env = env): void {
  if (!e.isProd) return;

  const problems: string[] = [];
  if (!e.DATABASE_URL) {
    problems.push('DATABASE_URL is required');
  }
  if (WEAK_JWT_SECRETS.has(e.JWT_SECRET) || e.JWT_SECRET.length < 32) {
    problems.push('JWT_SECRET must be set to a random value of at least 32 characters');
  }
  if (problems.length > 0) {
    throw new Error(
      'Refusing to start in production:\n - ' + problems.join('\n - ')
    );
  }
}

