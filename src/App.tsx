import { useCallback, useEffect, useRef, useState } from 'react';
import * as freighterApi from '@stellar/freighter-api';
import * as StellarSdk from '@stellar/stellar-sdk';
import WalletBank, { ContactEntry } from './WalletBank';
import {
  buildPaymentXdr,
  fetchBalance,
  fetchRecentTransactions,
  formatAddress,
  formatXlm,
  fundWithFriendbot,
  getErrorMessage,
  isValidPublicKey,
  submitFeeBumped,
  TESTNET_HORIZON_URL,
  TESTNET_NETWORK_PASSPHRASE,
} from './lib/stellar';

// ─── Types ──────────────────────────────────────────────────────────────────

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function loadProfile(): UserProfile | null {
  try {
    const raw = localStorage.getItem('stellar-sim-profile-v2');
    if (raw) return JSON.parse(raw);
  } catch { /**/ }
  return null;
}

function saveProfile(p: UserProfile) {
  localStorage.setItem('stellar-sim-profile-v2', JSON.stringify(p));
}

function clearProfile() {
  localStorage.removeItem('stellar-sim-profile-v2');
}

function getSponsorKeypair(): StellarSdk.Keypair {
  let secret = localStorage.getItem('stellar-ussd-sponsor-v2');
  if (secret) {
    try { return StellarSdk.Keypair.fromSecret(secret); } catch { /**/ }
  }
  const kp = StellarSdk.Keypair.random();
  localStorage.setItem('stellar-ussd-sponsor-v2', kp.secret());
  return kp;
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {

  // --- Registration ---
  const existingProfile = loadProfile();
  const [isRegistered, setIsRegistered] = useState<boolean>(!!existingProfile);
  const [regName, setRegName] = useState(existingProfile?.name ?? '');
  const [regPhone, setRegPhone] = useState(existingProfile?.phone ?? '+254712345678');
  const [regPin, setRegPin] = useState(existingProfile?.pin ?? '');
  const [regWalletAddr, setRegWalletAddr] = useState(existingProfile?.walletAddress ?? '');
  const [regLoading, setRegLoading] = useState(false);
  const [regError, setRegError] = useState<string | null>(null);

  // --- Freighter Wallet ---
  const [freighterConnected, setFreighterConnected] = useState(false);
  const [freighterAddress, setFreighterAddress] = useState('');
  const [freighterLoading, setFreighterLoading] = useState(false);

  // --- Sponsor (gateway that pays fees) ---
  const [sponsorKp] = useState<StellarSdk.Keypair>(getSponsorKeypair);
  const [sponsorBalance, setSponsorBalance] = useState('0');
  const [sponsorReady, setSponsorReady] = useState(false);

  // --- Wallet Balance (real-time) ---
  const [walletBalance, setWalletBalance] = useState('0');
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [lastBalanceAt, setLastBalanceAt] = useState<Date | null>(null);
  const balancePollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // --- Transaction History ---
  const [txHistory, setTxHistory] = useState<PaymentRecord[]>([]);
  const [txHistoryLoading, setTxHistoryLoading] = useState(false);

  // --- Phone Simulator ---
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
  const consoleEnd = useRef<HTMLDivElement>(null);

  // ── Scroll log to bottom ──
  useEffect(() => { consoleEnd.current?.scrollIntoView({ behavior: 'smooth' }); }, [logs]);

  const addLog = useCallback((text: string, type: LogEntry['type'] = 'info') => {
    const time = new Date().toLocaleTimeString();
    setLogs(p => [...p, { id: `${Date.now()}-${Math.random()}`, text, type, time }]);
  }, []);

  // ── Active wallet address (prefer Freighter, fallback to registered address) ──
  const activeAddress = freighterConnected ? freighterAddress : (existingProfile?.walletAddress ?? regWalletAddr);

  // ── Boot: Initialize sponsor account ──
  useEffect(() => {
    const init = async () => {
      addLog('Gateway Relayer initializing…', 'info');
      addLog(`Sponsor key: ${formatAddress(sponsorKp.publicKey())}`, 'info');
      const server = new StellarSdk.Horizon.Server(TESTNET_HORIZON_URL);
      try {
        const acct = await server.loadAccount(sponsorKp.publicKey());
        const bal = acct.balances.find((b: any) => b.asset_type === 'native')?.balance ?? '0';
        setSponsorBalance(bal);
        setSponsorReady(true);
        addLog(`Sponsor ready. Balance: ${formatXlm(bal)} XLM`, 'success');
      } catch {
        addLog('Sponsor account not found — calling Friendbot…', 'warning');
        const ok = await fundWithFriendbot(sponsorKp.publicKey());
        if (ok) {
          try {
            const acct = await server.loadAccount(sponsorKp.publicKey());
            const bal = acct.balances.find((b: any) => b.asset_type === 'native')?.balance ?? '0';
            setSponsorBalance(bal);
            setSponsorReady(true);
            addLog(`Sponsor funded! Balance: ${formatXlm(bal)} XLM`, 'success');
          } catch (e) { addLog(`Sponsor balance check failed: ${getErrorMessage(e)}`, 'error'); }
        } else { addLog('Friendbot failed. Refresh to retry.', 'error'); }
      }
    };
    void init();
  }, []);

  // ── Balance: poll every 15 seconds whenever we have an address ──
  const refreshBalance = useCallback(async (address: string) => {
    if (!address) return;
    setBalanceLoading(true);
    try {
      const bal = await fetchBalance(address);
      setWalletBalance(bal);
      setLastBalanceAt(new Date());
    } catch {
      setWalletBalance('0');
    } finally { setBalanceLoading(false); }
  }, []);

  useEffect(() => {
    if (!isRegistered || !activeAddress) return;
    void refreshBalance(activeAddress);
    balancePollRef.current = setInterval(() => void refreshBalance(activeAddress), 15_000);
    return () => { if (balancePollRef.current) clearInterval(balancePollRef.current); };
  }, [isRegistered, activeAddress]);

  // ── Tx History ──
  const loadTxHistory = useCallback(async (address: string) => {
    if (!address) return;
    setTxHistoryLoading(true);
    try {
      const records = await fetchRecentTransactions(address);
      const mapped: PaymentRecord[] = records.map((r: any) => ({
        id: r.id,
        type: r.type,
        from: r.from ?? r.source_account ?? '',
        to: r.to ?? r.into ?? '',
        amount: r.amount ?? r.starting_balance ?? '?',
        asset: r.asset_type === 'native' ? 'XLM' : `${r.asset_code ?? '?'}`,
        createdAt: r.created_at,
      }));
      setTxHistory(mapped);
    } catch { setTxHistory([]); } finally { setTxHistoryLoading(false); }
  }, []);

  useEffect(() => {
    if (isRegistered && activeAddress) void loadTxHistory(activeAddress);
  }, [isRegistered, activeAddress]);

  // ── Registration ──
  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setRegError(null);
    if (!regName.trim()) { setRegError('Name is required.'); return; }
    if (!regPhone.trim()) { setRegError('Phone number is required.'); return; }
    if (regPin.length !== 4) { setRegError('PIN must be exactly 4 digits.'); return; }
    if (!isValidPublicKey(regWalletAddr.trim())) { setRegError('Enter a valid Stellar public key (starts with G, 56 characters).'); return; }

    setRegLoading(true);
    addLog(`Registering SIM for ${regName} — linking ${regPhone} → ${formatAddress(regWalletAddr.trim())}`, 'info');

    // Check if address is active on chain
    const server = new StellarSdk.Horizon.Server(TESTNET_HORIZON_URL);
    try {
      await server.loadAccount(regWalletAddr.trim());
      addLog('Wallet address found on testnet!', 'success');
    } catch {
      addLog('Address not found on testnet. Requesting Friendbot activation…', 'warning');
      const ok = await fundWithFriendbot(regWalletAddr.trim());
      if (!ok) {
        setRegError('Could not activate this address on testnet. Make sure it is a valid Stellar testnet key.');
        setRegLoading(false);
        return;
      }
      addLog('Friendbot funded wallet successfully!', 'success');
    }

    const profile: UserProfile = {
      name: regName.trim(),
      phone: regPhone.trim(),
      pin: regPin,
      walletAddress: regWalletAddr.trim(),
    };
    saveProfile(profile);
    setIsRegistered(true);
    addLog(`SIM registered. Wallet: ${formatAddress(regWalletAddr.trim())}`, 'success');
    setRegLoading(false);
  };

  // ── Connect Freighter ──
  const connectFreighter = async () => {
    setFreighterLoading(true);
    try {
      const access = await freighter.requestAccess();
      if (access?.error) throw new Error(access.error.message ?? 'Freighter denied access.');
      const addr = access.address;
      setFreighterAddress(addr);
      setFreighterConnected(true);
      addLog(`Freighter connected: ${formatAddress(addr)}`, 'success');
      void refreshBalance(addr);
    } catch (e) { addLog(`Freighter error: ${getErrorMessage(e)}`, 'error'); }
    finally { setFreighterLoading(false); }
  };

  const disconnectFreighter = () => {
    setFreighterConnected(false);
    setFreighterAddress('');
    addLog('Freighter disconnected. Using registered wallet address.', 'info');
  };

  // ── Sign-out ──
  const signOut = () => {
    clearProfile();
    setIsRegistered(false);
    setRegName(''); setRegPhone('+254712345678'); setRegPin(''); setRegWalletAddr('');
    setFreighterConnected(false); setFreighterAddress('');
    setWalletBalance('0'); setTxHistory([]);
    setScreen('IDLE');
    addLog('SIM profile cleared. Redirecting to registration…', 'warning');
  };

  // ── Phone key handler ──
  const handleKey = (key: string) => {
    if (screen === 'IDLE') {
      if (key === '*' || (key >= '0' && key <= '9')) { setDialString(key); setScreen('DIALING'); }
    } else if (screen === 'DIALING') {
      if (key === 'END') { setDialString(''); setScreen('IDLE'); }
      else if (key === 'BACK') { const n = dialString.slice(0,-1); n === '' ? setScreen('IDLE') : setDialString(n); }
      else if (key === 'CALL') {
        if (dialString === '*123#') { addLog(`USSD session started (${regPhone})`, 'info'); setMenuIndex(0); setScreen('MENU'); }
        else { setLastError('Invalid code. Try *123#'); setScreen('ERROR'); }
      } else { setDialString(d => d + key); }
    } else if (screen === 'MENU') {
      if (key === 'END') { setScreen('IDLE'); addLog('USSD session closed.', 'info'); }
      else if (key === '1') { void refreshBalance(activeAddress); setMenuIndex(0); setScreen('BALANCE'); }
      else if (key === '2') { setDestInput(''); setDestName(''); setAmountInput(''); setScreen('SEND_DEST'); }
      else if (key === '3') { void loadTxHistory(activeAddress); setScreen('TXHISTORY'); }
      else if (key === '4') { signOut(); }
      else if (key === 'UP') { setMenuIndex(p => p > 0 ? p-1 : 3); }
      else if (key === 'DOWN') { setMenuIndex(p => p < 3 ? p+1 : 0); }
      else if (key === 'SELECT') { handleKey((menuIndex+1).toString()); }
    } else if (screen === 'BALANCE' || screen === 'TXHISTORY') {
      if (key === 'BACK' || key === 'END' || key === 'SELECT') setScreen('MENU');
    } else if (screen === 'SEND_DEST') {
      if (key === 'BACK') { setScreen('MENU'); }
      else if (key === 'END') { setScreen('IDLE'); }
      else if ((key === 'CALL' || key === 'SELECT') && destInput.length >= 20) {
        setScreen('SEND_AMOUNT');
      }
    } else if (screen === 'SEND_AMOUNT') {
      if (key === 'BACK') { setScreen('SEND_DEST'); }
      else if (key === 'END') { setScreen('IDLE'); }
      else if ((key === 'CALL' || key === 'SELECT') && Number(amountInput) > 0) {
        setPinInput(''); setScreen('CONFIRM_PIN');
      } else if (key === '*') { setAmountInput(a => a.includes('.') ? a : a + '.'); }
      else if (key >= '0' && key <= '9') { setAmountInput(a => a + key); }
    } else if (screen === 'CONFIRM_PIN') {
      if (key === 'BACK') { setScreen('SEND_AMOUNT'); }
      else if (key === 'END') { setScreen('IDLE'); }
      else if (key === 'CALL' || key === 'SELECT') {
        if (pinInput === regPin) { void processTransaction(); }
        else { setLastError('Incorrect PIN. Transaction cancelled.'); setScreen('ERROR'); }
      } else if (key >= '0' && key <= '9' && pinInput.length < 4) { setPinInput(p => p + key); }
    } else if (screen === 'SUCCESS' || screen === 'ERROR') {
      if (key === 'END' || key === 'BACK' || key === 'SELECT') setScreen('IDLE');
    }
  };

  // ── Real Transaction ──
  const processTransaction = async () => {
    setScreen('TRANSMITTING');
    addLog(`Building payment: ${amountInput} XLM → ${formatAddress(destInput)}`, 'info');

    try {
      // 1. Build unsigned XDR from the source account
      const xdr = await buildPaymentXdr(activeAddress, destInput, amountInput);
      addLog('Transaction XDR built. Requesting Freighter signature…', 'info');

      // 2. Sign with Freighter (or if not connected, inform user)
      if (!freighterConnected) {
        throw new Error('Freighter wallet not connected. Please connect Freighter first to sign transactions.');
      }

      const signed = await freighter.signTransaction(xdr, {
        accountToSign: activeAddress,
        networkPassphrase: TESTNET_NETWORK_PASSPHRASE,
      });

      if (signed?.error) throw new Error(signed.error.message ?? 'Freighter signing failed.');
      const signedXdr: string = signed?.signedTxXdr ?? signed?.signedTx ?? signed;
      if (!signedXdr) throw new Error('Freighter returned empty signed transaction.');

      addLog('Transaction signed. Wrapping in Fee-Bump envelope…', 'info');

      // 3. Wrap in fee-bump (Gateway pays fees) and submit
      const response: any = await submitFeeBumped(signedXdr, sponsorKp.secret());

      addLog(`✅ Broadcast successful! Ledger: ${response.ledger}`, 'success');
      addLog(`Hash: ${response.hash}`, 'success');
      setLastTxHash(response.hash);

      // 4. Refresh balance and history
      void refreshBalance(activeAddress);
      void loadTxHistory(activeAddress);

      // 5. Refresh sponsor balance
      try {
        const newBal = await fetchBalance(sponsorKp.publicKey());
        setSponsorBalance(newBal);
      } catch { /**/ }

      setScreen('SUCCESS');
    } catch (e) {
      const msg = getErrorMessage(e);
      addLog(`Transaction failed: ${msg}`, 'error');
      setLastError(msg);
      setScreen('ERROR');
    }
  };

  // ── Contact select from SIM Book ──
  const handleContactSelect = (c: ContactEntry) => {
    setDestInput(c.address);
    setDestName(c.label);
    addLog(`Contact loaded: "${c.label}" → ${formatAddress(c.address)}`, 'info');
    setScreen('SEND_AMOUNT');
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // RENDER — Registration Screen
  // ─────────────────────────────────────────────────────────────────────────────
  if (!isRegistered) {
    return (
      <main className="shell">
        <div className="reg-screen">
          <div className="reg-card">
            <div className="reg-header">
              <div className="reg-logo">📡</div>
              <h1>Stellar Last-Mile Bridge</h1>
              <p>Register your SIM profile to start transacting on the Stellar Testnet without internet.</p>
            </div>

            <form onSubmit={handleRegister}>
              <div className="reg-field">
                <label>Full Name</label>
                <input
                  type="text" value={regName}
                  onChange={e => setRegName(e.target.value)}
                  placeholder="e.g. Amara Diallo"
                  required
                />
              </div>

              <div className="reg-field">
                <label>Phone Number <span className="reg-hint">(GSM SIM identity)</span></label>
                <input
                  type="text" value={regPhone}
                  onChange={e => setRegPhone(e.target.value)}
                  placeholder="+254712345678"
                  required
                />
              </div>

              <div className="reg-field">
                <label>Stellar Wallet Address <span className="reg-hint">(Public key, starts with G)</span></label>
                <input
                  type="text" value={regWalletAddr}
                  onChange={e => setRegWalletAddr(e.target.value)}
                  placeholder="GXXXXXX…"
                  required
                  className={regWalletAddr && !isValidPublicKey(regWalletAddr) ? 'input--invalid' : regWalletAddr && isValidPublicKey(regWalletAddr) ? 'input--valid' : ''}
                />
                {regWalletAddr && isValidPublicKey(regWalletAddr) && (
                  <div className="reg-derived">
                    <span className="reg-derived__label">✅ Valid Stellar address</span>
                    <span className="reg-derived__addr">{regWalletAddr}</span>
                  </div>
                )}
                {regWalletAddr && !isValidPublicKey(regWalletAddr) && (
                  <div className="reg-derived reg-derived--err">
                    <span>⚠️ Invalid address format</span>
                  </div>
                )}
              </div>

              <div className="reg-field">
                <label>4-Digit Wallet PIN <span className="reg-hint">(used to confirm payments on phone)</span></label>
                <input
                  type="password" value={regPin}
                  onChange={e => setRegPin(e.target.value.replace(/\D/g,'').slice(0,4))}
                  placeholder="••••"
                  maxLength={4}
                  required
                />
              </div>

              {regError && <div className="reg-error">⚠ {regError}</div>}

              <button className="reg-submit" type="submit" disabled={regLoading}>
                {regLoading ? 'Activating SIM on Stellar Testnet…' : '🚀 Activate SIM & Start Transacting'}
              </button>
            </form>

            <div className="reg-info">
              <div>📡 Your wallet address is linked to your phone number.</div>
              <div>🔐 Your PIN is stored locally and never transmitted.</div>
              <div>⚡ Transactions are sponsored — you pay 0 XLM in fees.</div>
            </div>
          </div>
        </div>
      </main>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // RENDER — Main Dashboard
  // ─────────────────────────────────────────────────────────────────────────────
  const profile = loadProfile()!;

  return (
    <main className="shell">
      {/* ── Hero ── */}
      <section className="hero">
        <div className="hero__copy">
          <p className="eyebrow">Stellar Last-Mile · Active SIM</p>
          <h1>Offline Payment Bridge</h1>
          <p className="lede">
            Welcome, <strong>{profile.name}</strong>. Your SIM card is active and linked to{' '}
            <code>{profile.phone}</code>.<br/>
            Dial <strong>*123#</strong> on the phone below to start transacting.
          </p>

          {/* Real-time balance display */}
          <div className="balance-hero">
            <div className="balance-hero__label">Live Wallet Balance</div>
            <div className="balance-hero__value">
              {balanceLoading ? 'Fetching…' : `${formatXlm(walletBalance)} XLM`}
            </div>
            <div className="balance-hero__meta">
              {lastBalanceAt ? `Last updated ${lastBalanceAt.toLocaleTimeString()} · auto-refreshes every 15s` : 'Loading…'}
            </div>
            <div className="balance-hero__addr">{activeAddress}</div>
          </div>
        </div>

        <div className="hero__panel">
          {/* Freighter connection */}
          <div>
            <p className="card__label">Freighter Wallet</p>
            {freighterConnected ? (
              <div>
                <div className="freighter-connected">
                  <span className="dot dot--green" />
                  <span>{formatAddress(freighterAddress)}</span>
                </div>
                <button className="ghost-btn" style={{marginTop:'8px',width:'100%'}} onClick={disconnectFreighter}>
                  Disconnect
                </button>
              </div>
            ) : (
              <button className="primary-btn" style={{width:'100%',marginTop:'6px'}} onClick={connectFreighter} disabled={freighterLoading}>
                {freighterLoading ? 'Connecting…' : '🦊 Connect Freighter to Sign'}
              </button>
            )}
            {!freighterConnected && (
              <p className="lede" style={{fontSize:'0.72rem',marginTop:'8px',color:'#ef4444'}}>
                ⚠ Connect Freighter to execute real transactions.
              </p>
            )}
          </div>

          <div className="info-block">
            <span className="info-block__label">Active Address</span>
            <p style={{fontSize:'0.78rem',wordBreak:'break-all',fontFamily:'monospace'}}>
              {activeAddress || '—'}
            </p>
          </div>

          <button className="ghost-btn" style={{width:'100%'}} onClick={signOut}>
            🔒 Sign Out / Change Profile
          </button>
        </div>
      </section>

      {/* ── Main Grid ── */}
      <section className="grid">

        {/* ─ Phone Simulator ─ */}
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

              {/* LCD */}
              <div className="phone-screen-frame">
                <div className="phone-screen">
                  <div className="screen-header">
                    <span>📶 Safaricom</span>
                    <span>🔋</span>
                  </div>
                  <div className="screen-body">
                    {screen === 'IDLE' && (
                      <div className="screen-idle">
                        <div className="screen-name">{profile.name.split(' ')[0]}'s SIM</div>
                        <div className="screen-hint">Dial *123# ▶ Call</div>
                      </div>
                    )}
                    {screen === 'DIALING' && (
                      <div className="screen-dial">
                        <span>{dialString}</span>
                        <span className="lcd-cursor" />
                      </div>
                    )}
                    {screen === 'MENU' && (
                      <div>
                        <div className="menu-title">Stellar USSD</div>
                        {['1. Check Balance','2. Send XLM','3. Tx History','4. Sign Out'].map((opt, i) => (
                          <div key={i} className={`menu-option ${menuIndex === i ? 'menu-option--selected' : ''}`}>{opt}</div>
                        ))}
                      </div>
                    )}
                    {screen === 'BALANCE' && (
                      <div>
                        <div className="menu-title">Balance</div>
                        <div className="screen-balance">
                          {balanceLoading ? 'Querying…' : `${formatXlm(walletBalance)} XLM`}
                        </div>
                        <div className="screen-subtext">{formatAddress(activeAddress)}</div>
                      </div>
                    )}
                    {screen === 'TXHISTORY' && (
                      <div>
                        <div className="menu-title">Recent Txs</div>
                        {txHistoryLoading ? <div className="screen-subtext">Loading…</div>
                          : txHistory.length === 0 ? <div className="screen-subtext">No transactions found.</div>
                          : txHistory.slice(0, 3).map(tx => (
                            <div key={tx.id} className="screen-tx">
                              <span>{tx.from === activeAddress ? '↑ Sent' : '↓ Rcvd'}</span>
                              <span>{tx.amount} {tx.asset}</span>
                            </div>
                          ))
                        }
                      </div>
                    )}
                    {screen === 'SEND_DEST' && (
                      <div>
                        <div className="menu-title">Recipient</div>
                        <div className="screen-subtext">Select from contacts ↓ or paste below:</div>
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
                        <div className="screen-hint">Signing & broadcasting…</div>
                      </div>
                    )}
                    {screen === 'SUCCESS' && (
                      <div className="screen-idle">
                        <div>✅ Sent!</div>
                        <div className="screen-hint">{amountInput} XLM</div>
                        <div className="screen-subtext" style={{fontSize:'0.5rem'}}>{lastTxHash.slice(0,16)}…</div>
                      </div>
                    )}
                    {screen === 'ERROR' && (
                      <div>
                        <div style={{color:'#7f1d1d',fontWeight:'bold'}}>⚠ Error</div>
                        <div className="screen-subtext" style={{maxHeight:'90px',overflowY:'auto',fontSize:'0.56rem'}}>{lastError}</div>
                      </div>
                    )}
                  </div>
                  <div className="screen-footer">
                    <span>{['MENU','SEND_DEST','SEND_AMOUNT','CONFIRM_PIN'].includes(screen) ? 'Back' : ''}</span>
                    <span>{screen === 'IDLE' ? 'Dial' : 'OK'}</span>
                  </div>
                </div>
              </div>

              {/* Softkeys */}
              <div className="phone-softkeys">
                <button className="phone-btn phone-btn--soft" onClick={() => handleKey('BACK')}>⬅ Back</button>
                <button className="phone-btn phone-btn--soft" onClick={() => handleKey('UP')}>▲</button>
                <button className="phone-btn phone-btn--soft" onClick={() => handleKey('SELECT')}>OK</button>
              </div>
              <div className="phone-softkeys" style={{marginTop:'8px'}}>
                <button className="phone-btn phone-btn--call" onClick={() => handleKey('CALL')}>📞</button>
                <button className="phone-btn phone-btn--soft" onClick={() => handleKey('DOWN')}>▼</button>
                <button className="phone-btn phone-btn--end" onClick={() => handleKey('END')}>❌</button>
              </div>
              <div className="phone-keypad">
                {[
                  ['1','o_o'],['2','abc'],['3','def'],
                  ['4','ghi'],['5','jkl'],['6','mno'],
                  ['7','pqrs'],['8','tuv'],['9','wxyz'],
                  ['*','.'],['0','sp'],['#','#'],
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

        {/* ─ Gateway Console ─ */}
        <article className="card card--gateway">
          <div className="card__header">
            <div>
              <p className="card__label">Cellular Relayer Gateway</p>
              <h2>Broadcast Console</h2>
            </div>
            <span className="state-pill state-pill--accent">Fee-Bump Active</span>
          </div>

          <div className="gateway-console">
            {/* Sponsor & user info */}
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'12px'}}>
              <div className="info-block">
                <span className="info-block__label">Gateway Sponsor</span>
                <p style={{fontFamily:'monospace',fontSize:'0.75rem'}}>{formatAddress(sponsorKp.publicKey())}</p>
                <p style={{fontWeight:'bold',marginTop:'4px'}}>{formatXlm(sponsorBalance)} XLM</p>
              </div>
              <div className="info-block">
                <span className="info-block__label">Your Wallet (Live)</span>
                <p style={{fontFamily:'monospace',fontSize:'0.75rem'}}>{formatAddress(activeAddress)}</p>
                <p style={{fontWeight:'bold',marginTop:'4px',color: balanceLoading ? '#94a3b8' : '#4ade80'}}>
                  {balanceLoading ? 'Refreshing…' : `${formatXlm(walletBalance)} XLM`}
                </p>
              </div>
            </div>

            {/* Console log */}
            <div className="console-monitor">
              {logs.length === 0
                ? <p className="console-line console-line--info">Waiting for USSD connection…</p>
                : logs.map(l => (
                  <p key={l.id} className={`console-line console-line--${l.type}`}>
                    [{l.time}] {l.text}
                  </p>
                ))
              }
              <div ref={consoleEnd} />
            </div>

            {/* Last tx hash */}
            {lastTxHash && (
              <div className="info-block">
                <span className="info-block__label">Last Transaction Hash</span>
                <p style={{fontFamily:'monospace',fontSize:'0.75rem',wordBreak:'break-all'}}>{lastTxHash}</p>
                <a
                  href={`https://stellar.expert/explorer/testnet/tx/${lastTxHash}`}
                  target="_blank" rel="noreferrer"
                  className="primary-btn"
                  style={{display:'inline-flex',marginTop:'8px',textDecoration:'none',padding:'8px 14px',fontSize:'0.82rem'}}
                >
                  🔍 View on Stellar.Expert
                </a>
              </div>
            )}

            {/* Actions */}
            <div style={{display:'flex',gap:'10px',flexWrap:'wrap'}}>
              <button className="primary-btn" onClick={() => { void refreshBalance(activeAddress); void loadTxHistory(activeAddress); addLog('Manual refresh triggered.','info'); }}>
                🔄 Refresh Now
              </button>
              <button className="ghost-btn" onClick={() => { setLogs([]); addLog('Console cleared.','info'); }}>
                Clear Console
              </button>
            </div>
          </div>
        </article>

        {/* ─ SIM Contacts ─ */}
        <WalletBank onSelect={handleContactSelect} />

        {/* ─ Tx History ─ */}
        <article className="card card--education">
          <div className="card__header">
            <div>
              <p className="card__label">Stellar Testnet</p>
              <h2>Transaction History</h2>
            </div>
            <button className="ghost-btn" style={{padding:'6px 12px',fontSize:'0.78rem'}} onClick={() => void loadTxHistory(activeAddress)}>
              Refresh
            </button>
          </div>
          {txHistoryLoading
            ? <p style={{color:'#94a3b8',fontSize:'0.85rem'}}>Loading history from Horizon…</p>
            : txHistory.length === 0
              ? <p style={{color:'#64748b',fontSize:'0.85rem'}}>No recent transactions found for this address.</p>
              : (
                <div style={{display:'flex',flexDirection:'column',gap:'10px'}}>
                  {txHistory.map(tx => (
                    <div key={tx.id} className="tx-row">
                      <div className="tx-row__icon">
                        {tx.from === activeAddress ? '↑' : '↓'}
                      </div>
                      <div className="tx-row__info">
                        <span className="tx-row__label">
                          {tx.from === activeAddress ? 'Sent to' : 'Received from'}
                        </span>
                        <span className="tx-row__addr">
                          {formatAddress(tx.from === activeAddress ? tx.to : tx.from)}
                        </span>
                      </div>
                      <div className="tx-row__amount">
                        <span className={tx.from === activeAddress ? 'amount--sent' : 'amount--recv'}>
                          {tx.from === activeAddress ? '-' : '+'}{tx.amount} {tx.asset}
                        </span>
                        <span className="tx-row__time">
                          {new Date(tx.createdAt).toLocaleTimeString()}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )
          }
        </article>
      </section>
    </main>
  );
}
