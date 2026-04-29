import { useCallback, useEffect, useRef, useState } from 'react';

const STORAGE_KEY = 'stellar-wb-vault';

/* ── lightweight obfuscation (base64 + reverse) ── */
function encode(plain: string): string {
  return btoa(plain.split('').reverse().join(''));
}

function decode(encoded: string): string {
  try {
    return atob(encoded).split('').reverse().join('');
  } catch {
    return '';
  }
}

function mask(address: string): string {
  if (address.length <= 8) return '••••••••';
  return `${address.slice(0, 4)}${'•'.repeat(Math.min(address.length - 8, 40))}${address.slice(-4)}`;
}

type SavedEntry = {
  id: string;
  cipher: string;
  label: string;
  addedAt: number;
};

function loadVault(): SavedEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as SavedEntry[];
  } catch {
    return [];
  }
}

function saveVault(entries: SavedEntry[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

type Props = {
  onSelect: (address: string) => void;
};

export default function WalletBank({ onSelect }: Props) {
  const [entries, setEntries] = useState<SavedEntry[]>(loadVault);
  const [open, setOpen] = useState(false);
  const [pasteInput, setPasteInput] = useState('');
  const [labelInput, setLabelInput] = useState('');
  const [feedback, setFeedback] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    saveVault(entries);
  }, [entries]);

  /* Show feedback briefly */
  const flash = useCallback((msg: string) => {
    setFeedback(msg);
    setTimeout(() => setFeedback(''), 2200);
  }, []);

  /* Paste from clipboard */
  async function handlePasteFromClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) {
        flash('Clipboard is empty.');
        return;
      }
      setPasteInput(text.trim());
      flash('Address pasted. Add a label and save.');
    } catch {
      flash('Clipboard access denied.');
    }
  }

  /* Handle paste event on the input — allow paste, block typing */
  function handleInputPaste(e: React.ClipboardEvent<HTMLInputElement>) {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text').trim();
    if (pasted) {
      setPasteInput(pasted);
      flash('Address pasted.');
    }
  }

  /* Save a new entry */
  function handleSave() {
    if (!pasteInput) {
      flash('Paste a wallet address first.');
      return;
    }

    const exists = entries.some((e) => decode(e.cipher) === pasteInput);
    if (exists) {
      flash('This address is already saved.');
      return;
    }

    const entry: SavedEntry = {
      id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      cipher: encode(pasteInput),
      label: labelInput.trim() || `Wallet ${entries.length + 1}`,
      addedAt: Date.now(),
    };

    setEntries((prev) => [...prev, entry]);
    setPasteInput('');
    setLabelInput('');
    flash('Address saved to vault.');
  }

  /* Delete entry */
  function handleDelete(id: string) {
    setEntries((prev) => prev.filter((e) => e.id !== id));
    flash('Address removed.');
  }

  /* Select entry to fill destination */
  function handleSelect(entry: SavedEntry) {
    const address = decode(entry.cipher);
    if (address) {
      onSelect(address);
      flash(`"${entry.label}" loaded into destination.`);
    }
  }

  /* Block copy, cut, drag on masked fields */
  function blockCopy(e: React.SyntheticEvent) {
    e.preventDefault();
  }

  return (
    <article className={`card card--vault ${open ? 'card--vault-open' : ''}`}>
      <div className="card__header" style={{ cursor: 'pointer' }} onClick={() => setOpen((v) => !v)}>
        <div>
          <p className="card__label">Vault</p>
          <h2>Wallet Bank</h2>
        </div>
        <span className="state-pill state-pill--accent">
          {entries.length} saved
        </span>
      </div>

      {open && (
        <div className="vault-body">
          {/* ── Add new address ── */}
          <div className="vault-add">
            <div className="vault-add__row">
              <input
                ref={inputRef}
                className="vault-input vault-input--masked"
                type="password"
                value={pasteInput}
                placeholder="Paste address here…"
                readOnly
                onPaste={handleInputPaste}
                onCopy={blockCopy}
                onCut={blockCopy}
                onDragStart={blockCopy}
                autoComplete="off"
              />
              <button className="ghost-btn ghost-btn--small" type="button" onClick={handlePasteFromClipboard}>
                📋 Paste
              </button>
            </div>
            <div className="vault-add__row">
              <input
                className="vault-input"
                type="text"
                value={labelInput}
                onChange={(e) => setLabelInput(e.target.value)}
                placeholder="Label (optional)"
                maxLength={32}
                autoComplete="off"
              />
              <button className="primary-btn primary-btn--small" type="button" onClick={handleSave}>
                Save
              </button>
            </div>
          </div>

          {feedback && <p className="vault-feedback">{feedback}</p>}

          {/* ── Saved list ── */}
          {entries.length === 0 ? (
            <p className="vault-empty">No addresses saved yet. Paste one above to get started.</p>
          ) : (
            <ul className="vault-list">
              {entries.map((entry) => (
                <li key={entry.id} className="vault-entry">
                  <div
                    className="vault-entry__info"
                    onClick={() => handleSelect(entry)}
                    onCopy={blockCopy}
                    onCut={blockCopy}
                    onDragStart={blockCopy}
                  >
                    <span className="vault-entry__label">{entry.label}</span>
                    <span
                      className="vault-entry__address"
                      style={{ userSelect: 'none', WebkitUserSelect: 'none' }}
                    >
                      {mask(decode(entry.cipher))}
                    </span>
                  </div>
                  <button
                    className="vault-delete"
                    type="button"
                    onClick={() => handleDelete(entry.id)}
                    title="Remove"
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </article>
  );
}
