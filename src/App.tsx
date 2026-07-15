import { useCallback, useEffect, useRef, useState } from 'react';
import * as freighterApi from '@stellar/freighter-api';
import * as StellarSdk from '@stellar/stellar-sdk';
import WalletBank, { ContactEntry } from './WalletBank';
import {
  buildPaymentXdr,
  checkAccountStatus,
  fetchBalance,
  fetchRecentTransactions,
  formatAddress,
  formatXlm,
  fundWithFriendbot,
  FriendbotResult,
  getErrorMessage,
  getServer,
  isValidPublicKey,
  NETWORKS,
  NetworkType,
  submitFeeBumped,
} from './lib/stellar';

// ─── Types ───────────────────────────────────────────────────────────────────

type ScreenState =
  | 'IDLE' | 'DIALING' | 'MENU' | 'BALANCE' | 'TXHISTORY'
  | 'SEND_DEST' | 'SEND_AMOUNT' | 'CONFIRM_PIN' | 'TRANSMITTING'
  | 'SUCCESS' | 'ERROR';

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
  walletAddress: string;
  network: NetworkType;
};

type PaymentRecord = {
  id: string;
  type: string;
  from: string;
  to: string;
  amount: string;
  asset: string;
  createdAt: string;
};

const freighter = freighterApi as any;

// ─── Storage keys (per wallet address for isolation) ─────────────────────────

const PROFILE_KEY = 'stellar-sim-profile-v3';

function sponsorKey(address: string, network: NetworkType) {
  return `stellar-sponsor-${network}-${address}`;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function loadProfile(): UserProfile | null {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /**/ }
  return null;
}

function saveProfile(p: UserProfile) {
  localStorage.setItem(PROFILE_KEY, JSON.stringify(p));
}

function clearProfile() {
  localStorage.removeItem(PROFILE_KEY);
}

function getSponsorKeypair(walletAddress: string, network: NetworkType): StellarSdk.Keypair {
  const key = sponsorKey(walletAddress, network);
  let secret = localStorage.getItem(key);
  if (secret) {
    try { return StellarSdk.Keypair.fromSecret(secret); } catch { /**/ }
  }
  const kp = StellarSdk.Keypair.random();
  localStorage.setItem(key, kp.secret());
  return kp;
}

// ─── App ─────────────────────────────────────────────────────────────────────

