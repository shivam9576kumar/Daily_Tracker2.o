export function requireDisposableDb(): void {
  if (process.env.ALLOW_TEST_DB_WRITES !== '1') {
    throw new Error('Refusing to run: set ALLOW_TEST_DB_WRITES=1 and point DATABASE_URL at a disposable database.');
  }
  const url = new URL(process.env.DATABASE_URL ?? '');
  if (!['localhost', '127.0.0.1'].includes(url.hostname)) {
    throw new Error(`Refusing to run: DATABASE_URL host "${url.hostname}" is not local.`);
  }
}
