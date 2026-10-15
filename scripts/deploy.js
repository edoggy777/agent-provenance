// Deploys ProvenanceGraph and saves its address to deployments.json.
//
//   npm run deploy -- local                                   (built-in test key)
//   DEPLOYER_PRIVATE_KEY=0x... npm run deploy -- base
//
// The contract has no owner and no fees; the deployer gets no special powers.
// By default it checks agentId claims against the chain's ERC-8004 Identity Registry.
// Override with IDENTITY_REGISTRY=0x... (or 0x0000000000000000000000000000000000000000 to disable).

import { getChain, artifact, publicClient, walletClient, saveDeployment } from "../src/provenance.js";

const name = process.argv[2] || "local";
const chain = getChain(name);
const LOCAL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // hardhat #0, local only
const key = process.env.DEPLOYER_PRIVATE_KEY || (name === "local" ? LOCAL_KEY : null);
if (!key) {
  console.error(`Set DEPLOYER_PRIVATE_KEY to deploy on ${name}.`);
  process.exit(1);
}
const registry = process.env.IDENTITY_REGISTRY || chain.identityRegistry || "0x0000000000000000000000000000000000000000";

const wallet = walletClient(chain, key);
console.log(`Deploying ProvenanceGraph to ${name} from ${wallet.account.address}...`);
const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args: [registry] });
const receipt = await publicClient(chain).waitForTransactionReceipt({ hash });
saveDeployment(name, { address: receipt.contractAddress, block: receipt.blockNumber.toString(), identityRegistry: registry });
console.log(`ProvenanceGraph deployed at ${receipt.contractAddress}  (gas ${receipt.gasUsed})`);
console.log(`ERC-8004 agent checks: ${/^0x0+$/.test(registry) ? "off" : registry}`);
if (chain.explorer) console.log(`${chain.explorer}/address/${receipt.contractAddress}`);
