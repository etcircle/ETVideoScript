import type { MediaProvider } from './contract';

const providers = new Map<string, MediaProvider<any, any>>();

export function registerProvider<P extends MediaProvider<any, any>>(provider: P): P {
  if (!provider.id.includes('.')) throw new Error(`Provider id must be <kind>.<name>: ${provider.id}`);
  if (provider.id.split('.')[0] !== provider.kind) throw new Error(`Provider id/kind mismatch for ${provider.id}`);
  providers.set(provider.id, provider as MediaProvider<any, any>);
  return provider;
}

export function getProvider<Input = unknown, Output = unknown>(id: string): MediaProvider<Input, Output> | undefined {
  return providers.get(id) as MediaProvider<Input, Output> | undefined;
}

export function listProviders(): MediaProvider<any, any>[] {
  return Array.from(providers.values()).sort((a, b) => a.id.localeCompare(b.id));
}

export function providerKinds(): string[] {
  return Array.from(new Set(listProviders().map((provider) => provider.kind))).sort();
}
