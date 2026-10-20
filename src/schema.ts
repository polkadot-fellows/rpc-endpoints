import { z } from 'zod';

/**
 * An entry of the rpc/<chain-id>.json files
 */
export const RpcEndpointSchema = z.strictObject({
  comment: z.string().optional(),
  disabled: z.boolean().optional(),
  name: z.string().trim().min(1),
  rpc: z.url({ protocol: /^wss$/ }).refine((value) => !value.includes('#'), 'WebSocket URLs must not contain fragments')
});

/**
 * The content of a rpc/<chain-id>.json file
 */
export const RpcEndpointsSchema = z.array(RpcEndpointSchema).superRefine((entries, ctx): void => {
  const names = new Set<string>();
  const rpcs = new Set<string>();

  entries.forEach(({ name, rpc }, index): void => {
    // e.g. 'WSS://Host:443' and 'wss:host' are the same endpoint as 'wss://host/'
    // (this also runs for entries that failed validation, hence the fallback)
    const normalizedRpc = URL.parse(rpc)?.href ?? rpc;

    if (names.has(name)) {
      ctx.addIssue({ code: 'custom', message: `duplicate name '${name}'`, path: [index, 'name'] });
    }

    if (rpcs.has(normalizedRpc)) {
      ctx.addIssue({ code: 'custom', message: `duplicate rpc '${rpc}'`, path: [index, 'rpc'] });
    }

    names.add(name);
    rpcs.add(normalizedRpc);
  });
});

export type RpcEndpoint = z.infer<typeof RpcEndpointSchema>;
