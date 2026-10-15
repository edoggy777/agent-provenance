// Compiles the contracts with solc-js (no compiler download needed).
//   npm run compile
// Writes src/artifact.json (ProvenanceGraph) and test/mocks.json (test-only contracts).
const fs = require("fs"), path = require("path"), solc = require("solc");
const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const input = {
  language: "Solidity",
  sources: {
    "ProvenanceGraph.sol": { content: read("contracts/ProvenanceGraph.sol") },
    "Mocks.sol": { content: read("test/contracts/Mocks.sol") },
  },
  settings: {
    evmVersion: "shanghai",
    viaIR: true,
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
  },
};
const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (out.errors || []).filter((e) => e.severity === "error");
for (const w of (out.errors || []).filter((e) => e.severity !== "error")) console.warn(w.formattedMessage);
if (errors.length) {
  console.error(errors.map((e) => e.formattedMessage).join("\n"));
  process.exit(1);
}
const art = (file, name) => {
  const c = out.contracts[file][name];
  return { abi: c.abi, bytecode: "0x" + c.evm.bytecode.object };
};
fs.writeFileSync(path.join(root, "src/artifact.json"), JSON.stringify(art("ProvenanceGraph.sol", "ProvenanceGraph"), null, 2));
fs.writeFileSync(
  path.join(root, "test/mocks.json"),
  JSON.stringify({ MockIdentityRegistry: art("Mocks.sol", "MockIdentityRegistry"), MockSmartWallet: art("Mocks.sol", "MockSmartWallet") })
);
const size = (art("ProvenanceGraph.sol", "ProvenanceGraph").bytecode.length - 2) / 2;
console.log(`Compiled ProvenanceGraph (${size} bytes) -> src/artifact.json`);
