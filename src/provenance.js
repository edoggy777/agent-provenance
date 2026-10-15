// Library for the ProvenanceGraph contract: hashing, recording, signing, light batches with
// Merkle proofs (matching the contract exactly) and tracing a record's full history.

import { createHash } from "node:crypto";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import {
  createPublicClient, createWalletClient, http, isHex, keccak256, encodeAbiParameters, encodePacked, concat, toBytes, decodeEventLog, getAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const artifact = JSON.parse(readFileSync(new URL("./artifact.json", import.meta.url)));
const abi = artifact.abi;
const DEPLOYMENTS = new URL("../deployments.json", import.meta.url);

export const KINDS = { source: 0, step: 1, output: 2, review: 3 };
export const KIND_NAMES = Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [v, k]));

// ERC-8004 Identity Registry addresses (github.com/erc-8004/erc-8004-contracts).
const ID_MAINNET = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
const ID_TESTNET = "0x8004A818BFB912233c491871b3d84c89A494BD9e";

export const CHAINS = {
  "base-sepolia": { id: 84532, rpc: "https://sepolia.base.org", explorer: "https://sepolia.basescan.org", identityRegistry: ID_TESTNET },
  base: { id: 8453, rpc: "https://mainnet.base.org", explorer: "https://basescan.org", identityRegistry: ID_MAINNET },
  sepolia: { id: 11155111, rpc: "https://ethereum-sepolia-rpc.publicnode.com", explorer: "https://sepolia.etherscan.io", identityRegistry: ID_TESTNET },
  local: { id: 31337, rpc: "http://127.0.0.1:8545", explorer: null, identityRegistry: null },
};

// ---------------------------------------------------------------- setup

export function loadDeployments() {
  return existsSync(DEPLOYMENTS) ? JSON.parse(readFileSync(DEPLOYMENTS, "utf8")) : {};
}
export function saveDeployment(chainName, info) {
  const d = loadDeployments();
  d[chainName] = info;
  writeFileSync(DEPLOYMENTS, JSON.stringify(d, null, 2) + "\n");
}

export function getChain(name) {
  const c = CHAINS[name];
  if (!c) throw new Error(`Unknown chain "${name}". Use one of: ${Object.keys(CHAINS).join(", ")}`);
  const rpc = process.env[`RPC_${name.toUpperCase().replace(/-/g, "_")}`] || c.rpc;
  const dep = loadDeployments()[name] || {};
  const address = process.env.PROVENANCE_ADDRESS || dep.address || null;
  const viemChain = { id: c.id, name, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } };
  return { name, ...c, rpc, address, deployBlock: dep.block ? BigInt(dep.block) : 0n, viemChain };
}

export const publicClient = (chain) => createPublicClient({ chain: chain.viemChain, transport: http(chain.rpc, { timeout: 30_000 }) });
export const walletClient = (chain, key) =>
  createWalletClient({ account: privateKeyToAccount(key), chain: chain.viemChain, transport: http(chain.rpc, { timeout: 30_000 }) });

const need = (chain) => {
  if (!chain.address) throw new Error(`No ProvenanceGraph known on ${chain.name}. Deploy one (npm run deploy) or set PROVENANCE_ADDRESS.`);
};
const read = (chain, functionName, args = []) => publicClient(chain).readContract({ address: chain.address, abi, functionName, args });

