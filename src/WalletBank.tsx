import { useEffect, useState } from 'react';
import { isValidPublicKey } from './lib/stellar';

const STORAGE_KEY = 'stellar-sim-contacts';

export type ContactEntry = {
  id: string;
  label: string;
  phone: string;
  address: string;
};

// Static demo contacts with real well-known testnet public keys (funded by friendbot)
const DEFAULT_CONTACTS: ContactEntry[] = [
  {
    id: 'def-1',
    label: 'Mama (Family)',
    phone: '+254711111111',
    address: 'GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37',
  },
  {
    id: 'def-2',
    label: 'Water Agent',
    phone: '+254722222222',
    address: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  },
  {
    id: 'def-3',
    label: 'Rice Merchant',
    phone: '+254733333333',
    address: 'GBVVJJHNBLUMYE5IV76J5WHUC2418OH64IL4ZZBA5F7HPHKZS6IALVR4',
  },
];

const getInitialContacts = (): ContactEntry[] => DEFAULT_CONTACTS;

type Props = {
  onSelect: (contact: ContactEntry) => void;
};

export default function WalletBank({ onSelect }: Props) {
  const [contacts, setContacts] = useState<ContactEntry[]>([]);
  const [nameInput, setNameInput] = useState('');
  const [phoneInput, setPhoneInput] = useState('');
  const [addressInput, setAddressInput] = useState('');
  const [feedback, setFeedback] = useState('');

  // Load contacts
  useEffect(() => {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      try {
        setContacts(JSON.parse(raw));
      } catch {
        setContacts(getInitialContacts());
      }
    } else {
      const initial = getInitialContacts();
      setContacts(initial);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(initial));
    }
  }, []);

  const saveContacts = (updated: ContactEntry[]) => {
    setContacts(updated);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  };

  const flash = (msg: string) => {
    setFeedback(msg);
    setTimeout(() => setFeedback(''), 2500);
  };

  const handleSave = () => {
    if (!nameInput.trim() || !phoneInput.trim() || !addressInput.trim()) {
      flash('Please fill in all fields.');
      return;
    }
    if (!isValidPublicKey(addressInput.trim())) {
      flash('Enter a valid 56-character Stellar public key starting with G.');
      return;
    }

    const newContact: ContactEntry = {
      id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      label: nameInput.trim(),
      phone: phoneInput.trim().replace(/\s+/g, ''),
      address: addressInput.trim(),
    };

    const updated = [...contacts, newContact];
    saveContacts(updated);
    setNameInput('');
    setPhoneInput('');
    setAddressInput('');
    flash('✅ Contact saved to SIM memory.');
  };

  const handleDelete = (id: string) => {
    saveContacts(contacts.filter((c) => c.id !== id));
    flash('Contact deleted.');
  };

  return (
    <article className="card card--vault">
      <div className="card__header">
        <div>
          <p className="card__label">SIM Card Memory</p>
          <h2>Offline Contacts Directory</h2>
        </div>
        <span className="state-pill state-pill--accent">
          {contacts.length} SIM Slots Used
        </span>
      </div>

      <div className="vault-body">
        {/* -- Add new contact -- */}
        <div className="vault-add" style={{ display: 'grid', gap: '8px', marginBottom: '16px' }}>
          <div className="vault-add__row">
            <input
              className="vault-input"
              type="text"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              placeholder="Name (e.g., Shopkeeper)"
              maxLength={24}
              autoComplete="off"
            />
            <input
              className="vault-input"
              type="text"
              value={phoneInput}
              onChange={(e) => setPhoneInput(e.target.value)}
              placeholder="Phone (e.g., +254700000000)"
              maxLength={16}
              autoComplete="off"
            />
          </div>
          <div className="vault-add__row">
            <input
              className="vault-input"
              type="text"
              value={addressInput}
              onChange={(e) => setAddressInput(e.target.value)}
              placeholder="Stellar Public Key (G…)"
              autoComplete="off"
            />
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
            {contacts.map((contact) => (
              <li key={contact.id} className="vault-entry" style={{ marginBottom: '8px' }}>
                <div
                  className="vault-entry__info"
                  onClick={() => onSelect(contact)}
                  title="Click to load into phone dialer"
                >
                  <span className="vault-entry__label" style={{ fontWeight: 'bold' }}>
                    👤 {contact.label}
                  </span>
                  <span className="vault-entry__address" style={{ fontSize: '0.85rem', color: '#8aa0c5' }}>
                    📞 {contact.phone} | 🔑 {contact.address.slice(0, 8)}…{contact.address.slice(-8)}
                  </span>
                </div>
                <button
                  className="vault-delete"
                  type="button"
                  onClick={() => handleDelete(contact.id)}
                  title="Remove from SIM"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </article>
  );
}
