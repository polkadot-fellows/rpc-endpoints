import { z } from 'zod';

/**
 * An entry of the rpc/<chain-id>.json files
 */
export const RpcEndpointSchema = z.strictObject({
  comment: z.string().optional(),
  disabled: z.boolean().optional(),
  name: z.string().trim().min(1),
  rpc: z.string().startsWith('wss://')
});

/**
 * The content of a rpc/<chain-id>.json file
 */
export const RpcEndpointsSchema = z.array(RpcEndpointSchema).superRefine((entries, ctx): void => {
  const names = new Set<string>();
  const rpcs = new Set<string>();

  entries.forEach(({ name, rpc }, index): void => {
    if (names.has(name)) {
      ctx.addIssue({ code: 'custom', message: `duplicate name '${name}'`, path: [index, 'name'] });
    }

    if (rpcs.has(rpc)) {
      ctx.addIssue({ code: 'custom', message: `duplicate rpc '${rpc}'`, path: [index, 'rpc'] });
    }

    names.add(name);
    rpcs.add(rpc);
  });
});

export type RpcEndpoint = z.infer<typeof RpcEndpointSchema>;
