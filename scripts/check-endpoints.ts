/**
 * Checks that the (enabled) endpoints from the rpc/<chain-id>.json files are reachable.
 *
 * Usage: node scripts/check-endpoints.ts [options]
 *   --changed-since <ref>  only check the endpoints that are new (or newly enabled) compared to the git ref
 *   --disable-failing      mark the failing endpoints as disabled (with the reason) instead of failing
 *   --report <path>        write a markdown report of the failing endpoints to the path
 */

import type { RpcFile } from '../src/files.ts';
import type { RpcEndpoint } from '../src/schema.ts';

import fs from 'node:fs';
import { parseArgs } from 'node:util';

import { checkWithRetries } from '../src/check.ts';
import { readRpcFiles, readRpcFilesAt, writeRpcFile } from '../src/files.ts';
import { RpcEndpointsSchema } from '../src/schema.ts';

interface Failure {
  entry: RpcEndpoint;
  file: string;
  reason: string;
}

const { values: args } = parseArgs({
  options: {
    'changed-since': { type: 'string' },
    'disable-failing': { type: 'boolean' },
    report: { type: 'string' }
  }
});

/**
 * Validates the files, throwing (with the reason) on an invalid one, see test/validate.test.ts.
 * Returns the original objects (not the parsed copies), to keep the key order when writing them back
 */
function parseRpcFiles (files: RpcFile[]): Map<string, RpcEndpoint[]> {
  return new Map(files.map(({ content, file }) => {
    RpcEndpointsSchema.parse(content);

    return [file, content as RpcEndpoint[]];
  }));
}

/**
 * The enabled endpoints of the given files, as `<file> <rpc>` keys
 */
function getEnabledKeys (files: Map<string, RpcEndpoint[]>): Set<string> {
  return new Set(
    [...files].flatMap(([file, entries]) =>
      entries
        .filter(({ disabled }) => !disabled)
        .map(({ rpc }) => `${file} ${rpc}`)
    )
  );
}

function formatReport (failures: Failure[]): string {
  return [
    `The following endpoints failed the check (${new Date().toISOString().slice(0, 10)}) and have been disabled.`,
    'Please double-check before merging, an endpoint can also be temporarily unavailable.',
    '',
    '| File | Name | RPC | Reason |',
    '| ---- | ---- | --- | ------ |',
    ...failures.map(({ entry: { name, rpc }, file, reason }) =>
      `| ${file} | ${name} | ${rpc} | ${reason.replaceAll('|', '\\|')} |`
    ),
    ''
  ].join('\n');
}

async function main (): Promise<void> {
  const files = parseRpcFiles(readRpcFiles());
  const baseKeys = args['changed-since']
    ? getEnabledKeys(parseRpcFiles(readRpcFilesAt(args['changed-since'])))
    : new Set<string>();
  const toCheck = [...files].flatMap(([file, entries]) =>
    entries
      .filter(({ disabled, rpc }) => !disabled && !baseKeys.has(`${file} ${rpc}`))
      .map((entry) => ({ entry, file }))
  );

  if (!toCheck.length) {
    console.log('No endpoints to check');

    return;
  }

  const failures: Failure[] = [];

  await Promise.all(toCheck.map(async ({ entry, file }): Promise<void> => {
    try {
      await checkWithRetries({ name: entry.name, ws: entry.rpc });
      console.log(`✔ ${file} (${entry.name}) @ ${entry.rpc}`);
    } catch (error) {
      const reason = (error as Error).message;

      console.log(`✖ ${file} (${entry.name}) @ ${entry.rpc}\n    ${reason}`);
      failures.push({ entry, file, reason });
    }
  }));

  console.log(`\n${toCheck.length - failures.length}/${toCheck.length} endpoints ok`);

  if (!failures.length) {
    return;
  }

  args.report && fs.writeFileSync(args.report, formatReport(failures));

  if (args['disable-failing']) {
    const date = new Date().toISOString().slice(0, 10);

    for (const { entry, reason } of failures) {
      entry.disabled = true;
      entry.comment = [entry.comment, `Disabled on ${date}: ${reason}`].filter(Boolean).join('; ');
    }

    for (const file of new Set(failures.map(({ file }) => file))) {
      writeRpcFile(file, files.get(file));
    }
  } else {
    process.exitCode = 1;
  }
}

await main();
