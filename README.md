# rpc-endpoints

Lists of public RPC endpoints for the Polkadot ecosystem chains.

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
npm install @polkadot-fellows/rpc-endpoints
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
npm run build            # build the published schema into dist/
npm run check:endpoints  # connect to every enabled endpoint and check it serves a finalized head
```

`npm run check:endpoints -- <options>`:

- `--changed-since <ref>`: only check the endpoints that are new (or re-enabled) compared to a git ref
- `--disable-failing`: mark the failing endpoints as `disabled` (with the reason in `comment`) instead of failing
- `--report <path>`: write a markdown report of the failing endpoints

## CI

- **Validate** (every PR and push to `main`): validates the files against the schema, and on PRs checks
  the endpoints the PR adds or re-enables.
- **Check endpoints** (nightly): checks all the enabled endpoints and opens (or updates) a PR that
  disables the failing ones.
