# Stellar Testnet Payments

> **Level 1** — Simple testnet XLM payments with Freighter wallet.

A minimal, production-quality Stellar dApp that connects to the **Freighter** browser wallet, displays live XLM balances from the Horizon testnet, and lets you send real testnet payments — all with instant transaction feedback.

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| **Wallet Connect** | One-click Freighter connection with status indicator |
| **Live Balance** | Real-time XLM balance fetched from the Horizon testnet endpoint |
| **Send XLM** | Compose and sign testnet payments with Freighter |
| **Transaction Feedback** | Instant success/error states with on-chain transaction hash |
| **Wallet Bank (Vault)** | Encrypted local address book — paste-only, masked storage that persists across sessions |
| **Demo Mode** | Append `?demo=connected`, `?demo=balance`, or `?demo=success` to preview UI states without a wallet |

---

## 📸 Screenshots

### 1. Wallet Connect — Freighter Unlock
![Wallet Connect](public/screenshots/01-wallet-connect.png)

### 2. Connection Request — Granting Access
![Connection Request](public/screenshots/02-connection-request.png)

### 3. Confirm Transaction — Signing Payment
![Confirm Transaction](public/screenshots/03-confirm-transaction.png)

### 4. Transaction Success — Hash Feedback
![Transaction Success](public/screenshots/04-transaction-success.png)

---

## 🛠 Tech Stack

- **React 19** + TypeScript
- **Vite 6** — lightning-fast HMR
- **@stellar/stellar-sdk v13** — Horizon API + transaction building
- **@stellar/freighter-api v5** — browser wallet integration
- **Vanilla CSS** — glassmorphic dark-mode design

---

## 🚀 Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) ≥ 18
- [Freighter Wallet](https://www.freighter.app/) browser extension (switch to **Testnet**)

### Install & Run

```bash
# Clone the repository
git clone https://github.com/your-username/stellar-testnet-payments.git
cd stellar-testnet-payments

# Install dependencies
npm install

# Start the dev server
npm run dev
```

Open **http://localhost:5173** in your browser.

### Build for Production

```bash
npm run build
npm run preview
```

---

## 🔐 Wallet Bank (Vault)

The **Wallet Bank** is a local address vault that:

- **Paste-only input** — you cannot type or copy addresses from the vault
- **Encrypted storage** — addresses are obfuscated before saving to `localStorage`
- **Masked display** — saved addresses appear as `G•••••••VH3` and cannot be selected or copied
- **Persistent** — survives page refreshes and browser restarts
- **Click to fill** — tap a saved entry to instantly load it into the destination field

---

## 📂 Project Structure

```
stellar-testnet-payments/
├── public/
│   └── screenshots/          # App screenshots
├── src/
│   ├── lib/
│   │   └── stellar.ts        # Stellar SDK helpers
│   ├── App.tsx                # Main application component
│   ├── WalletBank.tsx         # Encrypted address vault
│   ├── main.tsx               # React entry point
│   ├── styles.css             # Global styles
│   └── vite-env.d.ts          # Vite type declarations
├── index.html                 # HTML shell
├── package.json
├── tsconfig.json
├── vite.config.ts
└── README.md
```

---

## 📄 License

MIT © 2026
