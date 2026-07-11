import { useEffect, useState } from 'react';
import { isValidPublicKey } from './lib/stellar';

export type ContactEntry = {
  id: string;
  label: string;
  phone: string;
  address: string;
};

// Storage key is scoped per wallet address — no data bleeds between accounts
function storageKey(walletAddress: string) {
  return `stellar-contacts-${walletAddress}`;
}

const DEFAULT_CONTACTS: Omit<ContactEntry, 'id'>[] = [
  { label: 'Mama (Family)',  phone: '+254711111111', address: 'GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37' },
  { label: 'Water Agent',   phone: '+254722222222', address: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN' },
  { label: 'Rice Merchant', phone: '+254733333333', address: 'GBVVJJHNBLUMYE5IV76J5WHUC2418OH64IL4ZZBA5F7HPHKZS6IALVR4' },
];

type Props = {
  onSelect: (contact: ContactEntry) => void;
  walletAddress: string; // Used to scope contact storage per account
};

export default function WalletBank({ onSelect, walletAddress }: Props) {
  const [contacts, setContacts] = useState<ContactEntry[]>([]);
  const [nameInput, setNameInput]       = useState('');
  const [phoneInput, setPhoneInput]     = useState('');
  const [addressInput, setAddressInput] = useState('');
  const [feedback, setFeedback]         = useState('');

  // Load contacts scoped to this wallet address
  useEffect(() => {
    if (!walletAddress) return;
    const key = storageKey(walletAddress);
    const raw = localStorage.getItem(key);
    if (raw) {
      try { setContacts(JSON.parse(raw)); return; } catch { /**/ }
    }
    // First time for this wallet — seed with defaults
    const defaults = DEFAULT_CONTACTS.map((c, i) => ({ ...c, id: `def-${i}` }));
    setContacts(defaults);
    localStorage.setItem(key, JSON.stringify(defaults));
  }, [walletAddress]);

  const persist = (updated: ContactEntry[]) => {
    setContacts(updated);
    localStorage.setItem(storageKey(walletAddress), JSON.stringify(updated));
  };

  const flash = (msg: string) => {
    setFeedback(msg);
    setTimeout(() => setFeedback(''), 2500);
  };

  const handleSave = () => {
    if (!nameInput.trim() || !phoneInput.trim() || !addressInput.trim()) {
      flash('Please fill in all fields.'); return;
    }
    if (!isValidPublicKey(addressInput.trim())) {
      flash('Enter a valid 56-character Stellar public key starting with G.'); return;
    }
    const newContact: ContactEntry = {
      id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      label: nameInput.trim(),
      phone: phoneInput.trim().replace(/\s+/g, ''),
      address: addressInput.trim(),
    };
    persist([...contacts, newContact]);
    setNameInput(''); setPhoneInput(''); setAddressInput('');
    flash('✅ Contact saved to SIM memory.');
  };

  const handleDelete = (id: string) => {
    persist(contacts.filter(c => c.id !== id));
    flash('Contact deleted.');
  };

  return (
    <article className="card card--vault">
      <div className="card__header">
        <div>
          <p className="card__label">SIM Card Memory</p>
          <h2>Offline Contacts Directory</h2>
        </div>
        <span className="state-pill state-pill--accent">{contacts.length} SIM Slots Used</span>
      </div>

      <div className="vault-body">

        {/* Add contact */}
        <div className="vault-add" style={{ display: 'grid', gap: '8px', marginBottom: '16px' }}>
          <div className="vault-add__row">
            <input className="vault-input" type="text" value={nameInput}
              onChange={e => setNameInput(e.target.value)} placeholder="Name" maxLength={24} autoComplete="off" />
            <input className="vault-input" type="text" value={phoneInput}
              onChange={e => setPhoneInput(e.target.value)} placeholder="Phone (+254…)" maxLength={16} autoComplete="off" />
          </div>
          <div className="vault-add__row">
            <input className="vault-input" type="text" value={addressInput}
              onChange={e => setAddressInput(e.target.value)} placeholder="Stellar Public Key (G…)" autoComplete="off" />
            <button className="primary-btn primary-btn--small" type="button" onClick={handleSave}>
              Save to SIM
            </button>
          </div>
        </div>

        {feedback && <p className="vault-feedback">{feedback}</p>}

        {contacts.length === 0 ? (
          <p className="vault-empty">No contacts on this SIM yet.</p>
        ) : (
          <ul className="vault-list" style={{ padding: 0, listStyle: 'none' }}>
            {contacts.map(contact => (
              <li key={contact.id} className="vault-entry" style={{ marginBottom: '8px' }}>
                <div className="vault-entry__info" onClick={() => onSelect(contact)} title="Click to load into phone">
                  <span className="vault-entry__label" style={{ fontWeight: 'bold' }}>👤 {contact.label}</span>
                  <span className="vault-entry__address" style={{ fontSize: '0.85rem', color: '#8aa0c5' }}>
                    📞 {contact.phone} | 🔑 {contact.address.slice(0, 8)}…{contact.address.slice(-8)}
                  </span>
                </div>
                <button className="vault-delete" type="button" onClick={() => handleDelete(contact.id)} title="Remove">✕</button>
              </li>
            ))}
          </ul>
        )}

      </div>
    </article>
  );
}
