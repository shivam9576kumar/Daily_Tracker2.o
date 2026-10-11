// KEEP IN SYNC with the mirrored file in backend/src/utils/platform.ts.
const PLATFORM_HOST_MAP: [string, string, string][] = [
  // [hostname fragment, platform value, display label]
  ['cses.fi', 'cses', 'CSES'],
  ['leetcode.com', 'leetcode', 'LeetCode'],
  ['geeksforgeeks.org', 'gfg', 'GFG'],
  ['interviewbit.com', 'interviewbit', 'InterviewBit'],
  ['codingninjas.com', 'codingninjas', 'Coding Ninjas'],
  ['naukri.com/code360', 'codingninjas', 'Coding Ninjas'],
  ['codeforces.com', 'codeforces', 'Codeforces'],
  ['hackerrank.com', 'hackerrank', 'HackerRank'],
  ['codechef.com', 'codechef', 'CodeChef'],
  ['takeuforward.org', 'striver', 'Striver (takeuforward)'],
  ['striver', 'striver', 'Striver (takeuforward)'],
  ['spoj.com', 'spoj', 'SPOJ'],
];

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/** Derive { value, label } from a URL. Returns null if URL is missing/unrecognized. */
export function platformFromUrl(url?: string | null): { value: string; label: string } | null {
  if (!url) return null;
  const lower = url.toLowerCase();
  for (const [fragment, value, label] of PLATFORM_HOST_MAP) {
    if (lower.includes(fragment)) return { value, label };
  }
  return null;
}

/**
 * Single source of truth for display: URL first, stored platform as fallback.
 * Use this EVERYWHERE a platform name is shown.
 */
export function resolvePlatform(
  problemUrl?: string | null,
  platform?: string | null,
): { value: string; label: string } | null {
  const fromUrl = platformFromUrl(problemUrl);
  if (fromUrl) return fromUrl;
  if (!platform) return null;
  return { value: platform, label: platform === 'custom' ? 'Custom' : titleCase(platform) };
}
