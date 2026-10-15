# Agent Provenance Graph

**Live on Base:** [`0xB955fc64b884e0e3dA431cCdd36B864E9A234ac3`](https://basescan.org/address/0xb955fc64b884e0e3da431ccdd36b864e9a234ac3#code)

An on-chain family tree for AI outputs. Every piece of content (a source, an intermediate
step, a final report, a review) is recorded by its hash, together with links to what it was
made from, who made it and when. Anyone can then trace where a result came from.

```
$ npm run prov -- trace review.md

[review] 0xc6d81576…0e54  2026-10-15 19:21:22  by 0x3C44…93BC  verdict=accurate
├─ [output] 0x648ce060…d922  2026-10-15 19:21:21  by 0x7099…79C8  model=example-model task=surf outlook
│  └─ [step] 0x05d43620…a42a  2026-10-15 19:21:21  by 0x7099…79C8  model=example-model tool=summarize
│     ├─ [source] 0x7f7b7403…98bc  …  url=https://example.org/tides
│     └─ [source] 0xd94546f3…ddf2  …  url=https://example.org/buoy/46225
└─ 0xd94546f3…ddf2  (shown above)
```

**Fully on-chain. No owner, no fees, no admin, no upgrades.** Once deployed, nobody (including
you) can change or control it, and it never holds money.

## What it proves

- **This exact content existed at this time.** Records are hashes; change one byte and it no longer matches.
- **Who produced it.** The author is the wallet that sent or signed the record, and it can't be faked.
- **Which agent.** If a record claims an ERC-8004 agent ID, the contract checks the author really controls that agent.
- **What it was made from.** Parents must already be recorded, so the history is always complete and in order.
- **What was made from it.** Children are indexed too, so you can trace forward ("what used this source?").

Only hashes go on-chain, so the content itself stays private until you choose to show it.

## Four ways to record

| Mode | Cost per record | When to use |
| --- | --- | --- |
| `record` / `pipeline` (full) | ~105k gas | Important outputs; readable by other contracts; parents are checked |
| `pipeline --light` (light batch) | **~11k gas** (500 per tx) | High volume. Stores one Merkle root; every record's data is still in the chain's event logs |
| `sign` + `submit` | 0 for the agent | An agent with no ETH signs; anyone submits it and pays the gas. Author is still the agent |
| `promote` | ~110k gas | Turn a light record into a full one later, keeping its original author and time |

On Base, a full record is a fraction of a cent and a light record about a tenth of that.

Light batches don't check parents or duplicates (that would need storage). The earliest
proven record wins. Anything in a light batch can be rebuilt from the chain alone
(`batch-get`) and proven against its root (`verify-light`).

## Try it locally (free)

```bash
npm install
npm run demo:chain                      # terminal 1 (needs Node 22+)
npm run deploy -- local                 # terminal 2
npm run prov -- pipeline examples/research/manifest.json --chain local
PRIVATE_KEY=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a \
  npm run prov -- pipeline examples/research/review-manifest.json --chain local
npm run prov -- trace examples/research/review.md --chain local
npm run prov -- check examples/research/sources/tide-paper.txt examples/research/report.md --chain local
npm test
```

## Recording a pipeline: the manifest

```json
{
  "records": [
    { "name": "paper",  "file": "sources/paper.pdf", "kind": "source", "meta": { "url": "https://…" } },
    { "name": "notes",  "file": "notes.md",  "kind": "step",   "parents": ["paper"], "meta": { "model": "…" } },
    { "name": "report", "file": "report.md", "kind": "output", "parents": ["notes"], "agentId": 42 }
  ]
}
```

- Content comes from `file` (relative to the manifest), `text` (inline) or `id` (a SHA-256 hash).
- `parents` can be a record name, a file or a hash, including things recorded earlier by anyone.
- Records are put in the right order automatically. Already-recorded ones are skipped.
- `kind`: `source`, `step`, `output` or `review`. `meta`: any JSON up to 1 KB (model, tool, URL…).

## All commands

```
npm run prov -- hash <file>
npm run prov -- record <file|hash> [--parent X]... [--kind K] [--agent-id N] [--meta JSON]
npm run prov -- pipeline <manifest.json> [--light] [--out receipt.json]
npm run prov -- trace <file|hash>
npm run prov -- children <file|hash>
npm run prov -- check <ancestor> <descendant>
npm run prov -- sign <file|hash> [record options] [--out signed.json]
npm run prov -- submit <signed.json>
npm run prov -- batch-get <batchId>
npm run prov -- verify-light <receipt.json> [id]
npm run prov -- promote <receipt.json> <id>
npm run prov -- stats
```

All take `--chain base` (default), `base-sepolia`, `sepolia` or `local`. Writing needs
`PRIVATE_KEY`; reading is free and needs no key.

## Deploy to Base

```bash
read -s -p "Private key: " PK && export DEPLOYER_PRIVATE_KEY=$PK PRIVATE_KEY=$PK && echo
npm run deploy -- base        # ~1.76M gas; well under $1 on Base
```

It's wired to Base's ERC-8004 Identity Registry for agent checks. To verify the source on
Basescan: compiler 0.8.24, optimizer on (200 runs), **via-IR on**, EVM version shanghai,
constructor argument = the registry address.

## Contract reference (`contracts/ProvenanceGraph.sol`)

| Function | What |
| --- | --- |
| `record(r)`, `recordMany(rs)` | Full records from `msg.sender` |
| `recordSigned(r, author, sig)` | Full record signed by `author` (EIP-712; EOAs and ERC-1271 smart wallets) |
| `recordBatchLight(rs)` | Light batch: stores a Merkle root, emits every record |
| `verifyLight(batchId, r, proof)`, `promote(...)` | Prove / promote a light record |
| `getRecord`, `parentsOf`, `childrenOf`, `childCount`, `exists` | Read the graph |
| `isAncestor(a, d, maxNodes)` | Was `a` used (at any depth) to make `d`? |
| `hashRecord(r)`, `leafHash(r, author)` | Helpers for signing and proofs |

Limits: 32 parents per record, 1 KB meta, 512 records per batch.
