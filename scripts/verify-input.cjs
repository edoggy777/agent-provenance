const fs = require("fs"), path = require("path");
const root = path.join(__dirname, "..");
const input = {
  language: "Solidity",
  sources: { "ProvenanceGraph.sol": { content: fs.readFileSync(path.join(root, "contracts/ProvenanceGraph.sol"), "utf8") } },
  settings: {
    evmVersion: "shanghai",
    viaIR: true,
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { "*": { "*": ["abi", "evm.bytecode", "evm.deployedBytecode", "metadata"] } },
  },
};
fs.writeFileSync(path.join(root, "basescan-verify.json"), JSON.stringify(input, null, 2));
console.log("Wrote basescan-verify.json");
