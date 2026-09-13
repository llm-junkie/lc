import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  parseProviderContractRegistry,
  resolveProviderContract,
} from '../src/modules/llm-client/provider-contracts.ts';

const sourcePath = resolve('src/modules/llm-client/provider-contracts.v1.json');
const publicPath = resolve('public/provider-contracts.v1.json');
if (existsSync(publicPath)) {
  throw new Error('provider contracts must be embedded from src, not shipped as a public runtime asset');
}
const registry = parseProviderContractRegistry(JSON.parse(readFileSync(sourcePath, 'utf8')) as unknown);

for (const contract of registry.contracts) {
  for (const origin of contract.match.origins) {
    for (const prefix of contract.match.base_path_prefixes) {
      const baseUrl = `${origin}${prefix}`;
      const resolved = resolveProviderContract(registry, {
        baseUrl,
        protocol: contract.protocol,
        modelId: contract.models?.[0]?.id,
      });
      if (resolved?.contract.id !== contract.id) {
        throw new Error(
          `${contract.id}: ${baseUrl} / ${contract.protocol} resolves to `
          + `${resolved?.contract.id ?? 'nothing'}`,
        );
      }
    }
  }
}

const verified = registry.contracts.filter((contract) => contract.status === 'verified').length;
const partial = registry.contracts.length - verified;
console.log(
  `provider-contracts: clean — ${registry.contracts.length} contracts, `
  + `${verified} verified, ${partial} explicitly partial, ${registry.sources.length} evidence sources`,
);
