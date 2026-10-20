/**
 * Checks that the (enabled) endpoints from the rpc/<chain-id>.json files are reachable and expose the required RPC methods.
 *
 * Usage: node src/check-endpoints.ts [options]
 *   --changed-since <ref>  only check the endpoints that are new (or newly enabled) compared to the git ref
 *   --report <path>        write a markdown report of the failing endpoints to the path
 */

import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { checkEndpointWithRetries } from './check-endpoint.ts';
import type { RpcEndpoint } from './schema.ts';
import { RpcEndpointsSchema } from './schema.ts';
import type { RpcFile } from './utils.ts';
import { readRpcFiles, readRpcFilesAt } from './utils.ts';

interface Failure {
  entry: RpcEndpoint;
  file: string;
  reason: string;
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
  return new Map(files.map(({ content, file }) => [file, RpcEndpointsSchema.parse(content)]));
}

/**
 * The enabled endpoints of the given files
 */
function getEnabled(files: Map<string, RpcEndpoint[]>): { entry: RpcEndpoint; file: string }[] {
  return [...files].flatMap(([file, entries]) =>
    entries.filter(({ disabled }) => !disabled).map((entry) => ({ entry, file }))
  );
}

function formatReport(failures: Failure[]): string {
  return [
    `The following endpoints failed the check (${new Date().toISOString().slice(0, 10)}).`,
    'An endpoint can also be temporarily unavailable, so double-check before disabling it.',
    '',
    '| File | Name | RPC | Reason |',
    '| ---- | ---- | --- | ------ |',
    ...failures.map(
      ({ entry: { name, rpc }, file, reason }) => `| ${file} | ${name} | ${rpc} | ${reason.replaceAll('|', '\\|')} |`
    ),
    ''
  ].join('\n');
}

async function main(): Promise<void> {
  const files = parseRpcFiles(readRpcFiles());
  const toKey = ({ entry, file }: { entry: RpcEndpoint; file: string }): string => `${file} ${entry.rpc}`;
  const baseKeys = new Set(
    args['changed-since'] ? getEnabled(parseRpcFiles(readRpcFilesAt(args['changed-since']))).map(toKey) : []
  );
  const toCheck = getEnabled(files).filter((item) => !baseKeys.has(toKey(item)));

  if (!toCheck.length) {
    console.log('No endpoints to check');

    return;
  }

  const failures: Failure[] = [];

  await Promise.all(
    toCheck.map(async ({ entry, file }): Promise<void> => {
      try {
        await checkEndpointWithRetries(entry.rpc, REQUIRED_METHODS[file.replace(/\.json$/, '')] ?? []);
        console.log(`✔ ${file} (${entry.name}) @ ${entry.rpc}`);
      } catch (error) {
        const reason = (error as Error).message;

        console.log(`✖ ${file} (${entry.name}) @ ${entry.rpc}\n    ${reason}`);
        failures.push({ entry, file, reason });
      }
    })
  );

  console.log(`\n${toCheck.length - failures.length}/${toCheck.length} endpoints ok`);

  if (failures.length) {
    args.report && fs.writeFileSync(args.report, formatReport(failures));
    process.exitCode = 1;
  }
}

await main();
