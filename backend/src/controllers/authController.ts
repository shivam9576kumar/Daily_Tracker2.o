import { Request, Response, NextFunction } from 'express';
import {
  getGoogleAuthUrl,
  handleGoogleCallback,
} from '../services/auth/googleAuthService';
import { generateToken } from '../services/auth/jwtService';
import { getAuthUser } from '../middleware/authMiddleware';
import { sendSuccess, sendError } from '../utils/response';
import { UnauthorizedError } from '../utils/error';
import { env } from '../config/env';
import logger from '../utils/logger';
import { prisma } from '../config/database';
import { createExchangeCode, consumeExchangeCode } from '../services/auth/exchangeCodeService';

function resolveRedirectUri(req: Request): string {
  if (env.GOOGLE_CALLBACK_URL && !env.GOOGLE_CALLBACK_URL.includes('localhost')) {
    return env.GOOGLE_CALLBACK_URL;
  }
  const host = req.get('x-forwarded-host') || req.get('host');
  const proto = req.get('x-forwarded-proto') || (req.secure ? 'https' : 'http');
  if (host && !host.includes('localhost')) {
    return `${proto}://${host}/api/auth/google/callback`;
  }
  return env.GOOGLE_CALLBACK_URL;
}

/**
 * GET /api/auth/google
 * Redirects to Google's OAuth consent screen.
 */
export function googleLogin(req: Request, res: Response) {
  if (!env.GOOGLE_CLIENT_ID) {
    return res.status(400).send(`
      <h2>Google OAuth Client ID not configured on server.</h2>
      <p>Please return to the login page and use <strong>Continue as Guest / Demo</strong>, or configure <code>GOOGLE_CLIENT_ID</code> in Vercel environment variables.</p>
    `);
  }
  const redirectUri = resolveRedirectUri(req);
  const url = getGoogleAuthUrl(redirectUri);
  res.redirect(url);
}

/**
 * POST /api/auth/demo
 * Creates or retrieves a demo student account and returns a JWT token.
 */
export async function demoLogin(_req: Request, res: Response, next: NextFunction) {
  try {
    const DEMO_GOOGLE_ID = 'demo-student-id';
    const DEMO_EMAIL = 'demo@dsatracker.com';

    let user = await prisma.user.findUnique({ where: { googleId: DEMO_GOOGLE_ID } });

    if (!user) {
      try {
        user = await prisma.user.create({
          data: {
            googleId: DEMO_GOOGLE_ID,
            email: DEMO_EMAIL,
            name: 'Demo Student',
            coins: 100,
          },
        });
      } catch (err: any) {
        if (err?.code === 'P2002') {
          user = await prisma.user.findUnique({ where: { googleId: DEMO_GOOGLE_ID } });
        }
        if (!user) throw err;
      }
    }

    const token = generateToken({ userId: user.id, email: user.email });
    logger.info(`Demo user logged in: ${user.email}`);

    sendSuccess(res, {
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl,
        coins: user.coins,
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/auth/google/callback
 * Handles the OAuth callback, exchanges code, creates user, returns exchange code.
 */
export async function googleCallback(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const { code } = req.query;

    if (!code || typeof code !== 'string') {
      return sendError(res, 'Missing authorization code', 400);
    }

    const redirectUri = resolveRedirectUri(req);
    const user = await handleGoogleCallback(code, redirectUri);
    const token = generateToken({ userId: user.id, email: user.email });

    logger.info(`User logged in: ${user.email}`);

    // The real JWT never appears in the URL, browser history, referrer
    // headers, or server access logs — only this short-lived, single-use
    // opaque code does. See Bug 6 for the full rationale.
    const exchangeCode = createExchangeCode(token);

    const proto = req.get('x-forwarded-proto') || (req.secure ? 'https' : 'http');
    const host = req.get('x-forwarded-host') || req.get('host');
    const hostOrigin = host ? `${proto}://${host}` : `${req.protocol}://${req.get('host')}`;
    const baseUrl = (env.FRONTEND_URL && !env.FRONTEND_URL.includes('localhost'))
      ? env.FRONTEND_URL
      : hostOrigin;

    res.redirect(`${baseUrl}/auth/callback?code=${exchangeCode}`);
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/auth/exchange
 * Trades a short-lived, single-use code (received via the OAuth
 * callback redirect) for the real JWT, over a JSON POST body instead
 * of a URL query string.
 */
export async function exchangeAuthCode(req: Request, res: Response, next: NextFunction) {
  try {
    const { code } = req.body ?? {};
    if (!code || typeof code !== 'string') {
      return sendError(res, 'Missing exchange code', 400);
    }
    const token = consumeExchangeCode(code);
    if (!token) {
      return sendError(res, 'Exchange code is invalid or expired', 400);
    }
    sendSuccess(res, { token });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/auth/me
 * Returns the current authenticated user's profile with fresh data from DB.
 */
export async function getMe(req: Request, res: Response, next: NextFunction) {
  try {
    const authUser = getAuthUser(req); // identity/ownership check only
    const fresh = await prisma.user.findUnique({
      where: { id: authUser.id },
      select: { id: true, email: true, name: true, avatarUrl: true, coins: true },
    });
    if (!fresh) throw new UnauthorizedError('User not found');
    sendSuccess(res, fresh);
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/auth/logout
 * Client-side logout — just acknowledges the request.
 * Token invalidation happens on the client by removing the stored token.
 */
export function logout(_req: Request, res: Response) {
  sendSuccess(res, { message: 'Logged out successfully' });
}

