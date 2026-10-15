// Tests against a local chain. Start one first:  npm run demo:chain
// Every test run deploys fresh contracts, so results don't depend on old state.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import * as P from "../src/provenance.js";

const KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  agentA: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  agentB: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  relayer: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
};
const addr = (k) => privateKeyToAccount(KEYS[k]).address;
const mocks = JSON.parse(readFileSync(new URL("./mocks.json", import.meta.url)));

const up = await fetch("http://127.0.0.1:8545", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
}).then(() => true, () => false);
const skip = up ? false : "local chain not running (npm run demo:chain)";

let chain, pub, wallet1271;
const uid = (label) => P.sha256(`${label}|${Date.now()}|${Math.random()}`);
const rejectsWith = (p, name) =>
  assert.rejects(p, (e) => {
    assert.equal(P.errorName(e)?.name, name);
    return true;
  });
async function deploy(art, args) {
  const hash = await P.walletClient(chain, KEYS.deployer).deployContract({ abi: art.abi, bytecode: art.bytecode, args });
  return (await pub.waitForTransactionReceipt({ hash })).contractAddress;
}

before(async () => {
  if (skip) return;
  chain = P.getChain("local");
  pub = P.publicClient(chain);
  // Mock ERC-8004 registry: agent #7 is owned by agentA; agent #8 is owned by deployer with agentB as its wallet.
  const registry = await deploy(mocks.MockIdentityRegistry, []);
  const w = P.walletClient(chain, KEYS.deployer);
  for (const [id, owner, wal] of [[7n, addr("agentA"), "0x0000000000000000000000000000000000000000"], [8n, addr("deployer"), addr("agentB")]]) {
    const h = await w.writeContract({ address: registry, abi: mocks.MockIdentityRegistry.abi, functionName: "set", args: [id, owner, wal] });
    await pub.waitForTransactionReceipt({ hash: h });
  }
  chain.address = await deploy(P.artifact, [registry]);
  wallet1271 = await deploy(mocks.MockSmartWallet, [addr("agentB")]);
});

test("Merkle helpers agree with each other", () => {
  for (const n of [1, 2, 3, 5, 8, 13]) {
    const leaves = Array.from({ length: n }, (_, i) => P.sha256(`leaf${i}`));
    const layers = P.buildTree(leaves);
    leaves.forEach((l, i) => assert.equal(P.processProof(l, P.getProof(layers, i)), layers.at(-1)[0]));
  }
});

test("a pipeline records sources -> step -> output, and trace walks it", { skip }, async () => {
  const src1 = uid("paper"), src2 = uid("dataset"), notes = uid("notes"), report = uid("report");
  await P.recordMany(chain, KEYS.agentA, [
    { id: src1, kind: "source", meta: { url: "https://example.org/paper" } },
    { id: src2, kind: "source", meta: { url: "https://example.org/data.csv" } },
    { id: notes, kind: "step", parents: [src1, src2], meta: { model: "model-x", tool: "summarize" } },
  ]);
  await P.record(chain, KEYS.agentA, { id: report, kind: "output", parents: [notes], agentId: 7, meta: { model: "model-x" } });

  const r = await P.getRecord(chain, report);
  assert.equal(r.author, addr("agentA"));
  assert.equal(r.agentId, "7");
  assert.deepEqual(r.meta, { model: "model-x" });

  const tree = await P.trace(chain, report);
  assert.equal(tree.parents[0].id, notes);
  assert.deepEqual(tree.parents[0].parents.map((p) => p.id), [src1, src2]);
  assert.equal(tree.parents[0].parents[0].meta.url, "https://example.org/paper");

  assert.deepEqual(await P.isAncestor(chain, src2, report), { found: true, complete: true });
  assert.deepEqual(await P.isAncestor(chain, report, src2), { found: false, complete: true });
  const kids = await P.children(chain, src1);
  assert.deepEqual(kids.map((k) => k.id), [notes]);
});

test("graph rules: no unknown parents, duplicates, self-links or double records", { skip }, async () => {
  const a = uid("a");
  await rejectsWith(P.record(chain, KEYS.agentA, { id: uid("x"), parents: [uid("ghost")] }), "UnknownParent");
  await P.record(chain, KEYS.agentA, { id: a, kind: "source" });
  await rejectsWith(P.record(chain, KEYS.agentB, { id: a }), "AlreadyRecorded");
  await rejectsWith(P.record(chain, KEYS.agentA, { id: uid("y"), parents: [a, a] }), "DuplicateParent");
  await rejectsWith(P.record(chain, KEYS.agentA, { id: a, parents: [a] }), "AlreadyRecorded");
  const self = uid("self");
  await rejectsWith(P.record(chain, KEYS.agentA, { id: self, parents: [self] }), "SelfParent");
  await rejectsWith(P.record(chain, KEYS.agentA, { id: uid("big"), meta: "x".repeat(1025) }), "MetaTooLong");
});

