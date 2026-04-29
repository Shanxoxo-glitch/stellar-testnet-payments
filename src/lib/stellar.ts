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
