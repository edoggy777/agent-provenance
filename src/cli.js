#!/usr/bin/env node
// Command-line tool for the on-chain provenance graph.
//
//   hash     <file>
//   record   <file|hash> [--parent <file|hash>]... [--kind source|step|output|review] [--agent-id N] [--meta '{"model":"…"}']
//   pipeline <manifest.json> [--light]          record a whole pipeline (full records, or one cheap light batch)
//   trace    <file|hash>                        show where it came from, as a tree
//   children <file|hash>                        what was made from it
//   check    <ancestor> <descendant>            was ancestor used to make descendant?
//   sign     <file|hash> [same options as record] [--out signed.json]   sign without gas
//   submit   <signed.json>                      submit someone's signed record (you pay gas)
//   batch-get <batchId> [--out receipt.json]    rebuild a light batch + proofs from the chain
//   verify-light <receipt.json> [id]            check light records against their on-chain root
//   promote  <receipt.json> <id>               turn a light record into a full one
//   stats
//
// Options: --chain base (default) | base-sepolia | sepolia | local

import { writeFileSync, readFileSync } from "node:fs";
import * as P from "./provenance.js";
import { loadManifest } from "./manifest.js";

const LOCAL_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // hardhat #1, local only

// ---- args
const argv = process.argv.slice(2);
const VALUE_FLAGS = new Set(["--chain", "--parent", "--kind", "--agent-id", "--meta", "--out", "--max"]);
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (VALUE_FLAGS.has(a)) (flags[a.slice(2)] ||= []).push(argv[++i]);
  else if (a.startsWith("--")) flags[a.slice(2)] = [true];
  else positional.push(a);
}
const flag = (n) => flags[n]?.[0];
const [cmd, ...args] = positional;
const chain = P.getChain(flag("chain") || process.env.CHAIN || "base");

function key() {
  const k = process.env.PRIVATE_KEY || (chain.name === "local" ? LOCAL_KEY : null);
  if (!k) {
    console.error("Set PRIVATE_KEY to a wallet with a little ETH for gas. Use a dedicated key, never your main wallet.");
    process.exit(1);
  }
  return k;
}

function recFromFlags(target) {
  let meta = flag("meta") || "";
  if (meta) {
    try {
      JSON.parse(meta);
    } catch {
      meta = JSON.stringify({ note: meta });
    }
  }
  return { id: P.resolveId(target), parents: (flags.parent || []).map(P.resolveId), kind: flag("kind") || "output", agentId: flag("agent-id") || 0, meta };
}

const short = (h) => (h ? `${h.slice(0, 10)}…${h.slice(-4)}` : "");
const explorerTx = (tx) => (chain.explorer ? `${chain.explorer}/tx/${tx}` : tx);