test("agentId claims are checked against ERC-8004 (owner or agent wallet)", { skip }, async () => {
  await P.record(chain, KEYS.agentA, { id: uid("own"), agentId: 7 }); // owner
  await P.record(chain, KEYS.agentB, { id: uid("wallet"), agentId: 8 }); // registered agent wallet
  await rejectsWith(P.record(chain, KEYS.agentB, { id: uid("steal"), agentId: 7 }), "NotAgentController");
  await rejectsWith(P.record(chain, KEYS.agentA, { id: uid("none"), agentId: 999 }), "NotAgentController");
});

test("signed records: agent signs with no gas, anyone submits, author is the signer", { skip }, async () => {
  const id = uid("signed");
  const signed = await P.signRecord(chain, KEYS.agentA, { id, kind: "output", agentId: 7, meta: { model: "m" } });
  const balBefore = await pub.getBalance({ address: addr("agentA") });
  await P.submitSigned(chain, KEYS.relayer, signed);
  assert.equal(await pub.getBalance({ address: addr("agentA") }), balBefore, "signer paid nothing");
  const r = await P.getRecord(chain, id);
  assert.equal(r.author, addr("agentA"));
});

test("signed records: tampering or wrong author is rejected", { skip }, async () => {
  const signed = await P.signRecord(chain, KEYS.agentA, { id: uid("t"), kind: "output" });
  await rejectsWith(P.submitSigned(chain, KEYS.relayer, { ...signed, record: { ...signed.record, kind: 0 } }), "BadSignature");
  await rejectsWith(P.submitSigned(chain, KEYS.relayer, { ...signed, author: addr("agentB") }), "BadSignature");
  // A real submission can't be replayed: the id can only be recorded once.
  await P.submitSigned(chain, KEYS.relayer, signed);
  await rejectsWith(P.submitSigned(chain, KEYS.relayer, signed), "AlreadyRecorded");
});

test("signed records work for smart-contract wallets (ERC-1271)", { skip }, async () => {
  const id = uid("1271");
  const inner = await P.signRecord(chain, KEYS.agentB, { id, kind: "output" }); // agentB is the wallet's signer
  await P.submitSigned(chain, KEYS.relayer, { ...inner, author: wallet1271 });
  assert.equal((await P.getRecord(chain, id)).author, P.getAddress(wallet1271));
});

test("light batches: cheap, provable, rebuildable from chain, promotable", { skip }, async () => {
  const src = uid("lsrc"), out = uid("lout");
  const recs = [
    { id: src, kind: "source", meta: { url: "https://example.org" } },
    ...Array.from({ length: 6 }, (_, i) => ({ id: uid(`l${i}`), kind: "step", meta: { i } })),
    { id: out, kind: "output", parents: [src], agentId: 7, meta: { model: "m" } },
  ];
  const receipt = await P.recordBatchLight(chain, KEYS.agentA, recs);
  assert.equal(receipt.records.length, 8);
  for (const r of receipt.records) assert.equal(await P.verifyLight(chain, receipt.batchId, r), true);

  // Tampered data or a wrong proof fails.
  const bad = { ...receipt.records[1], meta: '{"i":99}' };
  assert.equal(await P.verifyLight(chain, receipt.batchId, bad), false);
  assert.equal(await P.verifyLight(chain, receipt.batchId, { ...receipt.records[1], proof: receipt.records[2].proof }), false);

  // Everything can be rebuilt from the chain alone.
  const rebuilt = await P.fetchLightBatch(chain, receipt.batchId);
  assert.equal(rebuilt.root, receipt.root);
  assert.deepEqual(rebuilt.records.map((r) => r.proof), receipt.records.map((r) => r.proof));

  // Promote: parent first, then child. Author and time come from the batch.
  await rejectsWith(P.promote(chain, KEYS.relayer, receipt.batchId, rebuilt.records[7]), "UnknownParent");
  await P.promote(chain, KEYS.relayer, receipt.batchId, rebuilt.records[0]);
  await P.promote(chain, KEYS.relayer, receipt.batchId, rebuilt.records[7]);
  const r = await P.getRecord(chain, out);
  assert.equal(r.author, addr("agentA"));
  assert.equal(r.batchId, receipt.batchId);
  assert.equal(r.timestamp, rebuilt.timestamp);
  assert.deepEqual(r.meta, { model: "m" });
  await rejectsWith(P.promote(chain, KEYS.relayer, receipt.batchId, rebuilt.records[7]), "AlreadyRecorded");
});

test("light batches still enforce agentId ownership", { skip }, async () => {
  await rejectsWith(P.recordBatchLight(chain, KEYS.agentB, [{ id: uid("lb"), agentId: 7 }]), "NotAgentController");
});

test("isAncestor reports when its search limit is reached", { skip }, async () => {
  // A chain of 6 records: r0 <- r1 <- … <- r5
  const ids = Array.from({ length: 6 }, (_, i) => uid(`chain${i}`));
  await P.recordMany(chain, KEYS.agentA, ids.map((id, i) => ({ id, kind: "step", parents: i ? [ids[i - 1]] : [] })));
  assert.deepEqual(await P.isAncestor(chain, ids[0], ids[5], 256), { found: true, complete: true });
  assert.deepEqual(await P.isAncestor(chain, ids[0], ids[5], 3), { found: false, complete: false });
});
