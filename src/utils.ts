import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

/**
 * The directory containing the rpc/<chain-id>.json files
 */
const RPC_DIR = new URL('../rpc/', import.meta.url);

export interface RpcFile {
  content: unknown;
  file: string;
}

/**
 * Reads (without validating) all the rpc/<chain-id>.json files
 */
export function readRpcFiles(): RpcFile[] {
  return fs
    .readdirSync(RPC_DIR)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => ({
      content: JSON.parse(fs.readFileSync(new URL(file, RPC_DIR), 'utf-8')) as unknown,
      file
    }));
}

/**
 * Reads (without validating) all the rpc/<chain-id>.json files as they were at the given git ref
 */
export function readRpcFilesAt(ref: string): RpcFile[] {
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: new URL('..', RPC_DIR), encoding: 'utf-8' });

  // lists nothing if rpc/ doesn't exist at the ref
  return git('ls-tree', '--name-only', ref, 'rpc/')
    .split('\n')
    .filter((path) => path.endsWith('.json'))
    .sort()
    .map((path) => ({
      content: JSON.parse(git('show', `${ref}:${path}`)) as unknown,
      file: path.slice('rpc/'.length)
    }));
}
