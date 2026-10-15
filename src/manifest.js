// A manifest describes a whole pipeline in one JSON file, so an agent can record
// everything it did in one go:
//
// {
//   "agentId": 0,                       // optional default for every record
//   "records": [
//     { "name": "paper", "file": "sources/paper.pdf", "kind": "source", "meta": { "url": "https://…" } },
//     { "name": "notes", "file": "notes.md", "kind": "step", "parents": ["paper"], "meta": { "model": "…" } },
//     { "name": "report", "file": "report.md", "kind": "output", "parents": ["notes", "0xabc…"] }
//   ]
// }
//
// Each record's content comes from "file" (path relative to the manifest), "text" (inline) or "id" (a hash).
// Parents can be another record's "name", a file path, or a hash. Records are put in dependency
// order automatically.

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { sha256, normalizeHash } from "./provenance.js";

export function loadManifest(path) {
  const base = dirname(resolve(path));
  const m = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(m.records) || !m.records.length) throw new Error("Manifest needs a non-empty \"records\" array");

  const byName = new Map();
  const items = m.records.map((r, i) => {
    let id;
    if (r.id) id = normalizeHash(r.id);
    else if (r.text != null) id = sha256(String(r.text));
    else if (r.file) {
      const f = resolve(base, r.file);
      if (!existsSync(f)) throw new Error(`Record ${i}: file not found: ${r.file}`);
      id = sha256(readFileSync(f));
    }
    if (!id) throw new Error(`Record ${i}: needs "file", "text" or "id"`);
    const item = { name: r.name ?? r.file ?? id, id, kind: r.kind ?? "output", agentId: r.agentId ?? m.agentId ?? 0, meta: r.meta ?? "", parentRefs: r.parents ?? [] };
    if (r.name) {
      if (byName.has(r.name)) throw new Error(`Duplicate record name "${r.name}"`);
      byName.set(r.name, item);
    }
    return item;
  });

  const resolveRef = (ref) => {
    if (byName.has(ref)) return byName.get(ref).id;
    const f = resolve(base, ref);
    if (existsSync(f)) return sha256(readFileSync(f));
    const h = normalizeHash(ref);
    if (h) return h;
    throw new Error(`Unknown parent "${ref}" (not a record name, file or hash)`);
  };
  for (const it of items) it.parents = it.parentRefs.map(resolveRef);

  // Topological sort: parents defined in this manifest come first.
  const idsHere = new Map(items.map((it) => [it.id, it]));
  const ordered = [];
  const state = new Map(); // 1 = visiting, 2 = done
  const visit = (it) => {
    if (state.get(it.id) === 2) return;
    if (state.get(it.id) === 1) throw new Error(`Cycle detected at "${it.name}"`);
    state.set(it.id, 1);
    for (const p of it.parents) if (idsHere.has(p)) visit(idsHere.get(p));
    state.set(it.id, 2);
    ordered.push(it);
  };
  items.forEach(visit);
  return ordered.map(({ name, id, parents, kind, agentId, meta }) => ({ name, id, parents, kind, agentId, meta }));
}
