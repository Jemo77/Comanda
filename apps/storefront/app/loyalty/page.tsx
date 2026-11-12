'use client';

import { useState } from 'react';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000/api/v1';

export default function LoyaltyPage() {
  const [phone, setPhone] = useState('');
  const [balance, setBalance] = useState<number | null>(null);
  const [venueId, setVenueId] = useState('');

  async function check() {
    const res = await fetch(`${API}/storefront/venues/${venueId}/customers/identify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone }),
    });
    if (res.ok) {
      const data = await res.json();
      setBalance(data.balance);
    }
  }

  return (
    <main>
      <h1>Mis puntos</h1>
      <label>
        Local (venue ID)
        <input
          value={venueId}
          onChange={(e) => setVenueId(e.target.value)}
          style={{ minHeight: 48, width: '100%' }}
        />
      </label>
      <label>
        Teléfono
        <input
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          style={{ minHeight: 48, width: '100%' }}
        />
      </label>
      <button onClick={check} style={{ minHeight: 48 }}>
        Consultar
      </button>
      {balance !== null && <p>Tu saldo: {balance} puntos</p>}
    </main>
  );
}
