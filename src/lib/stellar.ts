import * as StellarSdk from '@stellar/stellar-sdk';

export const TESTNET_HORIZON_URL = 'https://horizon-testnet.stellar.org';
export const TESTNET_NETWORK_PASSPHRASE = StellarSdk.Networks.TESTNET;

export const horizonServer = new StellarSdk.Horizon.Server(TESTNET_HORIZON_URL);

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
  // Stellar SDK error with extras
  const e = error as any;
  if (e?.response?.data?.extras?.result_codes) {
    const codes = e.response.data.extras.result_codes;
    return `Transaction failed: ${JSON.stringify(codes)}`;
  }
  return 'Something went wrong while completing the request.';
}

export async function fetchBalance(address: string): Promise<string> {
  const account = await horizonServer.loadAccount(address);
  const native = account.balances.find((b: any) => b.asset_type === 'native');
  return native?.balance ?? '0';
}

export async function fundWithFriendbot(address: string): Promise<boolean> {
  try {
    const res = await fetch(`https://friendbot.stellar.org?addr=${encodeURIComponent(address)}`);
    return res.ok;
  } catch {
    return false;
  }
}

export async function fetchRecentTransactions(address: string): Promise<any[]> {
  try {
    const payments = await horizonServer.payments()
      .forAccount(address)
      .limit(8)
      .order('desc')
      .call();
    return payments.records;
  } catch {
    return [];
  }
}

/**
 * Build a payment transaction XDR from the given parameters.
 * Returns the unsigned XDR string ready to be passed to Freighter.
 */
export async function buildPaymentXdr(
  sourceAddress: string,
  destination: string,
  amount: string
): Promise<string> {
  const account = await horizonServer.loadAccount(sourceAddress);
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: TESTNET_NETWORK_PASSPHRASE,
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

/**
 * Wraps a signed inner XDR inside a Fee-Bump transaction and broadcasts it.
 * The sponsor keypair pays the network fee so the user pays 0.
 */
export async function submitFeeBumped(
  signedInnerXdr: string,
  sponsorSecret: string
): Promise<StellarSdk.Horizon.HorizonApi.TransactionResponse> {
  const sponsorKeypair = StellarSdk.Keypair.fromSecret(sponsorSecret);
  const innerTx = StellarSdk.TransactionBuilder.fromXDR(
    signedInnerXdr,
    TESTNET_NETWORK_PASSPHRASE
  ) as StellarSdk.Transaction;

  const feeBump = StellarSdk.TransactionBuilder.buildFeeBumpTransaction(
    sponsorKeypair.publicKey(),
    String(Number(innerTx.fee) + 200),
    innerTx,
    TESTNET_NETWORK_PASSPHRASE
  );
  feeBump.sign(sponsorKeypair);

  return await horizonServer.submitTransaction(feeBump) as any;
}
