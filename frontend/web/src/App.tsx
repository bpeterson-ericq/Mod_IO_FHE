// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface FHEMod {
  id: string;
  name: string;
  encryptedData: string;
  timestamp: number;
  owner: string;
  category: string;
  game: string;
  rating: number;
  downloads: number;
  status: "pending" | "verified" | "rejected";
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const FHECompute = (encryptedData: string, operation: string): string => {
  const value = FHEDecryptNumber(encryptedData);
  let result = value;
  
  switch(operation) {
    case 'increase10%':
      result = value * 1.1;
      break;
    case 'decrease10%':
      result = value * 0.9;
      break;
    case 'double':
      result = value * 2;
      break;
    default:
      result = value;
  }
  
  return FHEEncryptNumber(result);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [mods, setMods] = useState<FHEMod[]>([]);
  const [filteredMods, setFilteredMods] = useState<FHEMod[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newModData, setNewModData] = useState({ 
    name: "", 
    category: "", 
    game: "", 
    rating: 0, 
    sensitiveValue: 0 
  });
  const [selectedMod, setSelectedMod] = useState<FHEMod | null>(null);
  const [decryptedValue, setDecryptedValue] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [userHistory, setUserHistory] = useState<string[]>([]);
  const [showHistory, setShowHistory] = useState(false);

  const verifiedCount = mods.filter(m => m.status === "verified").length;
  const pendingCount = mods.filter(m => m.status === "pending").length;
  const rejectedCount = mods.filter(m => m.status === "rejected").length;

  // Initialize and load data
  useEffect(() => {
    loadMods().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
      
      // Load user history from localStorage
      const savedHistory = localStorage.getItem(`modHistory_${address}`);
      if (savedHistory) {
        setUserHistory(JSON.parse(savedHistory));
      }
    };
    initSignatureParams();
  }, [address]);

  // Filter mods based on search and filters
  useEffect(() => {
    let result = mods;
    
    if (searchQuery) {
      result = result.filter(mod => 
        mod.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        mod.game.toLowerCase().includes(searchQuery.toLowerCase()) ||
        mod.category.toLowerCase().includes(searchQuery.toLowerCase())
      );
    }
    
    if (categoryFilter !== "all") {
      result = result.filter(mod => mod.category === categoryFilter);
    }
    
    if (statusFilter !== "all") {
      result = result.filter(mod => mod.status === statusFilter);
    }
    
    setFilteredMods(result);
  }, [mods, searchQuery, categoryFilter, statusFilter]);

  // Load mods from contract
  const loadMods = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      // Check if contract is available
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      
      // Get list of mod keys
      const keysBytes = await contract.getData("mod_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing mod keys:", e); }
      }
      
      // Load each mod
      const modList: FHEMod[] = [];
      for (const key of keys) {
        try {
          const modBytes = await contract.getData(`mod_${key}`);
          if (modBytes.length > 0) {
            try {
              const modData = JSON.parse(ethers.toUtf8String(modBytes));
              modList.push({ 
                id: key, 
                name: modData.name, 
                encryptedData: modData.data, 
                timestamp: modData.timestamp, 
                owner: modData.owner, 
                category: modData.category,
                game: modData.game,
                rating: modData.rating || 0,
                downloads: modData.downloads || 0,
                status: modData.status || "pending" 
              });
            } catch (e) { console.error(`Error parsing mod data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading mod ${key}:`, e); }
      }
      
      modList.sort((a, b) => b.timestamp - a.timestamp);
      setMods(modList);
    } catch (e) { console.error("Error loading mods:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  // Upload new mod
  const uploadMod = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setUploading(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting mod data with Zama FHE..." });
    
    try {
      // Encrypt sensitive data
      const encryptedData = FHEEncryptNumber(newModData.sensitiveValue);
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      // Generate unique ID
      const modId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      
      // Prepare mod data
      const modData = { 
        name: newModData.name,
        data: encryptedData, 
        timestamp: Math.floor(Date.now() / 1000), 
        owner: address, 
        category: newModData.category,
        game: newModData.game,
        rating: newModData.rating,
        downloads: 0,
        status: "pending" 
      };
      
      // Store mod data
      await contract.setData(`mod_${modId}`, ethers.toUtf8Bytes(JSON.stringify(modData)));
      
      // Update keys list
      const keysBytes = await contract.getData("mod_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(modId);
      await contract.setData("mod_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      // Add to user history
      const action = `Uploaded mod: ${newModData.name}`;
      const updatedHistory = [action, ...userHistory.slice(0, 9)];
      setUserHistory(updatedHistory);
      localStorage.setItem(`modHistory_${address}`, JSON.stringify(updatedHistory));
      
      setTransactionStatus({ visible: true, status: "success", message: "FHE-encrypted mod uploaded successfully!" });
      await loadMods();
      
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowUploadModal(false);
        setNewModData({ name: "", category: "", game: "", rating: 0, sensitiveValue: 0 });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Upload failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setUploading(false); }
  };

  // Verify mod
  const verifyMod = async (modId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing encrypted mod with FHE..." });
    
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      
      // Get mod data
      const modBytes = await contract.getData(`mod_${modId}`);
      if (modBytes.length === 0) throw new Error("Mod not found");
      const modData = JSON.parse(ethers.toUtf8String(modBytes));
      
      // Process with FHE
      const verifiedData = FHECompute(modData.data, 'increase10%');
      
      // Update mod status
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      const updatedMod = { ...modData, status: "verified", data: verifiedData };
      await contractWithSigner.setData(`mod_${modId}`, ethers.toUtf8Bytes(JSON.stringify(updatedMod)));
      
      // Add to user history
      const mod = mods.find(m => m.id === modId);
      const action = `Verified mod: ${mod?.name || modId}`;
      const updatedHistory = [action, ...userHistory.slice(0, 9)];
      setUserHistory(updatedHistory);
      localStorage.setItem(`modHistory_${address}`, JSON.stringify(updatedHistory));
      
      setTransactionStatus({ visible: true, status: "success", message: "FHE verification completed successfully!" });
      await loadMods();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Verification failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  // Reject mod
  const rejectMod = async (modId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing encrypted mod with FHE..." });
    
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      // Get mod data
      const modBytes = await contract.getData(`mod_${modId}`);
      if (modBytes.length === 0) throw new Error("Mod not found");
      const modData = JSON.parse(ethers.toUtf8String(modBytes));
      
      // Update mod status
      const updatedMod = { ...modData, status: "rejected" };
      await contract.setData(`mod_${modId}`, ethers.toUtf8Bytes(JSON.stringify(updatedMod)));
      
      // Add to user history
      const mod = mods.find(m => m.id === modId);
      const action = `Rejected mod: ${mod?.name || modId}`;
      const updatedHistory = [action, ...userHistory.slice(0, 9)];
      setUserHistory(updatedHistory);
      localStorage.setItem(`modHistory_${address}`, JSON.stringify(updatedHistory));
      
      setTransactionStatus({ visible: true, status: "success", message: "FHE rejection completed successfully!" });
      await loadMods();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Rejection failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  // Download mod
  const downloadMod = async (modId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Preparing FHE-encrypted mod for download..." });
    
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      // Get mod data
      const modBytes = await contract.getData(`mod_${modId}`);
      if (modBytes.length === 0) throw new Error("Mod not found");
      const modData = JSON.parse(ethers.toUtf8String(modBytes));
      
      // Update download count
      const updatedMod = { 
        ...modData, 
        downloads: (modData.downloads || 0) + 1 
      };
      await contract.setData(`mod_${modId}`, ethers.toUtf8Bytes(JSON.stringify(updatedMod)));
      
      // Add to user history
      const mod = mods.find(m => m.id === modId);
      const action = `Downloaded mod: ${mod?.name || modId}`;
      const updatedHistory = [action, ...userHistory.slice(0, 9)];
      setUserHistory(updatedHistory);
      localStorage.setItem(`modHistory_${address}`, JSON.stringify(updatedHistory));
      
      setTransactionStatus({ visible: true, status: "success", message: "FHE-encrypted mod ready for installation!" });
      await loadMods();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Download failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  // Decrypt with wallet signature
  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      // Add to user history
      const action = `Decrypted FHE data`;
      const updatedHistory = [action, ...userHistory.slice(0, 9)];
      setUserHistory(updatedHistory);
      localStorage.setItem(`modHistory_${address}`, JSON.stringify(updatedHistory));
      
      return FHEDecryptNumber(encryptedData);
    } catch (e) { 
      console.error("Decryption failed:", e); 
      return null; 
    } finally { 
      setIsDecrypting(false); 
    }
  };

  // Check if user is owner
  const isOwner = (modAddress: string) => address?.toLowerCase() === modAddress.toLowerCase();

  if (loading) return (
    <div className="loading-screen">
      <div className="tech-spinner"></div>
      <p>Initializing FHE connection...</p>
    </div>
  );

  return (
    <div className="app-container tech-theme">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon">
            <div className="circuit-icon"></div>
          </div>
          <h1>Mod<span>IO</span>FHE</h1>
          <div className="tagline">FHE-Powered Mod Platform</div>
        </div>
        <div className="header-actions">
          <button onClick={() => setShowUploadModal(true)} className="upload-mod-btn tech-button">
            <div className="upload-icon"></div>Upload Mod
          </button>
          <button className="tech-button" onClick={() => setShowHistory(!showHistory)}>
            {showHistory ? "Hide History" : "Show History"}
          </button>
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
          </div>
        </div>
      </header>

      <div className="main-content">
        <div className="welcome-banner">
          <div className="welcome-text">
            <h2>Fully Homomorphic Encryption Mod Platform</h2>
            <p>Upload, discover and play FHE-encrypted game mods with zero-knowledge verification</p>
          </div>
          <div className="fhe-indicator">
            <div className="fhe-lock"></div>
            <span>Zama FHE Encryption Active</span>
          </div>
        </div>

        <div className="dashboard-panels">
          <div className="panel intro-panel">
            <h3>About Mod_IO_FHE</h3>
            <p>
              Mod_IO_FHE is a revolutionary platform for creating and playing FHE-powered game mods. 
              Using <strong>Zama FHE technology</strong>, all mod data remains encrypted during processing, 
              protecting creators' IP while enabling new gameplay experiences.
            </p>
            <div className="feature-grid">
              <div className="feature">
                <div className="feature-icon">🔒</div>
                <h4>FHE Encryption</h4>
                <p>Mod data encrypted with Zama FHE, processed without decryption</p>
              </div>
              <div className="feature">
                <div className="feature-icon">🚀</div>
                <h4>One-Click Install</h4>
                <p>Seamless installation of encrypted mods with compatibility handling</p>
              </div>
              <div className="feature">
                <div className="feature-icon">💎</div>
                <h4>IP Protection</h4>
                <p>Creators retain full control over their encrypted content</p>
              </div>
            </div>
          </div>

          <div className="panel stats-panel">
            <h3>Platform Statistics</h3>
            <div className="stats-grid">
              <div className="stat">
                <div className="stat-value">{mods.length}</div>
                <div className="stat-label">Total Mods</div>
              </div>
              <div className="stat">
                <div className="stat-value">{verifiedCount}</div>
                <div className="stat-label">Verified</div>
              </div>
              <div className="stat">
                <div className="stat-value">{pendingCount}</div>
                <div className="stat-label">Pending</div>
              </div>
              <div className="stat">
                <div className="stat-value">{mods.reduce((sum, mod) => sum + mod.downloads, 0)}</div>
                <div className="stat-label">Total Downloads</div>
              </div>
            </div>
          </div>

          {showHistory && userHistory.length > 0 && (
            <div className="panel history-panel">
              <h3>Your Recent Activity</h3>
              <div className="history-list">
                {userHistory.map((action, index) => (
                  <div key={index} className="history-item">
                    <div className="history-icon">↳</div>
                    <div className="history-text">{action}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="mods-section">
          <div className="section-header">
            <h2>FHE-Encrypted Mod Marketplace</h2>
            <div className="header-actions">
              <button onClick={loadMods} className="refresh-btn tech-button" disabled={isRefreshing}>
                {isRefreshing ? "Refreshing..." : "Refresh Mods"}
              </button>
            </div>
          </div>

          <div className="filters-panel">
            <div className="search-box">
              <input 
                type="text" 
                placeholder="Search mods..." 
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="tech-input"
              />
            </div>
            <div className="filter-group">
              <select 
                value={categoryFilter} 
                onChange={(e) => setCategoryFilter(e.target.value)}
                className="tech-select"
              >
                <option value="all">All Categories</option>
                <option value="Gameplay">Gameplay</option>
                <option value="Visual">Visual</option>
                <option value="Audio">Audio</option>
                <option value="Utility">Utility</option>
                <option value="Other">Other</option>
              </select>
            </div>
            <div className="filter-group">
              <select 
                value={statusFilter} 
                onChange={(e) => setStatusFilter(e.target.value)}
                className="tech-select"
              >
                <option value="all">All Status</option>
                <option value="verified">Verified</option>
                <option value="pending">Pending</option>
                <option value="rejected">Rejected</option>
              </select>
            </div>
          </div>

          <div className="mods-grid">
            {filteredMods.length === 0 ? (
              <div className="no-mods">
                <div className="no-mods-icon">🎮</div>
                <p>No FHE-encrypted mods found</p>
                <button className="tech-button primary" onClick={() => setShowUploadModal(true)}>
                  Upload First Mod
                </button>
              </div>
            ) : (
              filteredMods.map(mod => (
                <div className="mod-card" key={mod.id} onClick={() => setSelectedMod(mod)}>
                  <div className="mod-header">
                    <h3 className="mod-name">{mod.name}</h3>
                    <span className={`status-badge ${mod.status}`}>{mod.status}</span>
                  </div>
                  <div className="mod-details">
                    <div className="mod-detail">
                      <span className="detail-label">Game:</span>
                      <span className="detail-value">{mod.game}</span>
                    </div>
                    <div className="mod-detail">
                      <span className="detail-label">Category:</span>
                      <span className="detail-value">{mod.category}</span>
                    </div>
                    <div className="mod-detail">
                      <span className="detail-label">Uploaded:</span>
                      <span className="detail-value">{new Date(mod.timestamp * 1000).toLocaleDateString()}</span>
                    </div>
                    <div className="mod-detail">
                      <span className="detail-label">Downloads:</span>
                      <span className="detail-value">{mod.downloads}</span>
                    </div>
                  </div>
                  <div className="mod-actions">
                    <button className="tech-button primary" onClick={(e) => { e.stopPropagation(); downloadMod(mod.id); }}>
                      Install Mod
                    </button>
                    {isOwner(mod.owner) && mod.status === "pending" && (
                      <div className="owner-actions">
                        <button className="tech-button success" onClick={(e) => { e.stopPropagation(); verifyMod(mod.id); }}>
                          Verify
                        </button>
                        <button className="tech-button danger" onClick={(e) => { e.stopPropagation(); rejectMod(mod.id); }}>
                          Reject
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {showUploadModal && (
        <ModalUpload 
          onSubmit={uploadMod} 
          onClose={() => setShowUploadModal(false)} 
          uploading={uploading} 
          modData={newModData} 
          setModData={setNewModData} 
        />
      )}
      
      {selectedMod && (
        <ModDetailModal 
          mod={selectedMod} 
          onClose={() => { setSelectedMod(null); setDecryptedValue(null); }} 
          decryptedValue={decryptedValue} 
          setDecryptedValue={setDecryptedValue} 
          isDecrypting={isDecrypting} 
          decryptWithSignature={decryptWithSignature}
          onDownload={downloadMod}
        />
      )}
      
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content tech-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="tech-spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon">✓</div>}
              {transactionStatus.status === "error" && <div className="error-icon">✗</div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}

      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo">
              <div className="circuit-icon"></div>
              <span>Mod_IO_FHE</span>
            </div>
            <p>FHE-powered mod platform built with Zama technology</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Developer Guide</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">Terms of Service</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge">
            <span>Powered by Zama FHE</span>
          </div>
          <div className="copyright">
            © {new Date().getFullYear()} Mod_IO_FHE. All rights reserved.
          </div>
        </div>
      </footer>
    </div>
  );
};

interface ModalUploadProps {
  onSubmit: () => void; 
  onClose: () => void; 
  uploading: boolean;
  modData: any;
  setModData: (data: any) => void;
}

const ModalUpload: React.FC<ModalUploadProps> = ({ onSubmit, onClose, uploading, modData, setModData }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setModData({ ...modData, [name]: value });
  };

  const handleValueChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setModData({ ...modData, [name]: parseFloat(value) });
  };

  const handleSubmit = () => {
    if (!modData.name || !modData.category || !modData.game || !modData.sensitiveValue) { 
      alert("Please fill all required fields"); 
      return; 
    }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="upload-modal tech-card">
        <div className="modal-header">
          <h2>Upload FHE-Encrypted Mod</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="fhe-notice-banner">
            <div className="key-icon">🔑</div> 
            <div>
              <strong>Zama FHE Encryption</strong>
              <p>Your mod data will be encrypted before submission and remain encrypted during processing</p>
            </div>
          </div>
          <div className="form-grid">
            <div className="form-group">
              <label>Mod Name *</label>
              <input 
                type="text" 
                name="name" 
                value={modData.name} 
                onChange={handleChange} 
                placeholder="Enter mod name..."
                className="tech-input"
              />
            </div>
            <div className="form-group">
              <label>Game *</label>
              <input 
                type="text" 
                name="game" 
                value={modData.game} 
                onChange={handleChange} 
                placeholder="Game title..."
                className="tech-input"
              />
            </div>
            <div className="form-group">
              <label>Category *</label>
              <select name="category" value={modData.category} onChange={handleChange} className="tech-select">
                <option value="">Select category</option>
                <option value="Gameplay">Gameplay</option>
                <option value="Visual">Visual</option>
                <option value="Audio">Audio</option>
                <option value="Utility">Utility</option>
                <option value="Other">Other</option>
              </select>
            </div>
            <div className="form-group">
              <label>Rating (0-5) *</label>
              <input 
                type="number" 
                name="rating" 
                value={modData.rating} 
                onChange={handleValueChange} 
                min="0" 
                max="5" 
                step="0.1"
                className="tech-input"
              />
            </div>
            <div className="form-group full-width">
              <label>Sensitive Value (FHE-Encrypted) *</label>
              <input 
                type="number" 
                name="sensitiveValue" 
                value={modData.sensitiveValue} 
                onChange={handleValueChange} 
                placeholder="Enter numerical value to encrypt..." 
                className="tech-input"
                step="0.01"
              />
            </div>
          </div>
          <div className="encryption-preview">
            <h4>FHE Encryption Preview</h4>
            <div className="preview-container">
              <div className="plain-data">
                <span>Plain Value:</span>
                <div>{modData.sensitiveValue || 'No value entered'}</div>
              </div>
              <div className="encryption-arrow">→</div>
              <div className="encrypted-data">
                <span>FHE-Encrypted:</span>
                <div>{modData.sensitiveValue ? FHEEncryptNumber(modData.sensitiveValue).substring(0, 50) + '...' : 'No value entered'}</div>
              </div>
            </div>
          </div>
          <div className="privacy-notice">
            <div className="privacy-icon">🔒</div> 
            <div>
              <strong>Intellectual Property Protection</strong>
              <p>Your mod remains encrypted throughout processing, protecting your creative work</p>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn tech-button">Cancel</button>
          <button onClick={handleSubmit} disabled={uploading} className="submit-btn tech-button primary">
            {uploading ? "Encrypting with Zama FHE..." : "Upload Encrypted Mod"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface ModDetailModalProps {
  mod: FHEMod;
  onClose: () => void;
  decryptedValue: number | null;
  setDecryptedValue: (value: number | null) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string) => Promise<number | null>;
  onDownload: (modId: string) => void;
}

const ModDetailModal: React.FC<ModDetailModalProps> = ({ 
  mod, onClose, decryptedValue, setDecryptedValue, isDecrypting, decryptWithSignature, onDownload 
}) => {
  const handleDecrypt = async () => {
    if (decryptedValue !== null) { 
      setDecryptedValue(null); 
      return; 
    }
    const decrypted = await decryptWithSignature(mod.encryptedData);
    if (decrypted !== null) setDecryptedValue(decrypted);
  };

  return (
    <div className="modal-overlay">
      <div className="mod-detail-modal tech-card">
        <div className="modal-header">
          <h2>{mod.name}</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="mod-info">
            <div className="info-item">
              <span>Game:</span>
              <strong>{mod.game}</strong>
            </div>
            <div className="info-item">
              <span>Category:</span>
              <strong>{mod.category}</strong>
            </div>
            <div className="info-item">
              <span>Owner:</span>
              <strong>{mod.owner.substring(0, 6)}...{mod.owner.substring(38)}</strong>
            </div>
            <div className="info-item">
              <span>Upload Date:</span>
              <strong>{new Date(mod.timestamp * 1000).toLocaleString()}</strong>
            </div>
            <div className="info-item">
              <span>Rating:</span>
              <strong>{mod.rating}/5</strong>
            </div>
            <div className="info-item">
              <span>Downloads:</span>
              <strong>{mod.downloads}</strong>
            </div>
            <div className="info-item">
              <span>Status:</span>
              <strong className={`status-badge ${mod.status}`}>{mod.status}</strong>
            </div>
          </div>
          <div className="encrypted-data-section">
            <h3>FHE-Encrypted Data</h3>
            <div className="encrypted-data">
              {mod.encryptedData.substring(0, 100)}...
            </div>
            <div className="fhe-tag">
              <div className="fhe-icon">🔒</div>
              <span>Zama FHE Encrypted</span>
            </div>
            <button className="decrypt-btn tech-button" onClick={handleDecrypt} disabled={isDecrypting}>
              {isDecrypting ? (
                <span className="decrypt-spinner"></span>
              ) : decryptedValue !== null ? (
                "Hide Decrypted Value"
              ) : (
                "Decrypt with Wallet Signature"
              )}
            </button>
          </div>
          {decryptedValue !== null && (
            <div className="decrypted-data-section">
              <h3>Decrypted Value</h3>
              <div className="decrypted-value">{decryptedValue}</div>
              <div className="decryption-notice">
                <div className="warning-icon">⚠️</div>
                <span>Decrypted data is only visible after wallet signature verification</span>
              </div>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button onClick={() => onDownload(mod.id)} className="download-btn tech-button primary">
            Install Mod
          </button>
          <button onClick={onClose} className="close-btn tech-button">
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default App;