async function write(chain, key, functionName, args) {
  need(chain);
  const wallet = walletClient(chain, key);
  const pub = publicClient(chain);
  // Simulate first so a revert (duplicate, missing parent…) costs nothing and gives a clear reason.
  const { request, result } = await pub.simulateContract({ account: wallet.account, address: chain.address, abi, functionName, args });
  const hash = await wallet.writeContract(request);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} failed (tx ${hash})`);
  return { hash, receipt, result };
}

// ---------------------------------------------------------------- hashing & inputs

export const sha256 = (data) => "0x" + createHash("sha256").update(data).digest("hex");
export const hashFile = (path) => sha256(readFileSync(path));

export function normalizeHash(h) {
  if (typeof h !== "string") return null;
  const x = h.startsWith("0x") ? h : "0x" + h;
  if (!isHex(x) || x.length !== 66 || /^0x0{64}$/.test(x)) return null;
  return x.toLowerCase();
}

/** A file path or a hash -> hash. */
export function resolveId(ref) {
  if (existsSync(ref)) return hashFile(ref);
  const h = normalizeHash(ref);
  if (!h) throw new Error(`"${ref}" is neither a file nor a 0x + 64-hex hash`);
  return h;
}

/** Normalizes a friendly record into the exact struct the contract takes. */
export function toInput({ id, parents = [], kind = "output", agentId = 0, meta = "" }) {
  const k = typeof kind === "number" ? kind : KINDS[kind];
  if (k === undefined) throw new Error(`Unknown kind "${kind}". Use: ${Object.keys(KINDS).join(", ")}`);
  return {
    id: normalizeHash(id) || (() => { throw new Error(`bad id ${id}`); })(),
    parents: parents.map((p) => normalizeHash(p) || (() => { throw new Error(`bad parent ${p}`); })()),
    kind: k,
    agentId: BigInt(agentId),
    meta: typeof meta === "string" ? meta : JSON.stringify(meta),
  };
}

// ---------------------------------------------------------------- Merkle (must match the contract)

const packParents = (parents) => keccak256(parents.length ? encodePacked(parents.map(() => "bytes32"), parents) : "0x");

export function leafHash(input, author) {
  const inner = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint8" }, { type: "uint256" }, { type: "bytes32" }, { type: "address" }],
      [input.id, packParents(input.parents), input.kind, input.agentId, keccak256(toBytes(input.meta)), author]
    )
  );
  return keccak256(inner);
}

const hashPair = (a, b) => (BigInt(a) < BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a])));

/** All layers of the tree; an odd node at the end of a layer moves up unchanged. */
export function buildTree(leaves) {
  const layers = [leaves.slice()];
  while (layers.at(-1).length > 1) {
    const cur = layers.at(-1);
    const next = [];
    for (let i = 0; i + 1 < cur.length; i += 2) next.push(hashPair(cur[i], cur[i + 1]));
    if (cur.length % 2) next.push(cur.at(-1));
    layers.push(next);
  }
  return layers;
}

export function getProof(layers, index) {
  const proof = [];
  for (let l = 0; l < layers.length - 1; l++) {
    const layer = layers[l];
    const sibling = index % 2 ? index - 1 : index + 1;
    if (sibling < layer.length) proof.push(layer[sibling]); // no sibling = carried up, no proof step
    index = Math.floor(index / 2);
  }
  return proof;
}

export const processProof = (leaf, proof) => proof.reduce((h, p) => hashPair(h, p), leaf);

// ---------------------------------------------------------------- full records

export async function record(chain, key, rec) {
  const input = toInput(rec);
  const { hash } = await write(chain, key, "record", [input]);
  return { id: input.id, tx: hash };
}

export async function recordMany(chain, key, recs) {
  const inputs = recs.map(toInput);
  const { hash, receipt } = await write(chain, key, "recordMany", [inputs]);
  return { ids: inputs.map((i) => i.id), tx: hash, gasUsed: receipt.gasUsed };
}

/** Agent signs a record off-chain (no gas). Anyone can then submit it with submitSigned. */
export async function signRecord(chain, key, rec) {
  need(chain);
  const input = toInput(rec);
  const account = privateKeyToAccount(key);
  const signature = await account.signTypedData({
    domain: { name: "ProvenanceGraph", version: "1", chainId: chain.id, verifyingContract: chain.address },
    types: {
      Record: [
        { name: "id", type: "bytes32" },
        { name: "parents", type: "bytes32[]" },
        { name: "kind", type: "uint8" },
        { name: "agentId", type: "uint256" },
        { name: "meta", type: "string" },
      ],
    },
    primaryType: "Record",
    message: input,
  });
  return { chain: chain.name, contract: chain.address, author: account.address, record: { ...input, agentId: input.agentId.toString() }, signature };
}

export async function submitSigned(chain, relayerKey, signed) {
  const input = toInput(signed.record);
  const { hash } = await write(chain, relayerKey, "recordSigned", [input, signed.author, signed.signature]);
  return { id: input.id, author: signed.author, tx: hash };
}

// ---------------------------------------------------------------- light batches

/** Publishes many records cheaply. Returns a receipt with a Merkle proof for every record. */
export async function recordBatchLight(chain, key, recs) {
  const inputs = recs.map(toInput);
  const author = privateKeyToAccount(key).address;
  const layers = buildTree(inputs.map((i) => leafHash(i, author)));
  const root = layers.at(-1)[0];
  const { hash, receipt } = await write(chain, key, "recordBatchLight", [inputs]);
  // Take the batch id from the event, not the simulation (another batch could land in between).
  const ev = receipt.logs
    .map((l) => { try { return decodeEventLog({ abi, ...l }); } catch { return null; } })
    .find((e) => e?.eventName === "BatchRecorded");
  const result = ev.args.batchId;
  const batch = await read(chain, "getBatch", [result]);
  if (batch.root.toLowerCase() !== root.toLowerCase()) throw new Error("Merkle root mismatch between client and contract");
  return {
    chain: chain.name,
    contract: chain.address,
    batchId: result.toString(),
    author,
    root,
    tx: hash,
    gasUsed: receipt.gasUsed.toString(),
    records: inputs.map((input, i) => ({ ...input, agentId: input.agentId.toString(), proof: getProof(layers, i) })),
  };
}

/** Rebuilds a light batch purely from the chain (events), so proofs never depend on a saved file. */
export async function fetchLightBatch(chain, batchId) {
  need(chain);
  const batch = await read(chain, "getBatch", [BigInt(batchId)]);
  if (batch.root === "0x" + "0".repeat(64)) throw new Error(`No batch ${batchId}`);
  const pub = publicClient(chain);
  const logs = await pub.getContractEvents({
    address: chain.address, abi, eventName: "LightRecord", args: { batchId: BigInt(batchId) },
    fromBlock: batch.blockNumber, toBlock: batch.blockNumber,
  });
  const inputs = logs
    .sort((a, b) => a.args.index - b.args.index)
    .map((l) => ({ id: l.args.id, parents: [...l.args.parents], kind: l.args.kind, agentId: l.args.agentId, meta: l.args.meta }));
  const layers = buildTree(inputs.map((i) => leafHash(i, batch.author)));
  if (layers.at(-1)[0].toLowerCase() !== batch.root.toLowerCase()) throw new Error("Rebuilt batch does not match its on-chain root");
  return {
    chain: chain.name, contract: chain.address, batchId: String(batchId), author: batch.author, root: batch.root,
    timestamp: Number(batch.timestamp), block: Number(batch.blockNumber),
    records: inputs.map((input, i) => ({ ...input, agentId: input.agentId.toString(), proof: getProof(layers, i) })),
  };
}

export async function verifyLight(chain, batchId, rec) {
  return read(chain, "verifyLight", [BigInt(batchId), toInput(rec), rec.proof]);
}

export async function promote(chain, key, batchId, rec) {
  const { hash } = await write(chain, key, "promote", [BigInt(batchId), toInput(rec), rec.proof]);
  return { id: rec.id, tx: hash };
}

// ---------------------------------------------------------------- reading

async function metaFor(chain, id, blockNumber) {
  try {
    const logs = await publicClient(chain).getContractEvents({
      address: chain.address, abi, eventName: "Recorded", args: { id }, fromBlock: blockNumber, toBlock: blockNumber,
    });
    if (logs[0]?.args.meta) return logs[0].args.meta;
    // Promoted records: their meta lives in the light batch's event.
    const promoted = await publicClient(chain).getContractEvents({ address: chain.address, abi, eventName: "LightRecord", args: { id }, fromBlock: blockNumber, toBlock: blockNumber });
    return promoted[0]?.args.meta || "";
  } catch {
    return "";
  }
}

export async function getRecord(chain, id, { withMeta = true } = {}) {
  need(chain);
  const r = await read(chain, "getRecord", [id]);
  if (!r.timestamp) return null;
  const meta = withMeta ? await metaFor(chain, id, r.blockNumber) : undefined;
  let metaObj = meta;
  try {
    metaObj = meta ? JSON.parse(meta) : null;
  } catch {
    /* plain-text meta */
  }
  return {
    id,
    author: r.author,
    time: new Date(Number(r.timestamp) * 1000).toISOString(),
    timestamp: Number(r.timestamp),
    block: Number(r.blockNumber),
    kind: KIND_NAMES[r.kind] ?? r.kind,
    agentId: r.agentId ? r.agentId.toString() : null,
    batchId: r.batchId ? r.batchId.toString() : null,
    parents: [...r.parents],
    meta: metaObj,
  };
}

/** Walks up the graph from `id`, returning a tree. Shared ancestors appear once (marked `seen`). */
export async function trace(chain, id, { maxNodes = 200 } = {}) {
  const visited = new Set();
  let count = 0;
  async function walk(nodeId) {
    if (visited.has(nodeId)) return { id: nodeId, seen: true };
    visited.add(nodeId);
    if (++count > maxNodes) return { id: nodeId, truncated: true };
    const r = await getRecord(chain, nodeId);
    if (!r) return { id: nodeId, missing: true };
    const parents = [];
    for (const p of r.parents) parents.push(await walk(p));
    return { ...r, parents };
  }
  return walk(id);
}

export async function children(chain, id, { limit = 100 } = {}) {
  need(chain);
  const ids = await read(chain, "childrenOf", [id, 0n, BigInt(limit)]);
  return Promise.all(ids.map((c) => getRecord(chain, c, { withMeta: false })));
}

export async function isAncestor(chain, ancestor, descendant, maxNodes = 256) {
  need(chain);
  const [found, complete] = await read(chain, "isAncestor", [ancestor, descendant, BigInt(maxNodes)]);
  return { found, complete };
}

export async function stats(chain) {
  need(chain);
  const [records, batches, registry] = await Promise.all([read(chain, "recordCount"), read(chain, "batchCount"), read(chain, "identityRegistry")]);
  return { chain: chain.name, contract: chain.address, records: Number(records), lightBatches: Number(batches), identityRegistry: registry };
}

/** Reads the custom error name out of a viem error, for friendly messages. */
export function errorName(err) {
  let e = err;
  while (e) {
    if (e.data?.errorName) return { name: e.data.errorName, args: e.data.args };
    e = e.cause;
  }
  return null;
}

export { getAddress };
