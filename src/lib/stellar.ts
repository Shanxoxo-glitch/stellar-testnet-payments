import * as StellarSdk from '@stellar/stellar-sdk';

// ─── Network Config ───────────────────────────────────────────────────────────

export type NetworkType = 'testnet' | 'mainnet';

export const NETWORKS: Record<NetworkType, { name: string; horizonUrl: string; passphrase: string; friendbot: boolean }> = {
  testnet: {
    name: 'Testnet',
    horizonUrl: 'https://horizon-testnet.stellar.org',
    passphrase: StellarSdk.Networks.TESTNET,
    friendbot: true,
  },
  mainnet: {
    name: 'Mainnet (Public)',
    horizonUrl: 'https://horizon.stellar.org',
    passphrase: StellarSdk.Networks.PUBLIC,
    friendbot: false,
  },
};

export function getServer(network: NetworkType) {
  return new StellarSdk.Horizon.Server(NETWORKS[network].horizonUrl);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function formatAddress(address: string): string {
  if (!address || address.length <= 14) return address ?? '';
  return `${address.slice(0, 8)}…${address.slice(-8)}`;
}

export function formatXlm(balance: string): string {
  const parsed = Number(balance);
  if (Number.isNaN(parsed)) return balance;
  return parsed.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 7,
  });
}

export function isValidPublicKey(key: string): boolean {
  try {
    StellarSdk.StrKey.decodeEd25519PublicKey(key);
    return true;
  } catch {
    return false;
  }
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  const e = error as any;
  if (e?.response?.data?.extras?.result_codes) {
    const codes = e.response.data.extras.result_codes;
    return `Transaction failed: ${JSON.stringify(codes)}`;
  }
  return 'Something went wrong.';
}

// ─── Account / Balance ───────────────────────────────────────────────────────

/**
 * Check whether an account exists on-chain.
 * Returns 'active' | 'inactive' | 'error'
 */
export async function checkAccountStatus(
  address: string,
  network: NetworkType
): Promise<'active' | 'inactive'> {
  try {
    await getServer(network).loadAccount(address);
    return 'active';
  } catch {
    return 'inactive';
  }
}

export async function fetchBalance(address: string, network: NetworkType): Promise<string> {
  const account = await getServer(network).loadAccount(address);
  const native = account.balances.find((b: any) => b.asset_type === 'native');
  return native?.balance ?? '0';
}

export async function fetchRecentTransactions(address: string, network: NetworkType): Promise<any[]> {
  try {
    const payments = await getServer(network).payments()
      .forAccount(address)
      .limit(10)
      .order('desc')
      .call();
    return payments.records;
  } catch {
    return [];
  }
}

// ─── Friendbot ───────────────────────────────────────────────────────────────

export type FriendbotResult = 'funded' | 'already_exists' | 'error';

export async function fundWithFriendbot(address: string, network: NetworkType): Promise<FriendbotResult> {
  if (!NETWORKS[network].friendbot) return 'error'; // Mainnet has no friendbot

  // First check if already active
  const status = await checkAccountStatus(address, network);
  if (status === 'active') return 'already_exists';

  try {
    const res = await fetch(`https://friendbot.stellar.org?addr=${encodeURIComponent(address)}`);
    return res.ok ? 'funded' : 'error';
  } catch {
    return 'error';
  }
}

// ─── Transactions ─────────────────────────────────────────────────────────────

export async function buildPaymentXdr(
  sourceAddress: string,
  destination: string,
  amount: string,
  network: NetworkType
): Promise<string> {
  const account = await getServer(network).loadAccount(sourceAddress);
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: NETWORKS[network].passphrase,
  })
    .addOperation(
      StellarSdk.Operation.payment({
        destination,
        asset: StellarSdk.Asset.native(),
        amount: Number(amount).toFixed(7),
      })
    )
    .setTimeout(120)
    .build();

  return tx.toXDR();
}

export async function submitFeeBumped(
  signedInnerXdr: string,
  sponsorSecret: string,
  network: NetworkType
): Promise<StellarSdk.Horizon.HorizonApi.TransactionResponse> {
  const sponsorKeypair = StellarSdk.Keypair.fromSecret(sponsorSecret);
  const innerTx = StellarSdk.TransactionBuilder.fromXDR(
    signedInnerXdr,
    NETWORKS[network].passphrase
  ) as StellarSdk.Transaction;

  const feeBump = StellarSdk.TransactionBuilder.buildFeeBumpTransaction(
    sponsorKeypair.publicKey(),
    String(Number(innerTx.fee) + 200),
    innerTx,
    NETWORKS[network].passphrase
  );
  feeBump.sign(sponsorKeypair);

  return await getServer(network).submitTransaction(feeBump) as any;
}
