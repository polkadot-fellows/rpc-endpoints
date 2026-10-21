# rpc-endpoints

Lists of public RPC endpoints for the Polkadot ecosystem chains, for wallets, dapps and tools to
connect to. Each chain's list is:

- **machine-readable**: a JSON file, validated against a schema;
- **checked**: ngiew endpoints are checked when they are added, and all the endpoints are re-checked
  weekly, with the failing ones reported in an issue.

## Adding an endpoint

Anyone running a node that exposes a public RPC endpoint can publish it here by opening a pull
request that adds it to the chain's `rpc/<chain-id>.json` file (see the [format](#format)):

1. Add `{ "name": "<Provider>", "rpc": "wss://..." }` to the file (one entry per chain).
2. Run `npm test` to validate the file, and `npm run check:endpoints -- --changed-since upstream/main` to
   check the new endpoint (with `upstream` pointing to this repository).
3. Open the PR. CI validates the files and checks the endpoints the PR adds; it must pass before the
   PR can be merged.

The endpoint must:

- be publicly reachable over `wss://`, without an API key;
- expose the chain's required RPC methods (e.g. the `statement_*` methods for People, `bitswap_v1_get`
  for Bulletin), see `REQUIRED_METHODS` in [`src/check-endpoints.ts`](src/check-endpoints.ts).

Its node should also be reachable over WebRTC (for light clients): `system_localListenAddresses` should list
at least one public `webrtc-direct` address, and all of them should answer a STUN binding request. This is
only reported as a warning, it doesn't fail the check.

Endpoints that start failing are reported by the weekly check, and are disabled (`"disabled": true`
with a `comment`) rather than removed, so they can be re-enabled once fixed.

## Format

Each chain has a `rpc/<chain-id>.json` file, where `<chain-id>` is the lowercase, dash-separated chain id
(e.g. `asset-hub-polkadot.json`). The file contains an array of endpoints:

```json
[
  {
    "name": "Provider",
    "rpc": "wss://rpc.provider.io/polkadot"
  },
  {
    "name": "Other Provider",
    "rpc": "wss://other-provider.io/polkadot",
    "disabled": true,
    "comment": "Why it was disabled"
  }
]
```

| Field      | Required | Description                                                     |
| ---------- | -------- | --------------------------------------------------------------- |
| `name`     | yes      | The provider name, unique within the file                       |
| `rpc`      | yes      | The `wss://` endpoint, unique within the file                   |
| `disabled` | no       | Set to `true` for endpoints that should not be used (or checked) |
| `comment`  | no       | Free-form notes, e.g. a link to the reason it was disabled      |

The schema is defined in [`src/schema.ts`](src/schema.ts).

## Using the package

```sh
npm install github:polkadot-fellows/rpc-endpoints
# or pinned to a tag/commit: github:polkadot-fellows/rpc-endpoints#<ref>
```

```ts
import { RpcEndpointsSchema, type RpcEndpoint } from '@polkadot-fellows/rpc-endpoints';
import polkadot from '@polkadot-fellows/rpc-endpoints/rpc/polkadot.json' with { type: 'json' };

const endpoints: RpcEndpoint[] = RpcEndpointsSchema.parse(polkadot)
  .filter(({ disabled }) => !disabled);
```

## Development

Requires Node.js >= 22.18 (runs the TypeScript sources directly).

```sh
npm install
npm test                 # validate the rpc/*.json files against the schema
npm run typecheck        # type-check the sources
npm run lint             # lint and check the formatting (npm run lint:fix to fix)
npm run build            # build the schema into dist/ (also run by npm install)
npm run check:endpoints  # check every enabled endpoint (the required RPC methods, and WebRTC as a warning)
```

`npm run check:endpoints -- <options>`:

- `--changed-since <ref>`: only check the endpoints that are new (or re-enabled) compared to a git ref
- `--report <path>`: write a markdown report of the failing endpoints and of the warnings

## CI

- **Validate** (every PR and push to `main`): lints, validates the files against the schema, and on PRs checks
  the endpoints the PR adds or re-enables.
- **Check endpoints** (weekly): checks all the enabled endpoints and opens (or updates) an issue listing
  the failing ones and the warnings.

The warnings are also shown in the runs' logs, but don't fail them.
