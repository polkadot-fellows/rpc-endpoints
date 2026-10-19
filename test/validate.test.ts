import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { RpcEndpointsSchema } from '../src/schema.ts';
import { readRpcFiles } from '../src/utils.ts';

describe('rpc json files are valid', (): void => {
  for (const { content, file } of readRpcFiles()) {
    it(`rpc/${file}`, (): void => {
      // the file name is the chain id, e.g. asset-hub-polkadot.json
      assert(
        /^[a-z0-9]+(-[a-z0-9]+)*\.json$/.test(file),
        `${file}: the file name should be the (lowercase, dash-separated) chain id`
      );

      const result = RpcEndpointsSchema.safeParse(content);

      assert(
        result.success,
        `${file}: ${result.error?.issues.map(({ message, path }) => `[${path.join('.')}] ${message}`).join(', ')}`
      );
    });
  }
});