export default function App() {
  const existingProfile = loadProfile();

  // --- Registration ---
  const [isRegistered, setIsRegistered] = useState<boolean>(!!existingProfile);
  const [regName, setRegName] = useState('');
  const [regPhone, setRegPhone] = useState('+254712345678');
  const [regPin, setRegPin] = useState('');
  const [regWalletAddr, setRegWalletAddr] = useState('');
  const [regNetwork, setRegNetwork] = useState<NetworkType>('testnet');
  const [regLoading, setRegLoading] = useState(false);
  const [regError, setRegError] = useState<string | null>(null);
  const [friendbotStatus, setFriendbotStatus] = useState<'idle' | 'checking' | 'active' | 'funded' | 'error'>('idle');

  // --- Active profile ---
  const [profile, setProfile] = useState<UserProfile | null>(existingProfile);
  const network: NetworkType = profile?.network ?? 'testnet';

  // --- Sponsor (gateway that pays fees) — keyed per wallet+network ---
  const sponsorKp = profile
    ? getSponsorKeypair(profile.walletAddress, profile.network)
    : null;
  const [sponsorBalance, setSponsorBalance] = useState('0');
  const [sponsorReady, setSponsorReady] = useState(false);

  // --- Freighter ---
  const [freighterConnected, setFreighterConnected] = useState(false);
  const [freighterAddress, setFreighterAddress] = useState('');
  const [freighterLoading, setFreighterLoading] = useState(false);

  // --- Active address ---
  const activeAddress = freighterConnected
    ? freighterAddress
    : (profile?.walletAddress ?? '');

  // --- Balance ---
  const [walletBalance, setWalletBalance] = useState('0');
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [lastBalanceAt, setLastBalanceAt] = useState<Date | null>(null);
  const balancePollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // --- Tx History ---
  const [txHistory, setTxHistory] = useState<PaymentRecord[]>([]);
  const [txHistoryLoading, setTxHistoryLoading] = useState(false);

  // --- Phone State Machine ---
  const [screen, setScreen] = useState<ScreenState>('IDLE');
  const [dialString, setDialString] = useState('');
  const [menuIndex, setMenuIndex] = useState(0);
  const [destInput, setDestInput] = useState('');
  const [destName, setDestName] = useState('');
  const [amountInput, setAmountInput] = useState('');
  const [pinInput, setPinInput] = useState('');
  const [lastTxHash, setLastTxHash] = useState('');
  const [lastError, setLastError] = useState('');

  // --- Logs ---
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const consoleEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => { consoleEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [logs]);

  const addLog = useCallback((text: string, type: LogEntry['type'] = 'info') => {
    const time = new Date().toLocaleTimeString();
    setLogs(p => [...p, { id: `${Date.now()}-${Math.random()}`, text, type, time }]);
  }, []);

  // ── Boot: Initialize sponsor once profile is loaded ──────────────────────
  useEffect(() => {
    if (!profile || !sponsorKp) return;
    const init = async () => {
      addLog(`Gateway Relayer starting on ${NETWORKS[profile.network].name}…`, 'info');
      addLog(`Sponsor key: ${formatAddress(sponsorKp.publicKey())}`, 'info');

      // Check sponsor balance
      const status = await checkAccountStatus(sponsorKp.publicKey(), profile.network);
      if (status === 'active') {
        try {
          const bal = await fetchBalance(sponsorKp.publicKey(), profile.network);
          setSponsorBalance(bal);
          setSponsorReady(true);
          addLog(`Sponsor ready. Balance: ${formatXlm(bal)} XLM`, 'success');
        } catch (e) {
          addLog(`Sponsor balance check failed: ${getErrorMessage(e)}`, 'error');
        }
      } else if (profile.network === 'testnet') {
        addLog('Sponsor not found — calling Friendbot…', 'warning');
        const result = await fundWithFriendbot(sponsorKp.publicKey(), 'testnet');
        if (result === 'funded' || result === 'already_exists') {
          try {
            const bal = await fetchBalance(sponsorKp.publicKey(), 'testnet');
            setSponsorBalance(bal);
            setSponsorReady(true);
            addLog(`Sponsor funded! Balance: ${formatXlm(bal)} XLM`, 'success');
          } catch { /**/ }
        } else {
          addLog('Friendbot failed. Refresh to retry.', 'error');
        }
      } else {
        addLog('⚠ Sponsor wallet has no XLM. Fund it with real XLM for mainnet.', 'error');
      }
    };
    void init();
  }, [profile]);

  // ── Balance polling ───────────────────────────────────────────────────────
  const refreshBalance = useCallback(async (address: string, net: NetworkType) => {
    if (!address) return;
    setBalanceLoading(true);
    try {
      const bal = await fetchBalance(address, net);
      setWalletBalance(bal);
      setLastBalanceAt(new Date());
    } catch {
      setWalletBalance('0');
    } finally { setBalanceLoading(false); }
  }, []);

  useEffect(() => {
    if (!isRegistered || !activeAddress || !profile) return;
    void refreshBalance(activeAddress, profile.network);
    balancePollRef.current = setInterval(
      () => void refreshBalance(activeAddress, profile.network),
      15_000
    );
    return () => { if (balancePollRef.current) clearInterval(balancePollRef.current); };
  }, [isRegistered, activeAddress, profile?.network]);

  // ── Tx History ─────────────────────────────────────────────────────────
  const loadTxHistory = useCallback(async (address: string, net: NetworkType) => {
    if (!address) return;
    setTxHistoryLoading(true);
    try {
      const records = await fetchRecentTransactions(address, net);
      setTxHistory(records.map((r: any) => ({
        id: r.id,
        type: r.type,
        from: r.from ?? r.source_account ?? '',
        to: r.to ?? r.into ?? '',
        amount: r.amount ?? r.starting_balance ?? '?',
        asset: r.asset_type === 'native' ? 'XLM' : (r.asset_code ?? '?'),
        createdAt: r.created_at,
      })));
    } catch { setTxHistory([]); }
    finally { setTxHistoryLoading(false); }
  }, []);

  useEffect(() => {
    if (isRegistered && activeAddress && profile)
      void loadTxHistory(activeAddress, profile.network);
  }, [isRegistered, activeAddress, profile?.network]);

  // ── Friendbot pre-check while typing address ──────────────────────────────
  useEffect(() => {
    if (!isValidPublicKey(regWalletAddr) || regNetwork !== 'testnet') {
      setFriendbotStatus('idle');
      return;
    }
    setFriendbotStatus('checking');
    const timer = setTimeout(async () => {
      const status = await checkAccountStatus(regWalletAddr.trim(), 'testnet');
      setFriendbotStatus(status === 'active' ? 'active' : 'idle');
    }, 600);
    return () => clearTimeout(timer);
  }, [regWalletAddr, regNetwork]);

  // ── Registration ──────────────────────────────────────────────────────────
  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setRegError(null);
    if (!regName.trim()) { setRegError('Name is required.'); return; }
    if (!regPhone.trim()) { setRegError('Phone number is required.'); return; }
    if (regPin.length !== 4) { setRegError('PIN must be exactly 4 digits.'); return; }
    if (!regWalletAddr.trim()) {
      setRegError('Please connect your Freighter Wallet first.'); return;
    }
    if (!isValidPublicKey(regWalletAddr.trim())) {
      setRegError('Failed to retrieve a valid Stellar public key from Freighter. Try reconnecting.'); return;
    }
    setRegLoading(true);

    const addr = regWalletAddr.trim();
    addLog(`Registering SIM: ${regName} (${regPhone}) on ${NETWORKS[regNetwork].name}`, 'info');
    addLog(`Linking wallet: ${formatAddress(addr)}`, 'info');

    // Check / fund wallet address
    const acctStatus = await checkAccountStatus(addr, regNetwork);
    if (acctStatus === 'active') {
      addLog('✅ Wallet address is already active on-chain.', 'success');
    } else if (regNetwork === 'testnet') {
      addLog('Wallet not found — requesting Friendbot activation…', 'warning');
      setFriendbotStatus('checking');
      const result: FriendbotResult = await fundWithFriendbot(addr, 'testnet');
      if (result === 'funded') {
        addLog('✅ Friendbot funded wallet with 10,000 XLM!', 'success');
        setFriendbotStatus('funded');
      } else if (result === 'already_exists') {
        addLog('✅ Wallet already active on testnet.', 'success');
        setFriendbotStatus('active');
      } else {
        setRegError('Could not activate this address on testnet. Please check the address and try again.');
        setFriendbotStatus('error');
        setRegLoading(false);
        return;
      }
    } else {
      setRegError('This wallet address has no XLM on Mainnet. Fund it with real XLM first.');
      setRegLoading(false);
      return;
    }

    const newProfile: UserProfile = {
      name: regName.trim(),
      phone: regPhone.trim(),
      pin: regPin,
      walletAddress: addr,
      network: regNetwork,
    };
    saveProfile(newProfile);
    setProfile(newProfile);
    setIsRegistered(true);
    addLog(`SIM registered. Welcome, ${regName}!`, 'success');
    setRegLoading(false);
  };

  const connectFreighterForReg = async () => {
    setRegLoading(true);
    setRegError(null);
    try {
      const access = await freighter.requestAccess();
      if (access?.error) throw new Error(access.error.message ?? 'Freighter denied access.');
      setRegWalletAddr(access.address);
      addLog(`Freighter connected during registration: ${formatAddress(access.address)}`, 'success');
    } catch (e) {
      setRegError(getErrorMessage(e));
    } finally {
      setRegLoading(false);
    }
  };

  // ── Freighter ─────────────────────────────────────────────────────────────
  const connectFreighter = async () => {
    setFreighterLoading(true);
    try {
      const access = await freighter.requestAccess();
      if (access?.error) throw new Error(access.error.message ?? 'Freighter denied access.');
      setFreighterAddress(access.address);
      setFreighterConnected(true);
      addLog(`Freighter connected: ${formatAddress(access.address)}`, 'success');
      if (profile) void refreshBalance(access.address, profile.network);
    } catch (e) { addLog(`Freighter error: ${getErrorMessage(e)}`, 'error'); }
    finally { setFreighterLoading(false); }
  };

  const disconnectFreighter = () => {
    setFreighterConnected(false);
    setFreighterAddress('');
    addLog('Freighter disconnected.', 'info');
  };

  // ── Sign-out ──────────────────────────────────────────────────────────────
  const signOut = () => {
    clearProfile();
    setIsRegistered(false);
    setProfile(null);
    setRegName(''); setRegPhone('+254712345678'); setRegPin(''); setRegWalletAddr('');
    setRegNetwork('testnet'); setFriendbotStatus('idle');
    setFreighterConnected(false); setFreighterAddress('');
    setWalletBalance('0'); setTxHistory([]);
    setScreen('IDLE'); setSponsorReady(false); setSponsorBalance('0');
    addLog('SIM profile cleared.', 'warning');
  };

  // ── Phone key handler ─────────────────────────────────────────────────────
  const handleKey = (key: string) => {
    if (screen === 'IDLE') {
      if (key === '*' || (key >= '0' && key <= '9')) { setDialString(key); setScreen('DIALING'); }
    } else if (screen === 'DIALING') {
      if (key === 'END') { setDialString(''); setScreen('IDLE'); }
      else if (key === 'BACK') {
        const n = dialString.slice(0, -1);
        n === '' ? setScreen('IDLE') : setDialString(n);
      } else if (key === 'CALL') {
        if (dialString === '*123#') { setMenuIndex(0); setScreen('MENU'); addLog('USSD session opened.', 'info'); }
        else { setLastError(`Unknown code "${dialString}". Try *123#`); setScreen('ERROR'); }
      } else { setDialString(d => d + key); }
    } else if (screen === 'MENU') {
      if (key === 'END') { setScreen('IDLE'); addLog('USSD session closed.', 'info'); }
      else if (key === '1') { void refreshBalance(activeAddress, network); setScreen('BALANCE'); }
      else if (key === '2') { setDestInput(''); setDestName(''); setAmountInput(''); setScreen('SEND_DEST'); }
      else if (key === '3') { void loadTxHistory(activeAddress, network); setScreen('TXHISTORY'); }
      else if (key === '4') { signOut(); }
      else if (key === 'UP') { setMenuIndex(p => p > 0 ? p - 1 : 3); }
      else if (key === 'DOWN') { setMenuIndex(p => p < 3 ? p + 1 : 0); }
      else if (key === 'SELECT') { handleKey((menuIndex + 1).toString()); }
    } else if (screen === 'BALANCE' || screen === 'TXHISTORY') {
      if (key === 'BACK' || key === 'END' || key === 'SELECT') setScreen('MENU');
    } else if (screen === 'SEND_DEST') {
      if (key === 'BACK') setScreen('MENU');
      else if (key === 'END') setScreen('IDLE');
      else if ((key === 'CALL' || key === 'SELECT') && destInput.length > 20) setScreen('SEND_AMOUNT');
    } else if (screen === 'SEND_AMOUNT') {
      if (key === 'BACK') setScreen('SEND_DEST');
      else if (key === 'END') setScreen('IDLE');
      else if ((key === 'CALL' || key === 'SELECT') && Number(amountInput) > 0) {
        setPinInput(''); setScreen('CONFIRM_PIN');
      } else if (key === '*') { setAmountInput(a => a.includes('.') ? a : a + '.'); }
      else if (key >= '0' && key <= '9') { setAmountInput(a => a + key); }
    } else if (screen === 'CONFIRM_PIN') {
      if (key === 'BACK') setScreen('SEND_AMOUNT');
      else if (key === 'END') setScreen('IDLE');
      else if (key === 'CALL' || key === 'SELECT') {
        if (pinInput === profile?.pin) void processTransaction();
        else { setLastError('Incorrect PIN. Transaction cancelled.'); setScreen('ERROR'); }
      } else if (key >= '0' && key <= '9' && pinInput.length < 4) {
        setPinInput(p => p + key);
      }
    } else if (screen === 'SUCCESS' || screen === 'ERROR') {
      if (key === 'END' || key === 'BACK' || key === 'SELECT') setScreen('IDLE');
    }
  };

  // ── Real transaction ──────────────────────────────────────────────────────
  const processTransaction = async () => {
    if (!profile || !sponsorKp) return;
    setScreen('TRANSMITTING');
    addLog(`📡 Building tx: ${amountInput} XLM → ${formatAddress(destInput)}`, 'packet');

    try {
      if (!freighterConnected) {
        throw new Error('Connect Freighter to sign transactions. The USSD PIN only confirms intent; Freighter signs the actual cryptographic transaction.');
      }

      // 1. Build unsigned XDR
      const xdr = await buildPaymentXdr(activeAddress, destInput, amountInput, profile.network);
      addLog('XDR built. Requesting Freighter signature…', 'info');

      // 2. Sign with Freighter
      const signed = await freighter.signTransaction(xdr, {
        accountToSign: activeAddress,
        networkPassphrase: NETWORKS[profile.network].passphrase,
      });
      if (signed?.error) throw new Error(signed.error.message ?? 'Freighter signing failed.');
      const signedXdr: string = signed?.signedTxXdr ?? signed?.signedTx ?? signed;
      if (!signedXdr) throw new Error('Freighter returned empty signed transaction.');
      addLog('✍ Signed. Wrapping in Fee-Bump envelope…', 'info');

      // 3. Fee-bump and submit
      const response: any = await submitFeeBumped(signedXdr, sponsorKp.secret(), profile.network);
      addLog(`✅ Broadcast! Ledger: ${response.ledger}`, 'success');
      addLog(`Hash: ${response.hash}`, 'success');
      setLastTxHash(response.hash);

      // 4. Refresh
      await refreshBalance(activeAddress, profile.network);
      void loadTxHistory(activeAddress, profile.network);
      try {
        const newBal = await fetchBalance(sponsorKp.publicKey(), profile.network);
        setSponsorBalance(newBal);
      } catch { /**/ }

      setScreen('SUCCESS');
    } catch (e) {
      const msg = getErrorMessage(e);
      addLog(`❌ ${msg}`, 'error');
      setLastError(msg);
      setScreen('ERROR');
    }
  };

  const handleContactSelect = (c: ContactEntry) => {
    setDestInput(c.address);
    setDestName(c.label);
    addLog(`Contact loaded: "${c.label}" → ${formatAddress(c.address)}`, 'info');
    setScreen('SEND_AMOUNT');
  };

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER — Registration Screen
  // ─────────────────────────────────────────────────────────────────────────
  if (!isRegistered) {
    const addrValid = isValidPublicKey(regWalletAddr);
    const addrInvalid = regWalletAddr.length > 0 && !addrValid;

    return (
      <main className="shell">
        <div className="reg-screen">
          <div className="reg-card">
            <div className="reg-header">
              <div className="reg-logo">📡</div>
              <h1>Stellar Last-Mile Bridge</h1>
              <p>Register your SIM profile to start transacting on the Stellar network.</p>
            </div>

            <form onSubmit={handleRegister}>

              {/* Network Selector */}
              <div className="reg-field">
                <label>Network</label>
                <div className="network-selector">
                  {(Object.keys(NETWORKS) as NetworkType[]).map(n => (
                    <button
                      key={n}
                      type="button"
                      className={`network-option ${regNetwork === n ? 'network-option--active' : ''}`}
                      onClick={() => setRegNetwork(n)}
                    >
                      <span className={`dot dot--${n === 'testnet' ? 'green' : 'orange'}`} />
                      {NETWORKS[n].name}
                      {n === 'mainnet' && <span className="network-badge">Real XLM</span>}
                      {n === 'testnet' && <span className="network-badge network-badge--safe">Free / Safe</span>}
                    </button>
                  ))}
                </div>
                {regNetwork === 'mainnet' && (
                  <div className="reg-derived reg-derived--warn">
                    ⚠ Mainnet uses real XLM. Transactions cannot be reversed. Friendbot not available.
                  </div>
                )}
              </div>

              <div className="reg-field">
                <label>Full Name</label>
                <input type="text" value={regName} onChange={e => setRegName(e.target.value)} placeholder="e.g. Amara Diallo" required />
              </div>

              <div className="reg-field">
                <label>Phone Number <span className="reg-hint">(GSM SIM identity)</span></label>
                <input type="text" value={regPhone} onChange={e => setRegPhone(e.target.value)} placeholder="+254712345678" required />
              </div>

              <div className="reg-field">
                <label>Stellar Wallet Address</label>
                {!regWalletAddr ? (
                  <button
                    type="button"
                    className="primary-btn"
                    style={{
                      width: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '8px',
                      padding: '12px 14px',
                      fontWeight: 'bold',
                      marginTop: '4px'
                    }}
                    onClick={connectFreighterForReg}
                    disabled={regLoading}
                  >
                    🦊 Connect Freighter Wallet
                  </button>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '4px' }}>
                    <div style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      background: 'rgba(56, 189, 248, 0.08)',
                      border: '1px solid rgba(56, 189, 248, 0.25)',
                      borderRadius: '12px',
                      padding: '10px 14px'
                    }}>
                      <span style={{ fontSize: '0.85rem', fontFamily: 'monospace', wordBreak: 'break-all', color: '#38bdf8' }}>
                        ✅ {formatAddress(regWalletAddr)}
                      </span>
                      <button
                        type="button"
                        className="ghost-btn"
                        style={{ padding: '4px 10px', fontSize: '0.78rem', marginLeft: '10px', minWidth: 'fit-content' }}
                        onClick={() => setRegWalletAddr('')}
                      >
                        Change
                      </button>
                    </div>

                    {/* Live Friendbot status */}
                    {addrValid && regNetwork === 'testnet' && (
                      <div className={`reg-derived ${friendbotStatus === 'active' || friendbotStatus === 'funded' ? '' : friendbotStatus === 'error' ? 'reg-derived--err' : ''}`}>
                        {friendbotStatus === 'checking' && <span>🔍 Checking account on testnet…</span>}
                        {friendbotStatus === 'active' && <><span className="reg-derived__label">✅ Account already active on testnet</span><span className="reg-derived__addr">Friendbot not needed — will log in directly.</span></>}
                        {friendbotStatus === 'funded' && <><span className="reg-derived__label">✅ Funded by Friendbot!</span><span className="reg-derived__addr">10,000 XLM added to this address.</span></>}
                        {friendbotStatus === 'error' && <span>❌ Could not check account status.</span>}
                        {friendbotStatus === 'idle' && <><span className="reg-derived__label">✅ Valid Stellar address</span><span className="reg-derived__addr">{regWalletAddr}</span></>}
                      </div>
                    )}
                    {addrValid && regNetwork === 'mainnet' && (
                      <div className="reg-derived">
                        <span className="reg-derived__label">✅ Valid Stellar address</span>
                        <span className="reg-derived__addr">Will verify on Mainnet Horizon. Ensure this address has XLM.</span>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="reg-field">
                <label>4-Digit Wallet PIN <span className="reg-hint">(confirms payments on phone)</span></label>
                <input
                  type="password"
                  value={regPin}
                  onChange={e => setRegPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
                  placeholder="••••"
                  maxLength={4}
                  required
                />
              </div>

              {regError && <div className="reg-error">⚠ {regError}</div>}

              <button className="reg-submit" type="submit" disabled={regLoading}>
                {regLoading ? 'Activating SIM…' : `🚀 Activate SIM on ${NETWORKS[regNetwork].name}`}
              </button>
            </form>

            <div className="reg-info">
              <div>📡 Your wallet address is linked to your phone number on this device.</div>
              <div>🔐 Your PIN is stored locally — never transmitted to any server.</div>
              <div>⚡ Transactions are fee-bumped — gateway pays all Stellar network fees.</div>
              <div>🌐 Contacts are stored per wallet address — no data carries over between accounts.</div>
            </div>
          </div>
        </div>
      </main>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER — Main Dashboard
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <main className="shell">

      {/* ── Hero ── */}
      <section className="hero">
        <div className="hero__copy">
          <p className="eyebrow">
            <span className={`dot dot--${network === 'testnet' ? 'green' : 'orange'}`} style={{ display: 'inline-block', marginRight: '6px' }} />
            {NETWORKS[network].name} · Active SIM
          </p>
          <h1>Offline Payment Bridge</h1>
          <p className="lede">
            Welcome, <strong>{profile!.name}</strong>. SIM linked to <code>{profile!.phone}</code>.
            Dial <strong>*123#</strong> on the phone to transact.
          </p>

          {/* Live balance */}
          <div className="balance-hero">
            <div className="balance-hero__label">Live Wallet Balance</div>
            <div className="balance-hero__value">
              {balanceLoading ? 'Fetching…' : `${formatXlm(walletBalance)} XLM`}
            </div>
            <div className="balance-hero__meta">
              {lastBalanceAt
                ? `Updated ${lastBalanceAt.toLocaleTimeString()} · auto-refreshes every 15s`
                : 'Loading…'}
            </div>
            <div className="balance-hero__addr">{activeAddress}</div>
          </div>
        </div>

        <div className="hero__panel">
          {/* Freighter */}
          <div>
            <p className="card__label">Freighter Wallet</p>
            {freighterConnected ? (
              <div>
                <div className="freighter-connected">
                  <span className="dot dot--green" />
                  {formatAddress(freighterAddress)}
                </div>
                <button className="ghost-btn" style={{ marginTop: '8px', width: '100%' }} onClick={disconnectFreighter}>
                  Disconnect
                </button>
              </div>
            ) : (
              <button className="primary-btn" style={{ width: '100%', marginTop: '6px' }} onClick={connectFreighter} disabled={freighterLoading}>
                {freighterLoading ? 'Connecting…' : '🦊 Connect Freighter to Sign Txs'}
              </button>
            )}
            {!freighterConnected && (
              <p style={{ fontSize: '0.72rem', marginTop: '8px', color: '#ef4444' }}>
                ⚠ Freighter required to sign real transactions.
              </p>
            )}
          </div>

          <div className="info-block">
            <span className="info-block__label">Registered Address</span>
            <p style={{ fontSize: '0.78rem', wordBreak: 'break-all', fontFamily: 'monospace' }}>
              {profile!.walletAddress}
            </p>
          </div>

          <button className="ghost-btn" style={{ width: '100%' }} onClick={signOut}>
            🔒 Sign Out / Switch Account
          </button>
        </div>
      </section>

      {/* ── Main Grid ── */}
      <section className="grid">

        {/* Phone Simulator */}
        <article className="card card--phone">
          <div className="card__header">
            <div>
              <p className="card__label">Hardware Simulator</p>
              <h2>Nokia 3310</h2>
            </div>
            <span className={`state-pill state-pill--${screen !== 'IDLE' ? 'on' : 'off'}`}>
              {screen === 'IDLE' ? 'Standby' : 'USSD Active'}
            </span>
          </div>

          <div className="phone-container">
            <div className="phone-mockup">
              <div className="phone-earpiece" />

              <div className="phone-screen-frame">
                <div className="phone-screen">
                  <div className="screen-header">
                    <span>📶 {network === 'testnet' ? 'StellarNet' : 'Stellar'}</span>
                    <span>🔋</span>
                  </div>
                  <div className="screen-body">
                    {screen === 'IDLE' && (
                      <div className="screen-idle">
                        <div className="screen-name">{profile!.name.split(' ')[0]}'s SIM</div>
                        <div className="screen-hint">Dial *123# ▶ Call</div>
                      </div>
                    )}
                    {screen === 'DIALING' && (
                      <div className="screen-dial">
                        <span>{dialString}</span><span className="lcd-cursor" />
                      </div>
                    )}
                    {screen === 'MENU' && (
                      <div>
                        <div className="menu-title">Stellar USSD</div>
                        {['1. Check Balance', '2. Send XLM', '3. Tx History', '4. Sign Out'].map((opt, i) => (
                          <div key={i} className={`menu-option ${menuIndex === i ? 'menu-option--selected' : ''}`}>{opt}</div>
                        ))}
                      </div>
                    )}
                    {screen === 'BALANCE' && (
                      <div>
                        <div className="menu-title">Balance</div>
                        <div className="screen-balance">{balanceLoading ? 'Querying…' : `${formatXlm(walletBalance)} XLM`}</div>
                        <div className="screen-subtext">{formatAddress(activeAddress)}</div>
                      </div>
                    )}
                    {screen === 'TXHISTORY' && (
                      <div>
                        <div className="menu-title">Recent Txs</div>
                        {txHistoryLoading
                          ? <div className="screen-subtext">Loading…</div>
                          : txHistory.length === 0
                            ? <div className="screen-subtext">No transactions yet.</div>
                            : txHistory.slice(0, 3).map(tx => (
                              <div key={tx.id} className="screen-tx">
                                <span>{tx.from === activeAddress ? '↑ Sent' : '↓ Rcvd'}</span>
                                <span>{tx.amount} {tx.asset}</span>
                              </div>
                            ))}
                      </div>
                    )}
                    {screen === 'SEND_DEST' && (
                      <div>
                        <div className="menu-title">Recipient</div>
                        <div className="screen-subtext">Or select contact below ↓</div>
                        <input
                          className="phone-input-line"
                          type="text"
                          value={destInput}
                          onChange={e => setDestInput(e.target.value)}
                          placeholder="G… address"
                        />
                      </div>
                    )}
                    {screen === 'SEND_AMOUNT' && (
                      <div>
                        <div className="menu-title">Amount (XLM)</div>
                        <div className="screen-subtext">{destName || formatAddress(destInput)}</div>
                        <input
                          className="phone-input-line"
                          type="number"
                          value={amountInput}
                          onChange={e => setAmountInput(e.target.value)}
                          placeholder="0.0"
                          min="0.0000001"
                          step="0.0000001"
                        />
                      </div>
                    )}
                    {screen === 'CONFIRM_PIN' && (
                      <div>
                        <div className="menu-title">Enter PIN</div>
                        <div className="screen-subtext">Send {amountInput} XLM to {destName || formatAddress(destInput)}</div>
                        <div className="screen-pin">{'●'.repeat(pinInput.length)}{'_'.repeat(4 - pinInput.length)}</div>
                      </div>
                    )}
                    {screen === 'TRANSMITTING' && (
                      <div className="screen-idle">
                        <div>🛰 Transmitting…</div>
                        <div className="screen-hint">Broadcasting to Stellar…</div>
                      </div>
                    )}
                    {screen === 'SUCCESS' && (
                      <div className="screen-idle">
                        <div>✅ Sent!</div>
                        <div className="screen-hint">{amountInput} XLM</div>
                        <div className="screen-subtext" style={{ fontSize: '0.5rem' }}>{lastTxHash.slice(0, 16)}…</div>
                      </div>
                    )}
                    {screen === 'ERROR' && (
                      <div>
                        <div style={{ color: '#7f1d1d', fontWeight: 'bold' }}>⚠ Error</div>
                        <div className="screen-subtext" style={{ maxHeight: '90px', overflowY: 'auto', fontSize: '0.56rem' }}>{lastError}</div>
                      </div>
                    )}
                  </div>
                  <div className="screen-footer">
                    <span>{['MENU', 'SEND_DEST', 'SEND_AMOUNT', 'CONFIRM_PIN'].includes(screen) ? 'Back' : ''}</span>
                    <span>{screen === 'IDLE' ? 'Dial' : 'OK'}</span>
                  </div>
                </div>
              </div>

              <div className="phone-softkeys">
                <button className="phone-btn phone-btn--soft" onClick={() => handleKey('BACK')}>⬅ Back</button>
                <button className="phone-btn phone-btn--soft" onClick={() => handleKey('UP')}>▲</button>
                <button className="phone-btn phone-btn--soft" onClick={() => handleKey('SELECT')}>OK</button>
              </div>
              <div className="phone-softkeys" style={{ marginTop: '8px' }}>
                <button className="phone-btn phone-btn--call" onClick={() => handleKey('CALL')}>📞</button>
                <button className="phone-btn phone-btn--soft" onClick={() => handleKey('DOWN')}>▼</button>
                <button className="phone-btn phone-btn--end" onClick={() => handleKey('END')}>❌</button>
              </div>
              <div className="phone-keypad">
                {[
                  ['1', 'o_o'], ['2', 'abc'], ['3', 'def'],
                  ['4', 'ghi'], ['5', 'jkl'], ['6', 'mno'],
                  ['7', 'pqrs'], ['8', 'tuv'], ['9', 'wxyz'],
                  ['*', '.'], ['0', 'sp'], ['#', '#'],
                ].map(([n, l]) => (
                  <button key={n} className="phone-btn" onClick={() => handleKey(n)}>
                    <span className="phone-btn__num">{n}</span>
                    <span className="phone-btn__letters">{l}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </article>

        {/* Gateway Console */}
        <article className="card card--gateway">
          <div className="card__header">
            <div>
              <p className="card__label">Cellular Relayer Gateway</p>
              <h2>Broadcast Console</h2>
            </div>
            <span className={`state-pill ${sponsorReady ? 'state-pill--accent' : 'state-pill--off'}`}>
              {sponsorReady ? 'Fee-Bump Active' : 'Initializing…'}
            </span>
          </div>

          <div className="gateway-console">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <div className="info-block">
                <span className="info-block__label">Gateway Sponsor</span>
                <p style={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>{sponsorKp ? formatAddress(sponsorKp.publicKey()) : '—'}</p>
                <p style={{ fontWeight: 'bold', marginTop: '4px' }}>{formatXlm(sponsorBalance)} XLM</p>
                <p style={{ fontSize: '0.68rem', color: '#64748b', marginTop: '2px' }}>
                  {network === 'testnet' ? 'Funded by Friendbot' : 'Real XLM required'}
                </p>
              </div>
              <div className="info-block">
                <span className="info-block__label">Your Wallet (Live)</span>
                <p style={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>{formatAddress(activeAddress)}</p>
                <p style={{ fontWeight: 'bold', marginTop: '4px', color: balanceLoading ? '#94a3b8' : '#4ade80' }}>
                  {balanceLoading ? 'Refreshing…' : `${formatXlm(walletBalance)} XLM`}
                </p>
                <p style={{ fontSize: '0.68rem', color: '#64748b', marginTop: '2px' }}>
                  {NETWORKS[network].name} · live from Horizon
                </p>
              </div>
            </div>

            <div className="console-monitor">
              {logs.length === 0
                ? <p className="console-line console-line--info">Waiting for USSD connection…</p>
                : logs.map(l => (
                  <p key={l.id} className={`console-line console-line--${l.type}`}>
                    [{l.time}] {l.text}
                  </p>
                ))}
              <div ref={consoleEndRef} />
            </div>

            {lastTxHash && (
              <div className="info-block">
                <span className="info-block__label">Last Transaction Hash</span>
                <p style={{ fontFamily: 'monospace', fontSize: '0.72rem', wordBreak: 'break-all' }}>{lastTxHash}</p>
                <a
                  href={`https://stellar.expert/explorer/${network}/tx/${lastTxHash}`}
                  target="_blank" rel="noreferrer"
                  className="primary-btn"
                  style={{ display: 'inline-flex', marginTop: '8px', textDecoration: 'none', padding: '8px 14px', fontSize: '0.82rem' }}
                >
                  🔍 View on Stellar.Expert
                </a>
              </div>
            )}

            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
              <button className="primary-btn" onClick={() => { void refreshBalance(activeAddress, network); void loadTxHistory(activeAddress, network); addLog('Manual refresh.', 'info'); }}>
                🔄 Refresh Now
              </button>
              <button className="ghost-btn" onClick={() => { setLogs([]); addLog('Console cleared.', 'info'); }}>
                Clear Console
              </button>
            </div>
          </div>
        </article>

        {/* SIM Contacts — keyed per wallet address */}
        <WalletBank
          onSelect={handleContactSelect}
          walletAddress={profile!.walletAddress}
        />

        {/* Tx History */}
        <article className="card card--education">
          <div className="card__header">
            <div>
              <p className="card__label">{NETWORKS[network].name} · Horizon</p>
              <h2>Transaction History</h2>
            </div>
            <button className="ghost-btn" style={{ padding: '6px 12px', fontSize: '0.78rem' }}
              onClick={() => void loadTxHistory(activeAddress, network)}>
              Refresh
            </button>
          </div>
          {txHistoryLoading
            ? <p style={{ color: '#94a3b8', fontSize: '0.85rem' }}>Loading from Horizon…</p>
            : txHistory.length === 0
              ? <p style={{ color: '#64748b', fontSize: '0.85rem' }}>No transactions found for this address.</p>
              : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {txHistory.map(tx => (
                    <div key={tx.id} className="tx-row">
                      <div className="tx-row__icon">{tx.from === activeAddress ? '↑' : '↓'}</div>
                      <div className="tx-row__info">
                        <span className="tx-row__label">{tx.from === activeAddress ? 'Sent to' : 'Received from'}</span>
                        <span className="tx-row__addr">{formatAddress(tx.from === activeAddress ? tx.to : tx.from)}</span>
                      </div>
                      <div className="tx-row__amount">
                        <span className={tx.from === activeAddress ? 'amount--sent' : 'amount--recv'}>
                          {tx.from === activeAddress ? '-' : '+'}{tx.amount} {tx.asset}
                        </span>
                        <span className="tx-row__time">{new Date(tx.createdAt).toLocaleTimeString()}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
        </article>

      </section>
    </main>
  );
}
