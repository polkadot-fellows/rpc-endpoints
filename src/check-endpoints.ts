/**
 * Checks that the (enabled) endpoints from the rpc/<chain-id>.json files are reachable and expose the required RPC methods.
 * Their nodes being reachable over WebRTC is only checked as a warning, which doesn't fail the check.
 *
 * Usage: node src/check-endpoints.ts [options]
 *   --changed-since <ref>  only check the endpoints that are new (or newly enabled) compared to the git ref
 *   --report <path>        write a markdown report of the failing endpoints and of the warnings to the path
 */

import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { checkEndpointWithRetries } from './check-endpoint.ts';
import type { RpcEndpoint } from './schema.ts';
import { RpcEndpointsSchema } from './schema.ts';
import type { RpcFile } from './utils.ts';
import { readRpcFiles, readRpcFilesAt } from './utils.ts';

class ChainEndpoint {
  chain: string;
  entry: RpcEndpoint;

  constructor(chain: string, entry: RpcEndpoint) {
    this.chain = chain;
    this.entry = entry;
  }

  /**
   * Orders the endpoints by chain, then by name
   */
  static compare(a: ChainEndpoint, b: ChainEndpoint): number {
    return a.chain.localeCompare(b.chain) || a.entry.name.localeCompare(b.entry.name);
  }
}

/**
 * A failure or a warning of an endpoint
 */
class Issue extends ChainEndpoint {
  message: string;

  constructor(chain: string, entry: RpcEndpoint, message: string) {
    super(chain, entry);
    this.message = message;
  }
}

/**
 * The RPC methods that the endpoints of a chain must expose, by chain id
 */
const REQUIRED_METHODS: Record<string, string[]> = {
  'bulletin-polkadot': ['bitswap_v1_get'],
  'people-polkadot': ['statement_submit', 'statement_subscribeStatement', 'statement_unsubscribeStatement']
};

const { values: args } = parseArgs({
  options: {
    'changed-since': { type: 'string' },
    report: { type: 'string' }
  }
});

/**
 * Validates the files, throwing (with the reason) on an invalid one, see test/validate.test.ts
 */
function parseRpcFiles(files: RpcFile[]): Map<string, RpcEndpoint[]> {
  return new Map(files.map(({ chain, content }) => [chain, RpcEndpointsSchema.parse(content)]));
}

function getEnabled(entries: RpcEndpoint[]): RpcEndpoint[] {
  return entries.filter(({ disabled }) => !disabled);
}

function formatRow({ chain, entry: { name, rpc }, message }: Issue): string {
  return `| ${chain} | ${name} | ${rpc} | ${message.replaceAll('|', '\\|')} |`;
}

function formatReport(failures: Issue[], warnings: Issue[]): string {
  return [
    `RPC endpoints check (${new Date().toISOString().slice(0, 10)}).`,
    ...(failures.length
      ? [
          '',
          '## Failing endpoints',
          '',
          'An endpoint can also be temporarily unavailable, so double-check before disabling it.',
          '',
          '| Chain | Name | RPC | Reason |',
          '| ----- | ---- | --- | ------ |',
          ...failures.map(formatRow)
        ]
      : []),
    ...(warnings.length
      ? [
          '',
          '## Warnings',
          '',
          "These don't fail the check.",
          '',
          '| Chain | Name | RPC | Warning |',
          '| ----- | ---- | --- | ------- |',
          ...warnings.map(formatRow)
        ]
      : []),
    ''
  ].join('\n');
}

async function main(): Promise<void> {
  const chains = parseRpcFiles(readRpcFiles());
  const existingChains = args['changed-since']
    ? parseRpcFiles(readRpcFilesAt(args['changed-since']))
    : new Map<string, RpcEndpoint[]>();
  const failures: Issue[] = [];
  const warnings: Issue[] = [];
  let checked = 0;

  const check = async (chain: string, entry: RpcEndpoint): Promise<void> => {
    try {
      const endpointWarnings = await checkEndpointWithRetries(entry.rpc, REQUIRED_METHODS[chain] ?? []);

      console.log(`  ✔ ${entry.name} @ ${entry.rpc}`);

      for (const message of endpointWarnings) {
        console.log(`  ⚠ ${entry.name} @ ${entry.rpc}\n      ${message}`);
        warnings.push(new Issue(chain, entry, message));
      }
    } catch (error) {
      const { message } = error as Error;

      console.log(`  ✖ ${entry.name} @ ${entry.rpc}\n      ${message}`);
      failures.push(new Issue(chain, entry, message));
    }
  };

  // one chain at a time, the endpoints of a chain in parallel
  for (const [chain, entries] of chains) {
    const existingEndpoints = new Set(getEnabled(existingChains.get(chain) ?? []).map(({ rpc }) => rpc));
    const toCheck = getEnabled(entries).filter(({ rpc }) => !existingEndpoints.has(rpc));

    if (!toCheck.length) {
      continue;
    }

    console.log(chain);
    await Promise.all(toCheck.map((entry) => check(chain, entry)));
    console.log('');
    checked += toCheck.length;
  }

  if (!checked) {
    console.log('No endpoints to check');

    return;
  }

  console.log(
    `${checked - failures.length}/${checked} endpoints ok, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}`
  );

  if ((failures.length || warnings.length) && args.report) {
    // sorted, as the endpoints of a chain complete in any order
    fs.writeFileSync(
      args.report,
      formatReport(failures.sort(ChainEndpoint.compare), warnings.sort(ChainEndpoint.compare))
    );
  }

  // the warnings don't fail the check
  if (failures.length) {
    process.exitCode = 1;
  }
}

await main();
