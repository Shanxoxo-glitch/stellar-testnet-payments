import * as StellarSdk from '@stellar/stellar-sdk';

export const TESTNET_HORIZON_URL = 'https://horizon-testnet.stellar.org';
export const TESTNET_NETWORK_PASSPHRASE = StellarSdk.Networks.TESTNET;

export function formatAddress(address: string) {
  if (address.length <= 14) {
    return address;
  }

  return `${address.slice(0, 6)}…${address.slice(-6)}`;
}

export function formatXlm(balance: string) {
  const parsed = Number(balance);

  if (Number.isNaN(parsed)) {
    return balance;
  }

  return parsed.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 7,
  });
}

export function getNativeBalanceFromAccount(account: any) {
  const nativeBalance = account.balances.find((entry: any) => entry.asset_type === 'native');

  return nativeBalance?.balance ?? '0';
}

export function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  return 'Something went wrong while completing the request.';
}

/**
 * Deterministically derives a Stellar keypair from a phone number and a 4-digit PIN.
 * This simulates a secure SIM card-based key vault.
 */
export function deriveKeypairFromPhoneAndPin(phone: string, pin: string): StellarSdk.Keypair {
  const cleanPhone = phone.replace(/\D/g, '');
  const cleanPin = pin.replace(/\D/g, '').slice(0, 4).padEnd(4, '0');
  const seedMaterial = `${cleanPhone}:${cleanPin}`;
  
  // Deterministic seed generation
  const encoder = new TextEncoder();
  const bytes = encoder.encode(seedMaterial);
  const seed = new Uint8Array(32);
  
  for (let i = 0; i < 32; i++) {
    let hash = 17;
    for (let j = 0; j < bytes.length; j++) {
      hash = (hash * 31 + bytes[j] + i) | 0;
    }
    seed[i] = Math.abs(hash) % 256;
  }
  
  return StellarSdk.Keypair.fromRawEd25519Seed(seed as any);
}

/**
 * Requests funding from the testnet Friendbot for the specified address.
 */
export async function fundWithFriendbot(address: string): Promise<boolean> {
  try {
    const res = await fetch(`https://friendbot.stellar.org?addr=${encodeURIComponent(address)}`);
    return res.ok;
  } catch (err) {
    console.error('Friendbot funding failed:', err);
    return false;
  }
}

/**
 * Wraps an inner transaction XDR into a Fee-Bump transaction sponsored by the Gateway,
 * signs it with the sponsor's keypair, and submits it to Horizon.
 */
export async function submitSponsoredTransaction(
  innerTxXdr: string,
  sponsorSecret: string
): Promise<any> {
  const horizonServer = new StellarSdk.Horizon.Server(TESTNET_HORIZON_URL);
  const sponsorKeypair = StellarSdk.Keypair.fromSecret(sponsorSecret);
  
  // Reconstruct the inner transaction
  const innerTx = StellarSdk.TransactionBuilder.fromXDR(
    innerTxXdr,
    TESTNET_NETWORK_PASSPHRASE
  ) as StellarSdk.Transaction;
  
  // Build the outer Fee-Bump transaction
  // Base fee for the fee-bump must be at least innerTx.fee + 100 stroops
  const feeBumpTx = StellarSdk.TransactionBuilder.buildFeeBumpTransaction(
    sponsorKeypair.publicKey(),
    (Number(innerTx.fee) + 200).toString(), // sponsor pays fee + buffer
    innerTx,
    TESTNET_NETWORK_PASSPHRASE
  );
  
  // Sponsor signs the fee-bump
  feeBumpTx.sign(sponsorKeypair);
  
  // Broadcast to testnet
  return await horizonServer.submitTransaction(feeBumpTx);
}
