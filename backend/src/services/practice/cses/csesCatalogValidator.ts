export interface CsesProblemInput { id: string; order: number; title: string; url: string }
export interface CsesTopicInput { slug: string; title: string; order: number; problems: CsesProblemInput[] }
export interface CsesCatalogFile { source: string; version: number; topics: CsesTopicInput[] }

export interface CatalogValidation {
  errors: string[];
  counts: { topics: number; problems: number };
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ID_RE = /^cses-(\d+)$/;
const URL_RE = /^https:\/\/cses\.fi\/problemset\/task\/(\d+)$/;
const MAX_TITLE = 200;

/**
 * Pure. Never throws. Collects every error so one run reports all of them.
 * `expectedSource` lets tests validate a fixture under another source label.
 */
export function validateCsesCatalog(input: unknown, expectedSource = 'cses'): CatalogValidation {
  const errors: string[] = [];
  const counts = { topics: 0, problems: 0 };

  if (typeof input !== 'object' || input === null) {
    return { errors: ['file root must be an object'], counts };
  }
  const file = input as Partial<CsesCatalogFile>;
  if (file.source !== expectedSource) errors.push(`source must be "${expectedSource}"`);
  if (file.version !== 1) errors.push('version must be 1');
  if (!Array.isArray(file.topics) || file.topics.length === 0) {
    errors.push('topics must be a non-empty array');
    return { errors, counts };
  }

  const slugs = new Set<string>();
  const topicOrders = new Set<number>();
  const problemIds = new Set<string>();
  const urls = new Set<string>();

  file.topics.forEach((t, ti) => {
    const where = `topics[${ti}]`;
    counts.topics++;

    if (typeof t.slug !== 'string' || !SLUG_RE.test(t.slug)) errors.push(`${where}.slug invalid: ${String(t.slug)}`);
    else if (slugs.has(t.slug)) errors.push(`${where}.slug duplicated: ${t.slug}`);
    else slugs.add(t.slug);

    if (typeof t.title !== 'string' || !t.title.trim()) errors.push(`${where}.title is blank`);

    if (!Number.isInteger(t.order) || t.order < 1) errors.push(`${where}.order must be a positive integer`);
    else if (topicOrders.has(t.order)) errors.push(`${where}.order duplicated: ${t.order}`);
    else topicOrders.add(t.order);

    if (!Array.isArray(t.problems) || t.problems.length === 0) {
      errors.push(`${where}.problems must be a non-empty array`);
      return;
    }

    t.problems.forEach((p, pi) => {
      const pw = `${where}.problems[${pi}]`;
      counts.problems++;

      const idMatch = typeof p.id === 'string' ? ID_RE.exec(p.id) : null;
      if (!idMatch) errors.push(`${pw}.id must look like cses-<number>: ${String(p.id)}`);
      else if (problemIds.has(p.id)) errors.push(`${pw}.id duplicated: ${p.id}`);
      else problemIds.add(p.id);

      if (typeof p.title !== 'string' || !p.title.trim()) errors.push(`${pw}.title is blank`);
      else if (p.title.trim().length > MAX_TITLE) errors.push(`${pw}.title longer than ${MAX_TITLE}`);

      const urlMatch = typeof p.url === 'string' ? URL_RE.exec(p.url) : null;
      if (!urlMatch) {
        errors.push(`${pw}.url must match https://cses.fi/problemset/task/<number>: ${String(p.url)}`);
      } else {
        if (urls.has(p.url)) errors.push(`${pw}.url duplicated: ${p.url}`);
        else urls.add(p.url);
        if (idMatch && idMatch[1] !== urlMatch[1]) {
          errors.push(`${pw}: id ${p.id} does not match url number ${urlMatch[1]}`);
        }
      }

      if (p.order !== pi + 1) errors.push(`${pw}.order must be ${pi + 1}, found ${String(p.order)}`);
    });
  });

  return { errors, counts };
}
