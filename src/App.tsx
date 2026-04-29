import { FormEvent, useEffect, useMemo, useState } from 'react';
import * as freighterApi from '@stellar/freighter-api';
import * as StellarSdk from '@stellar/stellar-sdk';
import WalletBank from './WalletBank';

type BalanceState = {
  value: string;
  loading: boolean;
  error: string | null;
};

type TxState = {
  kind: 'idle' | 'success' | 'error' | 'pending';
  message: string;
  hash: string;
};

type DemoMode = 'none' | 'connected' | 'balance' | 'success';

const freighter = freighterApi as any;
const horizonServer = new StellarSdk.Horizon.Server('https://horizon-testnet.stellar.org');
const networkPassphrase = StellarSdk.Networks.TESTNET;
const demoAddress = 'GDSVYYICF3NRSXGLXQDZBVM337DPXI5TYBGIKWFMUCABWV7H2RKNP7QV';
const demoHash = '2e7f4c40f5e6d2ef9c70a0f39ff66d5b0d5d5a6c4d1b8c3f0f8a12d9b4c8f77a';
const contactImage = '/screenshots/contact%20us.png';

function getDemoMode(): DemoMode {
  if (typeof window === 'undefined') {
    return 'none';
  }

  const mode = new URLSearchParams(window.location.search).get('demo');

  if (mode === 'connected' || mode === 'balance' || mode === 'success') {
    return mode;
  }

  return 'none';
}

function getInitialBalance(mode: DemoMode): BalanceState {
  if (mode === 'balance' || mode === 'success') {
    return {
      value: '125.5',
      loading: false,
      error: null,
    };
  }

  return {
    value: '0',
    loading: false,
    error: null,
  };
}

function getInitialTransactionState(mode: DemoMode): TxState {
  if (mode === 'success') {
    return {
      kind: 'success',
      message: 'Transaction submitted successfully on Stellar testnet.',
      hash: demoHash,
    };
  }

  return {
    kind: 'idle',
    message: 'Connect Freighter to start moving testnet XLM.',
    hash: '',
  };
}

function formatAddress(address: string) {
  if (address.length <= 14) {
    return address;
  }

  return `${address.slice(0, 6)}…${address.slice(-6)}`;
}

function formatBalance(balance: string) {
  const parsed = Number(balance);

  if (Number.isNaN(parsed)) {
    return balance;
  }

  return parsed.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 7,
  });
}

function extractErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  return 'Something went wrong while completing the request.';
}

async function fetchNativeBalance(publicKey: string) {
  const account = await horizonServer.loadAccount(publicKey);
  const nativeBalance = account.balances.find((entry: any) => entry.asset_type === 'native');

  return nativeBalance?.balance ?? '0';
}

