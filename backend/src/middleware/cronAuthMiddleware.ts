import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env';

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Protects scheduled-maintenance endpoints.
 * Vercel Cron and external schedulers send `Authorization: Bearer <CRON_SECRET>`.
 *  - CRON_SECRET unset   → 503 (endpoint disabled, never open)
 *  - wrong/missing token → 401
 */
export function requireCronSecret(
  getSecret: () => string | undefined = () => env.CRON_SECRET || undefined,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const secret = getSecret();
    if (!secret) {
      res.status(503).json({ success: false, error: 'CRON_SECRET is not configured' });
      return;
    }
    const header = req.headers.authorization ?? '';
    if (!safeEqual(header, `Bearer ${secret}`)) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }
    next();
  };
}
