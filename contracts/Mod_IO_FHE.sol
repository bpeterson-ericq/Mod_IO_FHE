pragma solidity ^0.8.24;
import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract ModIOFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    error NotOwner();
    error NotProvider();
    error Paused();
    error InvalidBatch();
    error RateLimited();
    error StaleWrite();
    error ReplayAttempt();
    error InvalidStateHash();
    error BatchFull();
    error BatchNotOpen();
    error InvalidRequest();

    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event Paused(address indexed account);
    event Unpaused(address indexed account);
    event CooldownUpdated(uint256 oldInterval, uint256 newInterval);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event ModSubmitted(address indexed submitter, uint256 indexed batchId, bytes32 indexed modId);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId, bytes32 stateHash);
    event DecryptionComplete(uint256 indexed requestId, uint256 indexed batchId, uint256 totalScore);
    event RateLimitTriggered(address indexed caller, string action);

    bool public paused;
    uint256 public constant MIN_INTERVAL = 5 seconds;
    uint256 public cooldownInterval = 30 seconds;
    uint256 public currentBatchId;
    uint256 public modelVersion;
    uint256 public maxBatchSize = 100;

    mapping(address => bool) public isProvider;
    mapping(address => uint256) public lastSubmissionAt;
    mapping(address => uint256) public lastRequestAt;
    mapping(uint256 => Batch) public batches;
    mapping(uint256 => DecryptionContext) public decryptionContexts;
    mapping(bytes32 => euint32) public encryptedScores;
    mapping(bytes32 => address) public modSubmitters;
    mapping(bytes32 => uint256) public modBatchIds;

    struct Batch {
        bool isOpen;
        uint256 modCount;
        bytes32[] modIds;
        euint32 encryptedAggregate;
    }

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
        address requester;
    }

    modifier onlyOwner() {
        if (msg.sender != owner()) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier rateLimited(bytes32 action) {
        uint256 currentTime = block.timestamp;
        if (action == "submit") {
            if (currentTime - lastSubmissionAt[msg.sender] < cooldownInterval) {
                revert RateLimited();
            }
            lastSubmissionAt[msg.sender] = currentTime;
        } else if (action == "request") {
            if (currentTime - lastRequestAt[msg.sender] < cooldownInterval) {
                revert RateLimited();
            }
            lastRequestAt[msg.sender] = currentTime;
        }
        _;
    }

    function initialize() external initializer {
        __SepoliaConfig_init();
        isProvider[owner()] = true;
        modelVersion = 1;
        currentBatchId = 1;
        _openBatch(currentBatchId);
    }

    function setCooldownInterval(uint256 newInterval) external onlyOwner {
        require(newInterval >= MIN_INTERVAL, "Interval too small");
        uint256 oldInterval = cooldownInterval;
        cooldownInterval = newInterval;
        emit CooldownUpdated(oldInterval, newInterval);
    }

    function setMaxBatchSize(uint256 newSize) external onlyOwner {
        require(newSize > 0, "Invalid size");
        maxBatchSize = newSize;
    }

    function pause() external onlyOwner whenNotPaused {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        require(paused, "Not paused");
        paused = false;
        emit Unpaused(msg.sender);
    }

    function addProvider(address provider) external onlyOwner {
        isProvider[provider] = true;
        emit ProviderAdded(provider);
    }

    function removeProvider(address provider) external onlyOwner {
        isProvider[provider] = false;
        emit ProviderRemoved(provider);
    }

    function openBatch() external onlyOwner {
        currentBatchId++;
        _openBatch(currentBatchId);
    }

    function closeBatch(uint256 batchId) external onlyOwner {
        Batch storage batch = batches[batchId];
        if (!batch.isOpen) revert InvalidBatch();
        batch.isOpen = false;
        emit BatchClosed(batchId);
    }

    function submitEncryptedMod(bytes32 modId, euint32 encryptedScore) external onlyProvider whenNotPaused rateLimited("submit") {
        if (modSubmitters[modId] != address(0)) revert StaleWrite();
        if (!batches[currentBatchId].isOpen) revert BatchNotOpen();

        Batch storage batch = batches[currentBatchId];
        if (batch.modCount >= maxBatchSize) revert BatchFull();

        modSubmitters[modId] = msg.sender;
        modBatchIds[modId] = currentBatchId;
        encryptedScores[modId] = encryptedScore;
        batch.modIds.push(modId);
        batch.modCount++;

        emit ModSubmitted(msg.sender, currentBatchId, modId);
    }

    function requestBatchDecryption(uint256 batchId) external whenNotPaused rateLimited("request") {
        Batch storage batch = batches[batchId];
        if (batch.modCount == 0) revert InvalidBatch();

        euint32 memory aggregate = _initIfNeeded(batch.encryptedAggregate);
        for (uint i = 0; i < batch.modIds.length; i++) {
            bytes32 modId = batch.modIds[i];
            euint32 memory score = encryptedScores[modId];
            _requireInitialized(score, "score");
            aggregate = FHE.add(aggregate, score);
        }

        bytes32[] memory cts = new bytes32[](1);
        cts[0] = FHE.toBytes32(aggregate);
        bytes32 stateHash = _hashCiphertexts(cts);

        uint256 requestId = FHE.requestDecryption(cts, this.handleDecryptionCallback.selector);
        decryptionContexts[requestId] = DecryptionContext({
            batchId: batchId,
            stateHash: stateHash,
            processed: false,
            requester: msg.sender
        });

        emit DecryptionRequested(requestId, batchId, stateHash);
    }

    function handleDecryptionCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        if (decryptionContexts[requestId].processed) revert ReplayAttempt();

        DecryptionContext storage ctx = decryptionContexts[requestId];
        Batch storage batch = batches[ctx.batchId];

        euint32 memory currentAggregate = _initIfNeeded(batch.encryptedAggregate);
        bytes32[] memory currentCts = new bytes32[](1);
        currentCts[0] = FHE.toBytes32(currentAggregate);
        bytes32 currentStateHash = _hashCiphertexts(currentCts);

        if (currentStateHash != ctx.stateHash) revert InvalidStateHash();
        FHE.checkSignatures(requestId, cleartexts, proof);

        uint256 totalScore = abi.decode(cleartexts, (uint256));
        ctx.processed = true;
        emit DecryptionComplete(requestId, ctx.batchId, totalScore);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 x) internal pure returns (euint32 memory) {
        if (!FHE.isInitialized(x)) {
            return FHE.asEuint32(0);
        }
        return x;
    }

    function _requireInitialized(euint32 x, string memory tag) internal pure {
        if (!FHE.isInitialized(x)) {
            revert(string(abi.encodePacked(tag, " not initialized")));
        }
    }

    function _openBatch(uint256 batchId) private {
        batches[batchId] = Batch({
            isOpen: true,
            modCount: 0,
            modIds: new bytes32[](0),
            encryptedAggregate: FHE.asEuint32(0)
        });
        emit BatchOpened(batchId);
    }
}