// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ProvenanceGraph
/// @notice An on-chain family tree for AI outputs. Each record is the hash of a piece of content
///         (a source, an intermediate step, a final output, a review) plus links to the records it
///         was made from. Anyone can trace where a result came from, who produced each step and when.
/// @dev    No owner, no fees, no admin, no upgrades. Nothing in this contract can be changed by anyone
///         after deployment, and it never holds money.
///
///         Two ways to record:
///         - FULL records (record / recordMany / recordSigned): stored in contract state, so other
///           contracts can read them, parents must already exist, and each id can be recorded once.
///         - LIGHT batches (recordBatchLight): only a Merkle root is stored; every record's data is
///           still published on-chain in event logs. Much cheaper per record. Any light record can
///           later be proven against its root, or promoted to a full record.
contract ProvenanceGraph {
    // ------------------------------------------------------------------ types

    /// Kinds are a convention for readers; the contract treats them all the same.
    uint8 public constant KIND_SOURCE = 0; // external data an agent used (web page, file, dataset)
    uint8 public constant KIND_STEP = 1; // an intermediate result
    uint8 public constant KIND_OUTPUT = 2; // a final deliverable
    uint8 public constant KIND_REVIEW = 3; // a review/endorsement of its parent(s)

    uint256 public constant MAX_PARENTS = 32;
    uint256 public constant MAX_META_BYTES = 1024;
    uint256 public constant MAX_BATCH = 512;

    struct RecordInput {
        bytes32 id; // hash of the content (we use SHA-256 of the exact bytes)
        bytes32[] parents; // ids this content was derived from
        uint8 kind;
        uint256 agentId; // ERC-8004 agent id of the author, or 0
        string meta; // free-form JSON: model, tool, prompt hash, URL… (emitted, not stored)
    }

    struct Record {
        address author;
        uint64 timestamp;
        uint64 blockNumber;
        uint8 kind;
        uint256 agentId;
        uint256 batchId; // 0 if recorded directly; otherwise the light batch it was promoted from
        bytes32[] parents;
    }

    struct Batch {
        bytes32 root;
        address author;
        uint64 timestamp;
        uint64 blockNumber;
        uint32 count;
    }

    // ------------------------------------------------------------------ storage

    mapping(bytes32 => Record) private _records;
    mapping(bytes32 => bytes32[]) private _children;
    mapping(uint256 => Batch) private _batches;
    uint256 public batchCount;
    uint256 public recordCount;

    /// ERC-8004 Identity Registry used to check agentId claims (address(0) disables the check).
    address public immutable identityRegistry;

    // EIP-712
    bytes32 private constant _DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant RECORD_TYPEHASH =
        keccak256("Record(bytes32 id,bytes32[] parents,uint8 kind,uint256 agentId,string meta)");
    bytes32 private immutable _domainSeparator;
    uint256 private immutable _chainId;

    // ------------------------------------------------------------------ events

    event Recorded(bytes32 indexed id, address indexed author, uint256 indexed agentId, uint8 kind, bytes32[] parents, string meta);
    event BatchRecorded(uint256 indexed batchId, address indexed author, bytes32 root, uint32 count);
    /// One per record in a light batch: the full record data, permanently in the chain's logs.
    event LightRecord(uint256 indexed batchId, bytes32 indexed id, uint256 indexed agentId, uint8 kind, bytes32[] parents, string meta, uint32 index);
    event Promoted(bytes32 indexed id, uint256 indexed batchId);

    // ------------------------------------------------------------------ errors

    error AlreadyRecorded(bytes32 id);
    error UnknownParent(bytes32 parent);
    error SelfParent(bytes32 id);
    error DuplicateParent(bytes32 parent);
    error EmptyId();
    error TooManyParents();
    error MetaTooLong();
    error BadBatchSize();
    error NotAgentController(uint256 agentId, address author);
    error BadSignature();
    error UnknownBatch(uint256 batchId);
    error NotInBatch();

    constructor(address identityRegistry_) {
        identityRegistry = identityRegistry_;
        _chainId = block.chainid;
        _domainSeparator = _buildDomainSeparator();
    }

    // ================================================================== FULL records

    /// @notice Record one piece of content as yourself.
    function record(RecordInput calldata r) external {
        _storeRecord(r, msg.sender, 0, uint64(block.timestamp), uint64(block.number));
    }

    /// @notice Record several in one transaction. Parents can point to records earlier in the same list.
    function recordMany(RecordInput[] calldata rs) external {
        if (rs.length == 0 || rs.length > MAX_BATCH) revert BadBatchSize();
        for (uint256 i = 0; i < rs.length; i++) {
            _storeRecord(rs[i], msg.sender, 0, uint64(block.timestamp), uint64(block.number));
        }
    }

    /// @notice Record on behalf of `author`, who signed the record (EIP-712). Lets an agent with no
    ///         gas have anyone submit for it. Works for normal wallets and smart wallets (ERC-1271).
    ///         Replays are impossible: an id can only be recorded once.
    function recordSigned(RecordInput calldata r, address author, bytes calldata signature) external {
        if (!_isValidSignature(author, hashRecord(r), signature)) revert BadSignature();
        _storeRecord(r, author, 0, uint64(block.timestamp), uint64(block.number));
    }

    // ================================================================== LIGHT batches

    /// @notice Publish many records cheaply. Stores only a Merkle root; each record is emitted in a
    ///         LightRecord event. Parents are NOT checked and ids are NOT de-duplicated against other
    ///         batches (that would need storage); the earliest proven record wins when it matters.
    /// @return batchId the new batch's id (starts at 1)
    function recordBatchLight(RecordInput[] calldata rs) external returns (uint256 batchId) {
        uint256 n = rs.length;
        if (n == 0 || n > MAX_BATCH) revert BadBatchSize();
        batchId = ++batchCount;
        bytes32[] memory layer = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) {
            _checkShape(rs[i]);
            _checkAgent(rs[i].agentId, msg.sender);
            layer[i] = leafHash(rs[i], msg.sender);
            emit LightRecord(batchId, rs[i].id, rs[i].agentId, rs[i].kind, rs[i].parents, rs[i].meta, uint32(i));
        }
        bytes32 root = _merkleRoot(layer);
        _batches[batchId] = Batch(root, msg.sender, uint64(block.timestamp), uint64(block.number), uint32(n));
        emit BatchRecorded(batchId, msg.sender, root, uint32(n));
    }

    /// @notice True if `r` is part of light batch `batchId` (proof from the off-chain helper).
    function verifyLight(uint256 batchId, RecordInput calldata r, bytes32[] calldata proof) public view returns (bool) {
        Batch storage b = _batches[batchId];
        if (b.root == bytes32(0)) return false;
        return _processProof(proof, leafHash(r, b.author)) == b.root;
    }

    /// @notice Turn a light record into a full record, keeping the batch's original author and time.
    ///         Its parents must already be full records (promote them first if needed).
    function promote(uint256 batchId, RecordInput calldata r, bytes32[] calldata proof) external {
        Batch storage b = _batches[batchId];
        if (b.root == bytes32(0)) revert UnknownBatch(batchId);
        if (!verifyLight(batchId, r, proof)) revert NotInBatch();
        _storeRecord(r, b.author, batchId, b.timestamp, b.blockNumber);
        emit Promoted(r.id, batchId);
    }

    // ================================================================== reading (free)

    function exists(bytes32 id) public view returns (bool) {
        return _records[id].timestamp != 0;
    }

    function getRecord(bytes32 id) external view returns (Record memory) {
        return _records[id];
    }

    function parentsOf(bytes32 id) external view returns (bytes32[] memory) {
        return _records[id].parents;
    }

    function childCount(bytes32 id) external view returns (uint256) {
        return _children[id].length;
    }

    /// @notice Records that were made from `id` (paged).
    function childrenOf(bytes32 id, uint256 offset, uint256 limit) external view returns (bytes32[] memory page) {
        bytes32[] storage all = _children[id];
        if (offset >= all.length) return new bytes32[](0);
        uint256 end = offset + limit > all.length ? all.length : offset + limit;
        page = new bytes32[](end - offset);
        for (uint256 i = offset; i < end; i++) page[i - offset] = all[i];
    }

    function getBatch(uint256 batchId) external view returns (Batch memory) {
        return _batches[batchId];
    }

    /// @notice Was `ancestor` used (directly or indirectly) to make `descendant`?
    ///         Walks the graph upward, visiting at most `maxNodes` records.
    /// @return found true if reached; complete false if the walk stopped early at maxNodes
    function isAncestor(bytes32 ancestor, bytes32 descendant, uint256 maxNodes) external view returns (bool found, bool complete) {
        if (maxNodes == 0) return (false, false);
        bytes32[] memory queue = new bytes32[](maxNodes);
        uint256 head;
        uint256 tail;
        queue[tail++] = descendant;
        while (head < tail) {
            bytes32[] storage ps = _records[queue[head++]].parents;
            for (uint256 i = 0; i < ps.length; i++) {
                if (ps[i] == ancestor) return (true, true);
                bool seen;
                for (uint256 j = 0; j < tail; j++) {
                    if (queue[j] == ps[i]) {
                        seen = true;
                        break;
                    }
                }
                if (seen) continue;
                if (tail == maxNodes) return (false, false);
                queue[tail++] = ps[i];
            }
        }
        return (false, true);
    }

    /// @notice EIP-712 digest an author signs for recordSigned.
    function hashRecord(RecordInput calldata r) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(RECORD_TYPEHASH, r.id, keccak256(abi.encodePacked(r.parents)), r.kind, r.agentId, keccak256(bytes(r.meta)))
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function domainSeparator() public view returns (bytes32) {
        return block.chainid == _chainId ? _domainSeparator : _buildDomainSeparator();
    }

    /// @notice Merkle leaf for a light record (double-hashed, as in OpenZeppelin's MerkleProof).
    function leafHash(RecordInput calldata r, address author) public pure returns (bytes32) {
        return keccak256(
            bytes.concat(keccak256(abi.encode(r.id, keccak256(abi.encodePacked(r.parents)), r.kind, r.agentId, keccak256(bytes(r.meta)), author)))
        );
    }

    // ================================================================== internal

    function _storeRecord(RecordInput calldata r, address author, uint256 batchId, uint64 ts, uint64 bn) internal {
        _checkShape(r);
        if (exists(r.id)) revert AlreadyRecorded(r.id);
        _checkAgent(r.agentId, author);
        for (uint256 i = 0; i < r.parents.length; i++) {
            bytes32 p = r.parents[i];
            if (p == r.id) revert SelfParent(p);
            if (!exists(p)) revert UnknownParent(p);
            for (uint256 j = 0; j < i; j++) if (r.parents[j] == p) revert DuplicateParent(p);
        }
        Record storage s = _records[r.id];
        s.author = author;
        s.timestamp = ts;
        s.blockNumber = bn;
        s.kind = r.kind;
        s.agentId = r.agentId;
        s.batchId = batchId;
        for (uint256 i = 0; i < r.parents.length; i++) {
            s.parents.push(r.parents[i]);
            _children[r.parents[i]].push(r.id);
        }
        recordCount++;
        emit Recorded(r.id, author, r.agentId, r.kind, r.parents, r.meta);
    }

    function _checkShape(RecordInput calldata r) internal pure {
        if (r.id == bytes32(0)) revert EmptyId();
        if (r.parents.length > MAX_PARENTS) revert TooManyParents();
        if (bytes(r.meta).length > MAX_META_BYTES) revert MetaTooLong();
    }

    /// If an agentId is claimed, the author must own that agent or be its registered wallet.
    function _checkAgent(uint256 agentId, address author) internal view {
        if (agentId == 0 || identityRegistry == address(0)) return;
        if (_callAddress(abi.encodeWithSignature("ownerOf(uint256)", agentId)) == author) return;
        if (_callAddress(abi.encodeWithSignature("getAgentWallet(uint256)", agentId)) == author) return;
        revert NotAgentController(agentId, author);
    }

    function _callAddress(bytes memory data) internal view returns (address a) {
        (bool ok, bytes memory ret) = identityRegistry.staticcall(data);
        if (ok && ret.length >= 32) a = abi.decode(ret, (address));
    }

    /// Builds a Merkle root with sorted-pair hashing; an odd node at the end of a layer moves up unchanged.
    function _merkleRoot(bytes32[] memory layer) internal pure returns (bytes32) {
        uint256 n = layer.length;
        while (n > 1) {
            uint256 m = (n + 1) / 2;
            for (uint256 i = 0; i < n / 2; i++) layer[i] = _hashPair(layer[2 * i], layer[2 * i + 1]);
            if (n % 2 == 1) layer[m - 1] = layer[n - 1];
            n = m;
        }
        return layer[0];
    }

    function _processProof(bytes32[] calldata proof, bytes32 leaf) internal pure returns (bytes32 h) {
        h = leaf;
        for (uint256 i = 0; i < proof.length; i++) h = _hashPair(h, proof[i]);
    }

    function _hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function _isValidSignature(address signer, bytes32 digest, bytes calldata sig) internal view returns (bool) {
        if (signer == address(0)) return false;
        if (signer.code.length > 0) {
            // Smart-contract wallet (ERC-1271)
            (bool ok, bytes memory ret) =
                signer.staticcall(abi.encodeWithSignature("isValidSignature(bytes32,bytes)", digest, sig));
            return ok && ret.length >= 32 && abi.decode(ret, (bytes4)) == 0x1626ba7e;
        }
        if (sig.length != 65) return false;
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;
        // Reject malleable signatures (upper-half s), as in OpenZeppelin ECDSA.
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) return false;
        address recovered = ecrecover(digest, v, r, s);
        return recovered != address(0) && recovered == signer;
    }

    function _buildDomainSeparator() private view returns (bytes32) {
        return keccak256(abi.encode(_DOMAIN_TYPEHASH, keccak256("ProvenanceGraph"), keccak256("1"), block.chainid, address(this)));
    }
}