export default function App() {
  const demoMode = getDemoMode();
  const [publicKey, setPublicKey] = useState(() => (demoMode === 'none' ? '' : demoAddress));
  const [walletError, setWalletError] = useState<string | null>(null);
  const [walletLoading, setWalletLoading] = useState(false);
  const [balanceState, setBalanceState] = useState<BalanceState>(() => getInitialBalance(demoMode));
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('1');
  const [transactionState, setTransactionState] = useState<TxState>(() => getInitialTransactionState(demoMode));

  const isConnected = publicKey.length > 0;

  useEffect(() => {
    if (!publicKey || demoMode !== 'none') {
      return;
    }

    let isActive = true;

    const refresh = async () => {
      setBalanceState((current) => ({ ...current, loading: true, error: null }));

      try {
        const balance = await fetchNativeBalance(publicKey);
        if (isActive) {
          setBalanceState({ value: balance, loading: false, error: null });
        }
      } catch (error) {
        if (isActive) {
          setBalanceState({
            value: '0',
            loading: false,
            error: extractErrorMessage(error),
          });
        }
      }
    };

    void refresh();

    return () => {
      isActive = false;
    };
  }, [demoMode, publicKey]);

  const statusTone = useMemo(() => {
    if (transactionState.kind === 'success') {
      return 'success';
    }

    if (transactionState.kind === 'error') {
      return 'error';
    }

    if (transactionState.kind === 'pending') {
      return 'pending';
    }

    return 'neutral';
  }, [transactionState.kind]);

  async function connectWallet() {
    setWalletLoading(true);
    setWalletError(null);

    try {
      const access = await freighter.requestAccess();
      if (access?.error) {
        throw new Error(access.error.message ?? 'Freighter could not grant wallet access.');
      }

      setPublicKey(access.address);
      setTransactionState({
        kind: 'idle',
        message: 'Wallet connected. Your balance will load automatically.',
        hash: '',
      });
    } catch (error) {
      setWalletError(extractErrorMessage(error));
    } finally {
      setWalletLoading(false);
    }
  }

  function disconnectWallet() {
    setPublicKey('');
    setRecipient('');
    setAmount('1');
    setWalletError(null);
    setBalanceState({ value: '0', loading: false, error: null });
    setTransactionState({
      kind: 'idle',
      message: 'Wallet disconnected. Reconnect Freighter to continue.',
      hash: '',
    });
  }

  async function refreshBalance() {
    if (!publicKey) {
      return;
    }

    setBalanceState((current) => ({ ...current, loading: true, error: null }));

    try {
      const balance = await fetchNativeBalance(publicKey);
      setBalanceState({ value: balance, loading: false, error: null });
    } catch (error) {
      setBalanceState({
        value: '0',
        loading: false,
        error: extractErrorMessage(error),
      });
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!publicKey) {
      setTransactionState({
        kind: 'error',
        message: 'Connect your wallet before sending a transaction.',
        hash: '',
      });
      return;
    }

    if (demoMode !== 'none') {
      setTransactionState({
        kind: 'success',
        message: 'Demo payment completed successfully on Stellar testnet.',
        hash: demoHash,
      });

      return;
    }

    if (!StellarSdk.StrKey.isValidEd25519PublicKey(recipient.trim())) {
      setTransactionState({
        kind: 'error',
        message: 'Enter a valid Stellar public key that starts with G.',
        hash: '',
      });
      return;
    }

    if (!amount.trim() || Number(amount) <= 0) {
      setTransactionState({
        kind: 'error',
        message: 'Enter an amount greater than zero.',
        hash: '',
      });
      return;
    }

    setTransactionState({
      kind: 'pending',
      message: 'Preparing and signing the testnet payment…',
      hash: '',
    });

    try {
      const sourceAccount = await horizonServer.loadAccount(publicKey);
      const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase,
      })
        .addOperation(
          StellarSdk.Operation.payment({
            destination: recipient.trim(),
            asset: StellarSdk.Asset.native(),
            amount: Number(amount).toFixed(7).replace(/0+$/, '').replace(/\.$/, ''),
          }),
        )
        .setTimeout(30)
        .build();

      const signedTransaction = await freighter.signTransaction(transaction.toXDR(), {
        accountToSign: publicKey,
        networkPassphrase,
      });

      if (signedTransaction?.error) {
        throw new Error(signedTransaction.error.message ?? 'Freighter could not sign the transaction.');
      }

      const signedXdr = signedTransaction?.signedTxXdr ?? signedTransaction?.signedTx;
      if (!signedXdr) {
        throw new Error('Freighter returned an invalid signed transaction.');
      }

      const signedTxObj = StellarSdk.TransactionBuilder.fromXDR(signedXdr, networkPassphrase);
      const response = await horizonServer.submitTransaction(signedTxObj);

      setTransactionState({
        kind: 'success',
        message: 'Transaction submitted successfully on Stellar testnet.',
        hash: response.hash,
      });

      await refreshBalance();
    } catch (error) {
      setTransactionState({
        kind: 'error',
        message: extractErrorMessage(error),
        hash: '',
      });
    }
  }

  function downloadReceipt(hash: string, sender: string, dest: string, xlmAmount: string) {
    const canvas = document.createElement('canvas');
    const W = 720;
    const H = 560;
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d')!;

    /* ── Background ── */
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#0b1424');
    bg.addColorStop(1, '#060e1a');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    /* ── Border glow ── */
    ctx.strokeStyle = 'rgba(52, 211, 153, 0.35)';
    ctx.lineWidth = 2;
    ctx.roundRect(16, 16, W - 32, H - 32, 20);
    ctx.stroke();

    /* ── Accent bar ── */
    const accent = ctx.createLinearGradient(40, 0, 260, 0);
    accent.addColorStop(0, '#34d399');
    accent.addColorStop(1, '#22c55e');
    ctx.fillStyle = accent;
    ctx.roundRect(40, 40, 120, 6, 3);
    ctx.fill();

    /* ── Title ── */
    ctx.fillStyle = '#e5eefc';
    ctx.font = 'bold 28px Inter, sans-serif';
    ctx.fillText('Transaction Receipt', 40, 88);

    ctx.fillStyle = '#6b84a8';
    ctx.font = '13px Inter, sans-serif';
    ctx.fillText('Stellar testnet payment receipt', 40, 112);

    /* ── Divider ── */
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(40, 130);
    ctx.lineTo(W - 40, 130);
    ctx.stroke();

    /* ── Fields ── */
    const fields = [
      { label: 'STATUS', value: '✓ Success' },
      { label: 'NETWORK', value: 'Stellar Testnet' },
      { label: 'FROM', value: formatAddress(sender) },
      { label: 'TO', value: dest ? formatAddress(dest) : 'N/A' },
      { label: 'AMOUNT', value: `${xlmAmount} XLM` },
      { label: 'TRANSACTION HASH', value: hash },
      { label: 'DATE', value: new Date().toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'medium' }) },
    ];

    let y = 160;
    for (const field of fields) {
      ctx.fillStyle = '#6b84a8';
      ctx.font = '600 11px Inter, sans-serif';
      ctx.fillText(field.label, 40, y);

      ctx.fillStyle = field.label === 'STATUS' ? '#34d399' : '#d5e2f7';
      ctx.font = field.label === 'TRANSACTION HASH'
        ? '13px SFMono-Regular, Consolas, monospace'
        : '15px Inter, sans-serif';
      ctx.fillText(field.value, 40, y + 20);

      y += 52;
    }

    /* ── Footer ── */
    ctx.fillStyle = 'rgba(148, 163, 184, 0.3)';
    ctx.font = '11px Inter, sans-serif';
    ctx.fillText('Generated locally for Stellar testnet payments', 40, H - 36);

    /* ── Download ── */
    const link = document.createElement('a');
    link.download = `stellar-receipt-${hash.slice(0, 10)}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
  }

  return (
    <main className="shell">
      <section className="hero">
        <div className="hero__copy">
          <p className="eyebrow">Level 1 · Testnet</p>
          <h1>Simple testnet XLM payments with Freighter.</h1>
          <p className="lede">
            Connect a Stellar wallet, check the connected account balance, and send a real testnet
            payment with transaction feedback built into the flow.
          </p>
        </div>

        <div className="hero__panel">
          <span className="badge">Testnet</span>
          <div className="hero__panel-media">
            <img src={contactImage} alt="Contact us" loading="lazy" />
          </div>
          <div>
            <span className="hero__panel-title">Contact card</span>
            <p className="hero__panel-copy">
              A focused Stellar testnet payment demo with Freighter wallet connect, live balance
              checks, and transaction feedback in one simple flow.
            </p>
          </div>
        </div>
      </section>

      <section className="grid">
        <article className="card card--wallet">
          <div className="card__header">
            <div>
              <p className="card__label">Wallet</p>
              <h2>Connection</h2>
            </div>
            <span className={`state-pill state-pill--${isConnected ? 'on' : 'off'}`}>
              {isConnected ? 'Connected' : 'Disconnected'}
            </span>
          </div>

          <div className="wallet-row">
            <button className="primary-btn" onClick={connectWallet} disabled={walletLoading}>
              {walletLoading ? 'Connecting…' : 'Connect Freighter'}
            </button>
            <button className="ghost-btn" onClick={disconnectWallet} disabled={!isConnected}>
              Disconnect
            </button>
          </div>

          <div className="info-block">
            <span className="info-block__label">Connected account</span>
            <p>{isConnected ? formatAddress(publicKey) : 'No wallet connected yet'}</p>
          </div>

          <div className="info-block">
            <span className="info-block__label">Network</span>
            <p>Stellar Testnet</p>
          </div>

          {walletError ? <p className="inline-alert inline-alert--error">{walletError}</p> : null}
        </article>

        <article className="card card--balance">
          <div className="card__header">
            <div>
              <p className="card__label">Balance</p>
              <h2>XLM holdings</h2>
            </div>
            <button className="ghost-btn ghost-btn--small" onClick={refreshBalance} disabled={!isConnected}>
              Refresh
            </button>
          </div>

          <p className="balance-value">
            {balanceState.loading ? 'Loading…' : `${formatBalance(balanceState.value)} XLM`}
          </p>
          <p className="balance-caption">
            {isConnected ? 'Fetched live from the testnet account endpoint.' : 'Connect a wallet to display a live balance.'}
          </p>

          {balanceState.error ? (
            <p className="inline-alert inline-alert--error">{balanceState.error}</p>
          ) : null}
        </article>

        <article className="card card--form">
          <div className="card__header">
            <div>
              <p className="card__label">Transaction</p>
              <h2>Send XLM</h2>
            </div>
            <span className="state-pill state-pill--accent">Testnet only</span>
          </div>

          <form className="form" onSubmit={handleSubmit}>
            <label>
              Destination address
              <input
                type="password"
                value={recipient}
                readOnly
                onPaste={(e) => {
                  e.preventDefault();
                  const pasted = e.clipboardData.getData('text').trim();
                  if (pasted) setRecipient(pasted);
                }}
                onCopy={(e) => e.preventDefault()}
                onCut={(e) => e.preventDefault()}
                onDragStart={(e) => e.preventDefault()}
                placeholder="Paste address here…"
                spellCheck={false}
                autoComplete="off"
                style={{ userSelect: 'none', WebkitUserSelect: 'none' } as React.CSSProperties}
              />
            </label>

            <label>
              Amount in XLM
              <input
                type="number"
                min="0.0000001"
                step="0.0000001"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                placeholder="1.0"
              />
            </label>

            <button className="primary-btn" type="submit" disabled={!isConnected}>
              Send payment
            </button>
          </form>
        </article>

        <WalletBank onSelect={(addr) => setRecipient(addr)} />

        <article className={`card card--feedback card--${statusTone}`}>
          <div className="card__header">
            <div>
              <p className="card__label">Feedback</p>
              <h2>Transaction result</h2>
            </div>
            <span className={`state-pill state-pill--${statusTone}`}>{transactionState.kind}</span>
          </div>

          <p className="feedback-message">{transactionState.message}</p>

          {transactionState.hash ? (
            <>
              <div className="info-block">
                <span className="info-block__label">Transaction hash</span>
                <p className="hash-value">{transactionState.hash}</p>
              </div>

              <button
                className="receipt-btn"
                type="button"
                onClick={() => downloadReceipt(transactionState.hash, publicKey, recipient, amount)}
              >
                ⬇ Download Receipt
              </button>
            </>
          ) : null}
        </article>
      </section>
    </main>
  );
}