function printTree(node, prefix = "", last = true, root = true) {
  const branch = root ? "" : last ? "└─ " : "├─ ";
  const line = (s) => console.log(prefix + branch + s);
  if (node.seen) line(`${short(node.id)}  (shown above)`);
  else if (node.missing) line(`${short(node.id)}  NOT RECORDED`);
  else if (node.truncated) line(`${short(node.id)}  …`);
  else {
    const m = node.meta && typeof node.meta === "object" ? Object.entries(node.meta).map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`).join(" ") : node.meta || "";
    line(`[${node.kind}] ${short(node.id)}  ${node.time.replace("T", " ").slice(0, 19)}  by ${short(node.author)}${node.agentId ? ` (agent #${node.agentId})` : ""}${m ? `  ${m}` : ""}`);
  }
  const kids = node.parents || [];
  const childPrefix = prefix + (root ? "" : last ? "   " : "│  ");
  kids.forEach((k, i) => printTree(k, childPrefix, i === kids.length - 1, false));
}

function explain(err) {
  const e = P.errorName(err);
  const msgs = {
    AlreadyRecorded: "Already recorded. The first record stands.",
    UnknownParent: "A parent isn't recorded yet. Record parents first (or use `pipeline`, which orders them for you).",
    NotAgentController: "That agentId doesn't belong to this wallet in the ERC-8004 registry.",
    BadSignature: "The signature doesn't match the author.",
    NotInBatch: "That record isn't in the batch (wrong data or proof).",
    DuplicateParent: "The same parent is listed twice.",
    SelfParent: "A record can't be its own parent.",
    TooManyParents: "At most 32 parents per record.",
    MetaTooLong: "meta must be at most 1024 bytes.",
    BadBatchSize: "Batches must have 1–512 records.",
  };
  if (e) return `${msgs[e.name] || e.name}${e.args?.length ? `  (${e.args.map(String).join(", ")})` : ""}`;
  const m = err.shortMessage || err.message;
  return /insufficient funds/i.test(m) ? "Not enough ETH in this wallet for gas." : m;
}

try {
  switch (cmd) {
    case "hash":
      console.log(P.resolveId(args[0]));
      break;

    case "record": {
      if (!args[0]) throw new Error("record <file|hash> [--parent …]");
      const r = await P.record(chain, key(), recFromFlags(args[0]));
      console.log(`✔ Recorded ${r.id}\n  ${explorerTx(r.tx)}`);
      break;
    }

    case "pipeline": {
      const recs = loadManifest(args[0]);
      if (flags.light) {
        const receipt = await P.recordBatchLight(chain, key(), recs);
        receipt.names = recs.map((r) => r.name);
        const out = flag("out") || `batch-${receipt.batchId}.json`;
        writeFileSync(out, JSON.stringify(receipt, null, 2));
        console.log(`✔ Light batch #${receipt.batchId}: ${recs.length} records, gas ${receipt.gasUsed}\n  root ${receipt.root}\n  receipt saved to ${out} (can also be rebuilt any time with batch-get)\n  ${explorerTx(receipt.tx)}`);
      } else {
        const known = await Promise.all(recs.map((r) => P.getRecord(chain, r.id, { withMeta: false })));
        const todo = recs.filter((_, i) => !known[i]);
        if (!todo.length) {
          console.log("Everything in this manifest is already recorded.");
          break;
        }
        const r = await P.recordMany(chain, key(), todo);
        console.log(`✔ Recorded ${todo.length} record(s)${known.filter(Boolean).length ? ` (${known.filter(Boolean).length} already existed)` : ""}, gas ${r.gasUsed}`);
        for (const t of todo) console.log(`  [${t.kind}] ${t.name}  ${t.id}`);
        console.log(`  ${explorerTx(r.tx)}`);
      }
      break;
    }

    case "trace": {
      const id = P.resolveId(args[0]);
      const tree = await P.trace(chain, id, { maxNodes: Number(flag("max") || 200) });
      if (tree.missing) console.log(`Not recorded on ${chain.name}: ${id}`);
      else {
        console.log();
        printTree(tree);
        console.log();
      }
      break;
    }

    case "children": {
      const id = P.resolveId(args[0]);
      const kids = await P.children(chain, id);
      if (!kids.length) console.log("Nothing recorded as made from this.");
      for (const k of kids) console.log(`[${k.kind}] ${k.id}  ${k.time}  by ${k.author}`);
      break;
    }

    case "check": {
      const [a, d] = [P.resolveId(args[0]), P.resolveId(args[1])];
      const { found, complete } = await P.isAncestor(chain, a, d);
      console.log(found ? "✔ Yes: the first was used (directly or indirectly) to make the second." : complete ? "✘ No: it is not in the second one's history." : "? Not found within the search limit (very large history).");
      break;
    }

    case "sign": {
      const signed = await P.signRecord(chain, key(), recFromFlags(args[0]));
      const out = flag("out") || `signed-${signed.record.id.slice(2, 10)}.json`;
      writeFileSync(out, JSON.stringify(signed, null, 2));
      console.log(`✔ Signed by ${signed.author} (no gas spent). Saved to ${out}.\n  Anyone can submit it: npm run prov -- submit ${out} --chain ${chain.name}`);
      break;
    }

    case "submit": {
      const signed = JSON.parse(readFileSync(args[0], "utf8"));
      const r = await P.submitSigned(chain, key(), signed);
      console.log(`✔ Recorded ${r.id} for ${r.author}\n  ${explorerTx(r.tx)}`);
      break;
    }

    case "batch-get": {
      const b = await P.fetchLightBatch(chain, args[0]);
      const out = flag("out") || `batch-${b.batchId}.json`;
      writeFileSync(out, JSON.stringify(b, null, 2));
      console.log(`✔ Rebuilt batch #${b.batchId} from the chain: ${b.records.length} records by ${b.author} at ${new Date(b.timestamp * 1000).toISOString()}\n  Saved to ${out}`);
      break;
    }

    case "verify-light": {
      const receipt = JSON.parse(readFileSync(args[0], "utf8"));
      const only = args[1] ? P.resolveId(args[1]) : null;
      const recs = receipt.records.filter((r) => !only || r.id === only);
      if (!recs.length) throw new Error("No such record in that receipt");
      let ok = 0;
      for (const r of recs) {
        const v = await P.verifyLight(chain, receipt.batchId, r);
        if (v) ok++;
        console.log(`${v ? "✔" : "✘"} ${r.id}`);
      }
      console.log(`${ok}/${recs.length} verified against batch #${receipt.batchId}'s on-chain root.`);
      break;
    }

    case "promote": {
      const receipt = JSON.parse(readFileSync(args[0], "utf8"));
      const id = P.resolveId(args[1]);
      const rec = receipt.records.find((r) => r.id === id);
      if (!rec) throw new Error("That id isn't in the receipt");
      const r = await P.promote(chain, key(), receipt.batchId, rec);
      console.log(`✔ Promoted ${r.id} to a full record (original author and time kept)\n  ${explorerTx(r.tx)}`);
      break;
    }

    case "stats": {
      const s = await P.stats(chain);
      console.log(`\n  ProvenanceGraph on ${s.chain}\n  contract   ${s.contract}\n  records    ${s.records} full\n  batches    ${s.lightBatches} light\n  ERC-8004   ${/^0x0+$/.test(s.identityRegistry) ? "agent checks off" : s.identityRegistry}\n`);
      break;
    }

    default:
      console.error(`Usage: npm run prov -- <command> … [--chain base|base-sepolia|local]
  hash <file>                       record <file|hash> [--parent X]… [--kind K] [--meta JSON]
  pipeline <manifest.json> [--light] trace <file|hash>      children <file|hash>
  check <ancestor> <descendant>     sign <file|hash> …    submit <signed.json>
  batch-get <id>   verify-light <receipt.json> [id]   promote <receipt.json> <id>   stats`);
      process.exit(1);
  }
} catch (err) {
  console.error(`Error: ${explain(err)}`);
  process.exit(1);
}

