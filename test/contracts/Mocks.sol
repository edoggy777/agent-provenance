// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Test-only stand-in for the ERC-8004 Identity Registry (ownerOf + getAgentWallet).
contract MockIdentityRegistry {
    mapping(uint256 => address) public ownerOf;
    mapping(uint256 => address) public getAgentWallet;

    function set(uint256 agentId, address owner_, address wallet_) external {
        ownerOf[agentId] = owner_;
        getAgentWallet[agentId] = wallet_;
    }
}

/// Test-only smart-contract wallet: accepts signatures made by its `signer` key (ERC-1271).
contract MockSmartWallet {
    address public signer;

    constructor(address signer_) {
        signer = signer_;
    }

    function isValidSignature(bytes32 hash, bytes calldata sig) external view returns (bytes4) {
        if (sig.length != 65) return 0xffffffff;
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        return ecrecover(hash, v, r, s) == signer ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}
