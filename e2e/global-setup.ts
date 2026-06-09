import { rm } from 'node:fs/promises';

export default async function globalSetup() {
  await rm('./data/e2e.sqlite', { force: true });
}
