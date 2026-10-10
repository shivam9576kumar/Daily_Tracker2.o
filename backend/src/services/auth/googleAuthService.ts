import { googleOAuthConfig } from '../../config/googleOAuth';
import prisma from '../../config/database';
import logger from '../../utils/logger';

export interface GoogleUserInfo {
  sub: string;      // Google ID
  email: string;
  name: string;
  picture: string;
}

/**
 * Build the Google OAuth consent screen URL.
 */
export function getGoogleAuthUrl(customRedirectUri?: string): string {
  const redirect_uri = customRedirectUri || googleOAuthConfig.callbackUrl;
  const params = new URLSearchParams({
    client_id: googleOAuthConfig.clientId,
    redirect_uri,
    response_type: 'code',
    scope: googleOAuthConfig.scopes.join(' '),
    access_type: 'offline',
    prompt: 'consent',
  });
  return `${googleOAuthConfig.authUrl}?${params.toString()}`;
}

/**
 * Exchange the authorization code for tokens, then fetch user info.
 */
export async function handleGoogleCallback(code: string, customRedirectUri?: string) {
  const redirect_uri = customRedirectUri || googleOAuthConfig.callbackUrl;
  // 1. Exchange code for tokens
  const tokenResponse = await fetch(googleOAuthConfig.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: googleOAuthConfig.clientId,
      client_secret: googleOAuthConfig.clientSecret,
      redirect_uri,
      grant_type: 'authorization_code',
    }),
  });

  if (!tokenResponse.ok) {
    const errorText = await tokenResponse.text();
    logger.error('Google token exchange failed:', errorText);
    throw new Error('Failed to exchange authorization code');
  }

  const tokens = (await tokenResponse.json()) as { access_token: string };

  // 2. Fetch user info
  const userInfoResponse = await fetch(googleOAuthConfig.userInfoUrl, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });

  if (!userInfoResponse.ok) {
    throw new Error('Failed to fetch Google user info');
  }

  const googleUser = (await userInfoResponse.json()) as GoogleUserInfo;

  // 3. Find or create user in database
  const user = await findOrCreateUser(googleUser);

  return user;
}

/**
 * Upsert: find existing user by Google ID or create a new one.
 */
export async function findOrCreateUser(googleUser: GoogleUserInfo) {
  const existing = await prisma.user.findUnique({ where: { googleId: googleUser.sub } });

  if (existing) {
    try {
      return await prisma.user.update({
        where: { id: existing.id },
        data: {
          name: googleUser.name,
          email: googleUser.email,
          avatarUrl: googleUser.picture,
        },
      });
    } catch (err: any) {
      if (err?.code === 'P2002') {
        // A different account already owns this email (e.g. the user
        // changed their Google account's email to one already present
        // in our system under a different googleId). This only affects
        // a cosmetic profile-refresh field — do not block login over it.
        logger.warn('findOrCreateUser: email conflict on profile refresh, keeping existing email', {
          userId: existing.id,
          attemptedEmail: googleUser.email,
        });
        return existing;
      }
      throw err;
    }
  }

  logger.info(`Creating new user: ${googleUser.email}`);
  try {
    return await prisma.user.create({
      data: {
        googleId: googleUser.sub,
        email: googleUser.email,
        name: googleUser.name,
        avatarUrl: googleUser.picture,
        coins: 0,
      },
    });
  } catch (err: any) {
    if (err?.code === 'P2002') {
      // Concurrent first-time sign-in race: another request created
      // this user between our findUnique and create calls.
      const race = await prisma.user.findUnique({ where: { googleId: googleUser.sub } });
      if (race) return race;
    }
    throw err;
  }
}
