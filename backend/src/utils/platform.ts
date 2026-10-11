// KEEP IN SYNC with the mirrored file in frontend/src/utils/platform.ts.
import logger from './logger';
import { env } from '../config/env';

const PLATFORM_HOST_MAP: [string, string][] = [
  ['cses.fi', 'cses'],
  ['leetcode.com', 'leetcode'],
  ['geeksforgeeks.org', 'gfg'],
  ['interviewbit.com', 'interviewbit'],
  ['codingninjas.com', 'codingninjas'],
  ['naukri.com/code360', 'codingninjas'],
  ['codeforces.com', 'codeforces'],
  ['hackerrank.com', 'hackerrank'],
  ['codechef.com', 'codechef'],
  ['takeuforward.org', 'striver'],
  ['striver', 'striver'],
  ['spoj.com', 'spoj'],
];

export function platformFromUrl(url?: string | null): string | null {
  if (!url) return null;
  const lower = url.toLowerCase();
  for (const [fragment, value] of PLATFORM_HOST_MAP) {
    if (lower.includes(fragment)) return value;
  }
  if (env.NODE_ENV === 'development' || env.NODE_ENV === 'test') {
    logger.warn(`Unmapped problem URL host: ${url}`);
  }
  return null;
}

/** URL-derived platform wins; explicit value is fallback. */
export function resolvePlatformValue(
  problemUrl?: string | null,
  explicit?: string | null,
): string {
  return platformFromUrl(problemUrl) ?? explicit ?? 'custom';
}
