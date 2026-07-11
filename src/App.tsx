import { useEffect, useRef, useState } from 'react';
import * as StellarSdk from '@stellar/stellar-sdk';
import WalletBank, { ContactEntry } from './WalletBank';
import {
  deriveKeypairFromPhoneAndPin,
  fundWithFriendbot,
  getNativeBalanceFromAccount,
  getErrorMessage,
  submitSponsoredTransaction,
  TESTNET_HORIZON_URL,
  TESTNET_NETWORK_PASSPHRASE,
  formatAddress,
  formatXlm,
} from './lib/stellar';

type ScreenState =
  | 'IDLE'
  | 'DIALING'
  | 'MENU'
  | 'BALANCE'
  | 'SEND_DEST'
  | 'SEND_AMOUNT'
  | 'CONFIRM_PIN'
  | 'TRANSMITTING'
  | 'SUCCESS'
  | 'ERROR';

type LogEntry = {
  id: string;
  text: string;
  type: 'info' | 'success' | 'warning' | 'error' | 'packet';
  time: string;
};

type UserProfile = {
  name: string;
  phone: string;
  pin: string;
  address: string;
};

export default function App() {
  // --- User Profile & Registration States ---
  const [isRegistered, setIsRegistered] = useState(false);
  const [regName, setRegName] = useState('');
  const [regPhone, setRegPhone] = useState('+254712345678');
  const [regPin, setRegPin] = useState('1234');
  const [regLoading, setRegLoading] = useState(false);
  const [regError, setRegError] = useState<string | null>(null);

  // --- Relayer / Sponsor States ---
  const [sponsorKeypair, setSponsorKeypair] = useState<StellarSdk.Keypair | null>(null);
  const [sponsorBalance, setSponsorBalance] = useState('0');
  const [sponsorLoading, setSponsorLoading] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const consoleEndRef = useRef<HTMLDivElement>(null);

  // --- Simulated Phone States ---
  const [currentScreen, setCurrentScreen] = useState<ScreenState>('IDLE');
  const [dialString, setDialString] = useState('');
  const [menuIndex, setMenuIndex] = useState(0);
  
  // Transaction flow inputs on phone
  const [phoneInput, setPhoneInput] = useState('');
  const [targetDest, setTargetDest] = useState('');
  const [targetName, setTargetName] = useState('');
  const [targetAmount, setTargetAmount] = useState('');
  const [phoneBalance, setPhoneBalance] = useState('0');
  const [phoneBalanceLoading, setPhoneBalanceLoading] = useState(false);

  const [lastTxHash, setLastTxHash] = useState('');
  const [lastError, setLastError] = useState('');

  // Auto-scroll logs
  useEffect(() => {
    consoleEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  // Add Log Helper
  const addLog = (text: string, type: 'info' | 'success' | 'warning' | 'error' | 'packet' = 'info') => {
    const time = new Date().toLocaleTimeString();
    setLogs((prev) => [...prev, { id: `${Date.now()}-${Math.random()}`, text, type, time }]);
  };

  // --- Load Profile & Sponsor on mount ---
  useEffect(() => {
    const loadProfileAndSponsor = async () => {
      // 1. Check existing user profile
      const storedProfile = localStorage.getItem('stellar-user-profile');
      if (storedProfile) {
        try {
          const profile = JSON.parse(storedProfile) as UserProfile;
          setRegName(profile.name);
          setRegPhone(profile.phone);
          setRegPin(profile.pin);
          setIsRegistered(true);
          addLog(`Restored active SIM profile: ${profile.name} (${profile.phone})`, 'info');
        } catch {
          localStorage.removeItem('stellar-user-profile');
        }
      }

      // 2. Initialize Sponsor Keypair
      setSponsorLoading(true);
      addLog('Initializing Gateway USSD Relayer...', 'info');

      let secret = localStorage.getItem('stellar-ussd-sponsor');
      let keypair: StellarSdk.Keypair;

      if (secret) {
        try {
          keypair = StellarSdk.Keypair.fromSecret(secret);
        } catch {
          keypair = StellarSdk.Keypair.random();
          localStorage.setItem('stellar-ussd-sponsor', keypair.secret());
        }
      } else {
        keypair = StellarSdk.Keypair.random();
        localStorage.setItem('stellar-ussd-sponsor', keypair.secret());
      }

      setSponsorKeypair(keypair);
      addLog(`Sponsor Account Key: ${formatAddress(keypair.publicKey())}`, 'info');

      const server = new StellarSdk.Horizon.Server(TESTNET_HORIZON_URL);
      try {
        const account = await server.loadAccount(keypair.publicKey());
        const bal = getNativeBalanceFromAccount(account);
        setSponsorBalance(bal);
        addLog(`Sponsor funded. Balance: ${formatXlm(bal)} XLM`, 'success');
      } catch {
        addLog('Sponsor account not found. Requesting testnet XLM from Friendbot...', 'warning');
        const funded = await fundWithFriendbot(keypair.publicKey());
        if (funded) {
          try {
            const account = await server.loadAccount(keypair.publicKey());
            const bal = getNativeBalanceFromAccount(account);
            setSponsorBalance(bal);
            addLog(`Sponsor funded successfully! Balance: ${formatXlm(bal)} XLM`, 'success');
          } catch (e) {
            addLog(`Failed to verify sponsor balance: ${getErrorMessage(e)}`, 'error');
          }
        } else {
          addLog('Friendbot failed to fund Sponsor. Please refresh or try again.', 'error');
        }
      }
      setSponsorLoading(false);
    };

    void loadProfileAndSponsor();
  }, []);

  // Compute active derived address based on profile details
  const activeKeypair = (regPhone && regPin.length === 4)
    ? deriveKeypairFromPhoneAndPin(regPhone, regPin)
    : null;
  const activeAddress = activeKeypair ? activeKeypair.publicKey() : '';

  // Load Phone balance
  const loadPhoneBalance = async (address: string) => {
    if (!address) return;
    setPhoneBalanceLoading(true);
    const server = new StellarSdk.Horizon.Server(TESTNET_HORIZON_URL);
    try {
      const account = await server.loadAccount(address);
      const bal = getNativeBalanceFromAccount(account);
      setPhoneBalance(bal);
    } catch {
      setPhoneBalance('0'); // Unactivated
    } finally {
      setPhoneBalanceLoading(false);
    }
  };

  useEffect(() => {
    if (isRegistered && activeAddress) {
      void loadPhoneBalance(activeAddress);
    }
  }, [isRegistered, activeAddress]);

  // --- Registration / Activation Handler ---
  const handleActivateSIM = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!regName.trim() || !regPhone.trim() || regPin.length !== 4) {
      setRegError('Please provide a Name, Phone Number, and 4-Digit PIN.');
      return;
    }

    setRegLoading(true);
    setRegError(null);

    const keypair = deriveKeypairFromPhoneAndPin(regPhone, regPin);
    const address = keypair.publicKey();

    addLog(`Creating SIM card profile for ${regName}...`, 'info');
    addLog(`Derived Stellar address: ${formatAddress(address)}`, 'info');

    // Check if account already exists to avoid Friendbot 400 error
    const server = new StellarSdk.Horizon.Server(TESTNET_HORIZON_URL);
    let accountExists = false;
    try {
      await server.loadAccount(address);
      accountExists = true;
      addLog('SIM address is already active on-chain.', 'info');
    } catch {
      // 404 is normal for unactivated accounts
    }

    let success = true;
    if (!accountExists) {
      addLog('SIM is inactive. Requesting testnet XLM activation via Friendbot...', 'warning');
      success = await fundWithFriendbot(address);
    }

    if (success) {
      const profile: UserProfile = {
        name: regName.trim(),
        phone: regPhone.trim(),
        pin: regPin,
        address,
      };

      localStorage.setItem('stellar-user-profile', JSON.stringify(profile));
      setIsRegistered(true);
      addLog(`SIM Profile activated successfully!${accountExists ? '' : ' Wallet funded.'}`, 'success');
      void loadPhoneBalance(address);
    } else {
      setRegError('SIM activation failed. Friendbot could not fund the address. Please try again.');
      addLog('On-chain SIM activation failed.', 'error');
    }
    setRegLoading(false);
  };

  // --- Deactivate / Logout SIM ---
  const handleDeactivateSIM = () => {
    localStorage.removeItem('stellar-user-profile');
    setIsRegistered(false);
    setRegName('');
    setRegPhone('+254712345678');
    setRegPin('1234');
    setPhoneBalance('0');
    setCurrentScreen('IDLE');
    setDialString('');
    addLog('SIM Profile deactivated and cleared from local memory.', 'warning');
  };

  // --- T9 Input Navigation Logic ---
  const handleKeyPress = (key: string) => {
    if (currentScreen === 'IDLE') {
      if (key === '*' || (key >= '0' && key <= '9')) {
        setDialString(key);
        setCurrentScreen('DIALING');
      }
    } else if (currentScreen === 'DIALING') {
      if (key === 'END') {
        setDialString('');
        setCurrentScreen('IDLE');
      } else if (key === 'CALL') {
        if (dialString === '*123#') {
          addLog(`USSD Session started from phone ${regPhone} (${regName})`, 'info');
          setCurrentScreen('MENU');
          setMenuIndex(0);
        } else {
          setLastError('Invalid MMI Code');
          setCurrentScreen('ERROR');
        }
      } else if (key === 'BACK') {
        const next = dialString.slice(0, -1);
        if (next === '') {
          setCurrentScreen('IDLE');
        } else {
          setDialString(next);
        }
      } else {
        setDialString((prev) => prev + key);
      }
    } else if (currentScreen === 'MENU') {
      if (key === 'END') {
        addLog('USSD Session closed by user.', 'info');
        setCurrentScreen('IDLE');
      } else if (key === '1') {
        // Check Balance
        void loadPhoneBalance(activeAddress);
        setCurrentScreen('BALANCE');
      } else if (key === '2') {
        // Send Payment
        setPhoneInput('');
        setTargetDest('');
        setTargetName('');
        setCurrentScreen('SEND_DEST');
      } else if (key === '3') {
        // My Address info
        setCurrentScreen('BALANCE');
      } else if (key === '4') {
        // Deactivate SIM
        handleDeactivateSIM();
      } else if (key === 'UP') {
        setMenuIndex((prev) => (prev > 0 ? prev - 1 : 3));
      } else if (key === 'DOWN') {
        setMenuIndex((prev) => (prev < 3 ? prev + 1 : 0));
      } else if (key === 'SELECT') {
        handleKeyPress((menuIndex + 1).toString());
      }
    } else if (currentScreen === 'BALANCE') {
      if (key === 'END' || key === 'BACK' || key === 'SELECT') {
        setCurrentScreen('MENU');
      }
    } else if (currentScreen === 'SEND_DEST') {
      if (key === 'END') {
        setCurrentScreen('IDLE');
      } else if (key === 'BACK') {
        setCurrentScreen('MENU');
      } else if (key === 'CALL' || key === 'SELECT') {
        if (phoneInput.length >= 10) {
          setTargetDest(phoneInput);
          setPhoneInput('');
          setCurrentScreen('SEND_AMOUNT');
        }
      } else if (key === '*') {
        setPhoneInput((prev) => prev + '*');
      } else if (key === '#') {
        setPhoneInput((prev) => prev + '#');
      } else if (key >= '0' && key <= '9') {
        setPhoneInput((prev) => prev + key);
      }
    } else if (currentScreen === 'SEND_AMOUNT') {
      if (key === 'END') {
        setCurrentScreen('IDLE');
      } else if (key === 'BACK') {
        setPhoneInput(targetDest);
        setCurrentScreen('SEND_DEST');
      } else if (key === 'CALL' || key === 'SELECT') {
        if (Number(phoneInput) > 0) {
          setTargetAmount(phoneInput);
          setPhoneInput('');
          setCurrentScreen('CONFIRM_PIN');
        }
      } else if (key >= '0' && key <= '9') {
        setPhoneInput((prev) => prev + key);
      } else if (key === '*') {
        setPhoneInput((prev) => prev + '.');
      }
    } else if (currentScreen === 'CONFIRM_PIN') {
      if (key === 'END') {
        setCurrentScreen('IDLE');
      } else if (key === 'BACK') {
        setPhoneInput(targetAmount);
        setCurrentScreen('SEND_AMOUNT');
      } else if (key === 'CALL' || key === 'SELECT') {
        if (phoneInput === regPin) {
          setPhoneInput('');
          void processOfflinePayment();
        } else {
          setLastError('Incorrect PIN');
          setCurrentScreen('ERROR');
        }
      } else if (key >= '0' && key <= '9') {
        if (phoneInput.length < 4) {
          setPhoneInput((prev) => prev + key);
        }
      }
    } else if (currentScreen === 'SUCCESS' || currentScreen === 'ERROR') {
      if (key === 'END' || key === 'BACK' || key === 'SELECT') {
        setCurrentScreen('IDLE');
      }
    }
  };

  // --- Process USSD Relayer Action ---
  const processOfflinePayment = async () => {
    if (!activeKeypair) return;
    setCurrentScreen('TRANSMITTING');
    addLog('Offline transaction signed on SIM secure element...', 'info');

    const server = new StellarSdk.Horizon.Server(TESTNET_HORIZON_URL);
    let seqNum = '1';
    let needsActivation = false;

    try {
      addLog(`Gateway checking client account state for ${formatAddress(activeAddress)}...`, 'info');
      const clientAccount = await server.loadAccount(activeAddress);
      seqNum = clientAccount.sequenceNumber();
    } catch {
      needsActivation = true;
      addLog('Client account is unactivated. Gateway will sponsor activation...', 'warning');
    }

    try {
      let innerTxXdr = '';

      if (needsActivation) {
        addLog('Constructing account creation transaction...', 'info');
        const sponsorAccount = await server.loadAccount(sponsorKeypair!.publicKey());
        
        const createAccountTx = new StellarSdk.TransactionBuilder(sponsorAccount, {
          fee: StellarSdk.BASE_FEE,
          networkPassphrase: TESTNET_NETWORK_PASSPHRASE,
        })
          .addOperation(
            StellarSdk.Operation.createAccount({
              destination: activeAddress,
              startingBalance: '10', // Sponsor funds 10 XLM
            })
          )
          .setTimeout(30)
          .build();

        createAccountTx.sign(sponsorKeypair!);
        addLog('Sponsor executing direct account activation...', 'info');
        const activeRes = await server.submitTransaction(createAccountTx);
        addLog(`Client account active in ledger: ${activeRes.ledger}. Proceeding with payment...`, 'success');
        
        const clientAccount = await server.loadAccount(activeAddress);
        seqNum = clientAccount.sequenceNumber();
      }

      const dummySource = new StellarSdk.Account(activeAddress, seqNum);
      
      const paymentOp = StellarSdk.Operation.payment({
        destination: targetDest,
        asset: StellarSdk.Asset.native(),
        amount: targetAmount,
      });

      const innerTx = new StellarSdk.TransactionBuilder(dummySource, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: TESTNET_NETWORK_PASSPHRASE,
      })
        .addOperation(paymentOp)
        .setTimeout(120)
        .build();

      innerTx.sign(activeKeypair);
      innerTxXdr = innerTx.toXDR();

      const encodedPacket = `USSD_PAYLOAD|${regPhone}|${innerTxXdr.slice(0, 80)}...`;
      addLog(`Sending raw compressed packet over USSD (120 bytes):`, 'packet');
      addLog(encodedPacket, 'packet');

      addLog('Gateway Relayer received payload. Verifying signatures...', 'info');
      addLog('Wrapping inner transaction inside Sponsor Fee-Bump...', 'info');

      const response = await submitSponsoredTransaction(innerTx.toXDR(), sponsorKeypair!.secret());

      addLog(`Transaction broadcast successfully!`, 'success');
      addLog(`Ledger: ${response.ledger} | Hash: ${response.hash}`, 'success');
      setLastTxHash(response.hash);

      void loadPhoneBalance(activeAddress);
      
      const sponsorAcct = await server.loadAccount(sponsorKeypair!.publicKey());
      setSponsorBalance(getNativeBalanceFromAccount(sponsorAcct));

      setCurrentScreen('SUCCESS');
    } catch (error) {
      const msg = getErrorMessage(error);
      addLog(`Transaction failed: ${msg}`, 'error');
      setLastError(msg);
      setCurrentScreen('ERROR');
    }
  };

  // Handle contact select
  const handleContactSelect = (contact: ContactEntry) => {
    addLog(`Loaded contact "${contact.label}" from SIM card memory.`, 'info');
    setTargetName(contact.label);
    setTargetDest(contact.address);
    setPhoneInput(contact.address);
    setCurrentScreen('SEND_AMOUNT');
  };

  // --- RENDER REGISTRATION SCREEN ---
  if (!isRegistered) {
    return (
      <main className="shell">
        <section className="hero" style={{ marginBottom: '32px' }}>
          <div className="hero__copy">
            <p className="eyebrow">Level 1 · SIM Activation</p>
            <h1>Last-Mile Offline Payment Bridge</h1>
            <p className="lede">
              Welcome to the Stellar Last-Mile prototype. To simulate an offline feature phone transacting 
              without internet, you must first register your profile and activate your local SIM card on the 
              Stellar Testnet.
            </p>
          </div>
        </section>

        <section style={{ maxWidth: '600px', margin: '0 auto' }}>
          <article className="card">
            <div className="card__header">
              <div>
                <p className="card__label">SIM Registration</p>
                <h2>Activate Your Offline Profile</h2>
              </div>
              <span className="badge">Friendbot Connected</span>
            </div>

            <form className="form" onSubmit={handleActivateSIM} style={{ display: 'grid', gap: '16px' }}>
              <label>
                Full Name
                <input
                  type="text"
                  className="vault-input"
                  value={regName}
                  onChange={(e) => setRegName(e.target.value)}
                  placeholder="e.g. John Doe"
                  required
                />
              </label>

              <label>
                Phone Number (GSM SIM Identity)
                <input
                  type="text"
                  className="vault-input"
                  value={regPhone}
                  onChange={(e) => setRegPhone(e.target.value)}
                  placeholder="e.g. +254712345678"
                  required
                />
              </label>

              <label>
                4-Digit Secure Wallet PIN
                <input
                  type="password"
                  className="vault-input"
                  value={regPin}
                  onChange={(e) => setRegPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
                  placeholder="e.g. 1234"
                  maxLength={4}
                  required
                />
              </label>

              {/* Dynamic Derivation Preview */}
              {activeAddress && (
                <div className="info-block" style={{ marginTop: '10px' }}>
                  <span className="info-block__label">🔍 Real-time Keypair Derivation Preview</span>
                  <p style={{ fontFamily: 'monospace', fontSize: '0.85rem', color: '#38bdf8' }}>
                    Derived Public Address: {activeAddress}
                  </p>
                  <p style={{ fontSize: '0.75rem', color: '#64748b' }}>
                    Note: Your secret keys are derived client-side via deterministic hashing and are never sent to the network.
                  </p>
                </div>
              )}

              {regError && <p className="inline-alert inline-alert--error">{regError}</p>}

              <button className="primary-btn" type="submit" disabled={regLoading} style={{ marginTop: '8px' }}>
                {regLoading ? 'Activating SIM & Requesting 10k Testnet XLM...' : 'Activate SIM & Open Wallet'}
              </button>
            </form>
          </article>
        </section>
      </main>
    );
  }

  // --- RENDER MAIN DASHBOARD ---
  return (
    <main className="shell">
      {/* Hero Section */}
      <section className="hero">
        <div className="hero__copy">
          <p className="eyebrow">Level 1 · Active Profile</p>
          <h1>Last-Mile Stellar Payment Bridge</h1>
          <p className="lede">
            Welcome, <strong>{regName}</strong> ({regPhone}). Your simulated offline feature phone 
            transacts on the live testnet using your deterministic address: <code>{formatAddress(activeAddress)}</code>.
          </p>
        </div>

        <div className="hero__panel">
          <span className="badge">Testnet Sandbox</span>
          <div className="hero__panel-media">
            <img src="/screenshots/contact us.png" alt="Concept Banner" loading="lazy" />
          </div>
          <div>
            <span className="hero__panel-title">Zero-Internet Architecture</span>
            <p className="hero__panel-copy">
              Showcases sponsored reserves, fee-bumps, and cryptographic signing on basic hardware 
              to bridge the digital divide.
            </p>
          </div>
        </div>
      </section>

      {/* Main Grid */}
      <section className="grid">
        {/* Left: Phone Simulator Card */}
        <article className="card card--phone">
          <div className="card__header">
            <div>
              <p className="card__label">Hardware Simulator</p>
              <h2>Nokia 3310 Engine</h2>
            </div>
            <span className={`state-pill state-pill--${currentScreen !== 'IDLE' ? 'on' : 'off'}`}>
              {currentScreen === 'IDLE' ? 'Standby' : 'USSD Active'}
            </span>
          </div>

          <div className="phone-container">
            <div className="phone-mockup">
              <div className="phone-earpiece" />
              
              {/* LCD Display */}
              <div className="phone-screen-frame">
                <div className="phone-screen">
                  {/* Screen Header */}
                  <div className="screen-header">
                    <span>📶 Safaricom</span>
                    <span>🔋 100%</span>
                  </div>

                  {/* Screen Body */}
                  <div className="screen-body">
                    {currentScreen === 'IDLE' && (
                      <div style={{ textAlign: 'center', marginTop: '24px' }}>
                        <div style={{ fontSize: '1.2rem', letterSpacing: '0.05em' }}>Stellar SIM</div>
                        <div style={{ fontSize: '0.68rem', color: '#334155', marginTop: '16px' }}>Dial *123# to start</div>
                      </div>
                    )}

                    {currentScreen === 'DIALING' && (
                      <div style={{ marginTop: '20px', wordBreak: 'break-all' }}>
                        <span style={{ fontSize: '1.1rem' }}>{dialString}</span>
                        <span className="lcd-cursor" />
                      </div>
                    )}

                    {currentScreen === 'MENU' && (
                      <div>
                        <div className="menu-title">Stellar USSD</div>
                        <div className={`menu-option ${menuIndex === 0 ? 'menu-option--selected' : ''}`}>1. Check Balance</div>
                        <div className={`menu-option ${menuIndex === 1 ? 'menu-option--selected' : ''}`}>2. Send XLM</div>
                        <div className={`menu-option ${menuIndex === 2 ? 'menu-option--selected' : ''}`}>3. Wallet Info</div>
                        <div className={`menu-option ${menuIndex === 3 ? 'menu-option--selected' : ''}`}>4. Deactivate SIM</div>
                      </div>
                    )}

                    {currentScreen === 'BALANCE' && (
                      <div>
                        <div className="menu-title">{menuIndex === 0 ? 'XLM Balance' : 'Wallet Info'}</div>
                        {menuIndex === 0 ? (
                          <div style={{ margin: '10px 0', fontSize: '0.82rem' }}>
                            {phoneBalanceLoading ? 'Querying...' : `${formatXlm(phoneBalance)} XLM`}
                          </div>
                        ) : (
                          <div style={{ margin: '6px 0', fontSize: '0.68rem' }}>
                            Owner: {regName}<br/>
                            Phone: {regPhone}
                          </div>
                        )}
                        <div style={{ fontSize: '0.55rem', wordBreak: 'break-all', color: '#1e293b' }}>
                          Add: {formatAddress(activeAddress)}
                        </div>
                      </div>
                    )}

                    {currentScreen === 'SEND_DEST' && (
                      <div>
                        <div className="menu-title">Send To:</div>
                        <div style={{ fontSize: '0.62rem', color: '#1e293b', marginBottom: '4px' }}>
                          Select contact from list OR type public key below
                        </div>
                        <input
                          type="text"
                          className="phone-input-line"
                          value={phoneInput}
                          onChange={(e) => setPhoneInput(e.target.value)}
                          placeholder="Phone / G... address"
                        />
                      </div>
                    )}

                    {currentScreen === 'SEND_AMOUNT' && (
                      <div>
                        <div className="menu-title">Amount (XLM):</div>
                        <div style={{ fontSize: '0.65rem', marginBottom: '8px' }}>
                          Dest: {targetName || formatAddress(targetDest)}
                        </div>
                        <input
                          type="text"
                          className="phone-input-line"
                          value={phoneInput}
                          onChange={(e) => setPhoneInput(e.target.value)}
                          placeholder="0.0"
                        />
                      </div>
                    )}

                    {currentScreen === 'CONFIRM_PIN' && (
                      <div>
                        <div className="menu-title">Enter PIN:</div>
                        <div style={{ fontSize: '0.65rem', marginBottom: '10px' }}>
                          Send {targetAmount} XLM to {targetName || formatAddress(targetDest)}?
                        </div>
                        <div style={{ textAlign: 'center' }}>
                          <span style={{ fontSize: '1.2rem', letterSpacing: '0.2em' }}>
                            {'*'.repeat(phoneInput.length) || '_'}
                          </span>
                        </div>
                      </div>
                    )}

                    {currentScreen === 'TRANSMITTING' && (
                      <div style={{ textAlign: 'center', marginTop: '24px' }}>
                        <div>🛰️ USSD PACKET</div>
                        <div style={{ fontSize: '0.68rem', marginTop: '10px', color: '#334155' }}>
                          Transmitting packet via cell tower...
                        </div>
                      </div>
                    )}

                    {currentScreen === 'SUCCESS' && (
                      <div style={{ textAlign: 'center', marginTop: '16px' }}>
                        <div>✅ Success</div>
                        <div style={{ fontSize: '0.68rem', marginTop: '8px' }}>
                          Sent {targetAmount} XLM.
                        </div>
                        <div style={{ fontSize: '0.55rem', color: '#1e293b', marginTop: '8px' }}>
                          Hash: {lastTxHash.slice(0, 12)}...
                        </div>
                      </div>
                    )}

                    {currentScreen === 'ERROR' && (
                      <div style={{ marginTop: '8px' }}>
                        <div style={{ color: '#7f1d1d' }}>⚠️ Error</div>
                        <div style={{ fontSize: '0.6rem', marginTop: '4px', overflowY: 'auto', maxHeight: '110px' }}>
                          {lastError}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Screen Footer */}
                  <div className="screen-footer">
                    <span>
                      {currentScreen === 'MENU' || currentScreen === 'SEND_DEST' || currentScreen === 'SEND_AMOUNT' || currentScreen === 'CONFIRM_PIN' ? 'Back' : ''}
                    </span>
                    <span>
                      {currentScreen === 'IDLE' ? 'Dial' : currentScreen === 'MENU' ? 'Select' : 'OK'}
                    </span>
                  </div>
                </div>
              </div>

              {/* Navigation softkeys */}
              <div className="phone-softkeys">
                <button className="phone-btn phone-btn--soft" onClick={() => handleKeyPress('BACK')}>
                  ⬅ Back
                </button>
                <button className="phone-btn phone-btn--soft" onClick={() => handleKeyPress('UP')}>
                  ▲ Up
                </button>
                <button className="phone-btn phone-btn--soft" onClick={() => handleKeyPress('SELECT')}>
                  OK
                </button>
              </div>

              {/* Main Call/End Row */}
              <div className="phone-softkeys" style={{ marginTop: '8px' }}>
                <button className="phone-btn phone-btn--call" onClick={() => handleKeyPress('CALL')}>
                  📞 Call
                </button>
                <button className="phone-btn phone-btn--soft" onClick={() => handleKeyPress('DOWN')}>
                  ▼ Down
                </button>
                <button className="phone-btn phone-btn--end" onClick={() => handleKeyPress('END')}>
                  ❌ End
                </button>
              </div>

              {/* Numeric Keypad */}
              <div className="phone-keypad">
                {[
                  { num: '1', let: 'o_o' },
                  { num: '2', let: 'abc' },
                  { num: '3', let: 'def' },
                  { num: '4', let: 'ghi' },
                  { num: '5', let: 'jkl' },
                  { num: '6', let: 'mno' },
                  { num: '7', let: 'pqrs' },
                  { num: '8', let: 'tuv' },
                  { num: '9', let: 'wxyz' },
                  { num: '*', let: '.' },
                  { num: '0', let: 'space' },
                  { num: '#', let: 'caps' },
                ].map((k) => (
                  <button key={k.num} className="phone-btn" onClick={() => handleKeyPress(k.num)}>
                    <span className="phone-btn__num">{k.num}</span>
                    <span className="phone-btn__letters">{k.let}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </article>

        {/* Right: Gateway / Relayer Console Card */}
        <article className="card card--gateway">
          <div className="card__header">
            <div>
              <p className="card__label">Cellular Relayer Gateway</p>
              <h2>Stellar Broadcast Console</h2>
            </div>
            <span className="state-pill state-pill--accent">Sponsor Fee Pay Enabled</span>
          </div>

          <div className="gateway-console">
            {/* Info grid */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
              <div className="info-block">
                <span className="info-block__label">Sponsor Address</span>
                <p style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>
                  {sponsorKeypair ? formatAddress(sponsorKeypair.publicKey()) : 'Loading...'}
                </p>
              </div>
              <div className="info-block">
                <span className="info-block__label">Sponsor Balance</span>
                <p style={{ fontWeight: 'bold' }}>
                  {sponsorLoading ? 'Fetching...' : `${formatXlm(sponsorBalance)} XLM`}
                </p>
              </div>
            </div>

            {/* Terminal Monitor */}
            <div className="console-monitor">
              {logs.length === 0 ? (
                <p className="console-line console-line--info">Waiting for incoming USSD connection...</p>
              ) : (
                logs.map((log) => (
                  <p key={log.id} className={`console-line console-line--${log.type}`}>
                    [{log.time}] {log.text}
                  </p>
                ))
              )}
              <div ref={consoleEndRef} />
            </div>

            {/* Operations controls */}
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
              <button className="primary-btn" onClick={() => loadPhoneBalance(activeAddress)}>
                🔄 Refresh SIM Wallet Balance
              </button>
              <button className="ghost-btn" onClick={handleDeactivateSIM}>
                🔒 Deactivate SIM Profile (Sign Out)
              </button>
            </div>
          </div>
        </article>

        {/* Left Bottom: SIM Contacts */}
        <WalletBank onSelect={handleContactSelect} />

        {/* Right Bottom: Tech/Education Specs */}
        <article className="card card--education">
          <div className="card__header">
            <div>
              <p className="card__label">Protocol Documentation</p>
              <h2>How Offline Bridge Works</h2>
            </div>
            <span className="state-pill state-pill--neutral">Level 1 Architecture</span>
          </div>

          <div className="edu-grid">
            <div className="edu-item">
              <h4>1. Sim-based Key Derivation</h4>
              <p>
                Instead of storing secret keys online, the simulated phone derives a private/public keypair deterministically 
                from the <strong>Phone Number</strong> and a <strong>4-digit PIN</strong>. This replicates standard secure elements 
                (SIM cards) storing secrets offline.
              </p>
            </div>
            <div className="edu-item">
              <h4>2. USSD Session Dialog</h4>
              <p>
                Users dial <code>*123#</code> to establish a real-time GSM channel. The gateway responds with numbered text options. 
                This requires zero internet connection or mobile data, running on basic cellular towers.
              </p>
            </div>
            <div className="edu-item">
              <h4>3. Offline Signature Packaging</h4>
              <p>
                Once transaction parameters are confirmed, the phone uses its offline key to sign the transaction XDR. The signature 
                and payload are packed into a compressed format, sent back over the cellular network.
              </p>
            </div>
            <div className="edu-item">
              <h4>4. Sponsored Fee-Bumping</h4>
              <p>
                The Gateway Relayer intercepts the payload. To make it completely free for the unbanked user, the Gateway wraps the 
                transaction in a <strong>Stellar Fee-Bump Transaction</strong>. The Sponsor pays the network fee, and submits it to Horizon.
              </p>
            </div>
          </div>
        </article>
      </section>
    </main>
  );
}
