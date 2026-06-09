import type { Integration } from './types';
const registry = new Map<string, Integration>();
export function registerIntegration(i: Integration): void { registry.set(i.type, i); }
export function getIntegration(type: string): Integration | undefined { return registry.get(type); }
export function listIntegrations(): Integration[] { return [...registry.values()]; }
