'use client';

import { use, useEffect, useMemo, useState } from 'react';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000/api/v1';

interface Slot {
  slotAt: string;
  available: number;
}

interface Product {
  id: string;
  name: string;
  priceCents: number;
  available: boolean;
}

export default function TakeawayPage({ params }: { params: Promise<{ venueId: string }> }) {
  const { venueId } = use(params);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<Record<string, number>>({});
  const [slotAt, setSlotAt] = useState<string>('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [orderId, setOrderId] = useState<string | null>(null);
  const [status, setStatus] = useState<{ readyForPickup: boolean; pickupAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const today = new Date().toISOString().slice(0, 10);
  const cartItems = useMemo(() => Object.entries(cart).filter(([, q]) => q > 0), [cart]);

  useEffect(() => {
    fetch(`${API}/storefront/venues/${venueId}/takeaway/slots?date=${today}`)
      .then((r) => r.json())
      .then((data) => setSlots(data.slots ?? []))
      .catch(() => setError('No se pudieron cargar los horarios.'));
    fetch(`${API}/storefront/venues/${venueId}/menu?lang=es`)
      .then((r) => r.json())
      .then((data) => setProducts(data.products ?? []))
      .catch(() => setError('No se pudo cargar la carta.'));
  }, [venueId, today]);

  useEffect(() => {
    if (!orderId) return;
    const timer = setInterval(() => {
      fetch(`${API}/storefront/orders/${orderId}/takeaway-status`)
        .then((r) => r.json())
        .then((data) => setStatus(data))
        .catch(() => undefined);
    }, 5000);
    return () => clearInterval(timer);
  }, [orderId]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const res = await fetch(`${API}/storefront/venues/${venueId}/takeaway/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slotAt,
        customerName: name,
        customerPhone: phone,
        items: cartItems.map(([productId, quantity]) => ({ productId, quantity })),
        sourceEventId: crypto.randomUUID(),
      }),
    });
    if (!res.ok) {
      setError('No se pudo crear el pedido.');
      return;
    }
    const data = await res.json();
    setOrderId(data.orderId);
  }

  return (
    <main>
      <h1>Takeaway</h1>
      {error && (
        <p role="alert" style={{ color: 'crimson' }}>
          {error}
        </p>
      )}

      {orderId ? (
        <section>
          <h2>Pedido {orderId.slice(0, 8)}</h2>
          <p>
            {status?.readyForPickup ? '¡Tu pedido está listo para retirar!' : 'En preparación…'}
          </p>
          <button onClick={() => setOrderId(null)} style={{ minHeight: 48 }}>
            Nuevo pedido
          </button>
        </section>
      ) : (
        <form onSubmit={submit}>
          <h2>Elegí horario de retiro</h2>
          <label>
            Horario
            <select
              value={slotAt}
              onChange={(e) => setSlotAt(e.target.value)}
              required
              style={{ minHeight: 48, width: '100%' }}
            >
              <option value="">Elegí un horario</option>
              {slots
                .filter((s) => s.available > 0)
                .map((s) => (
                  <option key={s.slotAt} value={s.slotAt}>
                    {new Date(s.slotAt).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}{' '}
                    ({s.available} lugares)
                  </option>
                ))}
            </select>
          </label>

          <h2>Carta</h2>
          {products
            .filter((p) => p.available)
            .map((p) => (
              <div
                key={p.id}
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}
              >
                <span style={{ flex: 1 }}>
                  {p.name} — ${(p.priceCents / 100).toFixed(2)}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setCart((c) => ({ ...c, [p.id]: Math.max(0, (c[p.id] ?? 0) - 1) }))
                  }
                  style={{ minWidth: 48, minHeight: 48 }}
                >
                  -
                </button>
                <span>{cart[p.id] ?? 0}</span>
                <button
                  type="button"
                  onClick={() => setCart((c) => ({ ...c, [p.id]: (c[p.id] ?? 0) + 1 }))}
                  style={{ minWidth: 48, minHeight: 48 }}
                >
                  +
                </button>
              </div>
            ))}

          <label>
            Nombre
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              style={{ minHeight: 48, width: '100%' }}
            />
          </label>
          <label>
            Teléfono
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              required
              style={{ minHeight: 48, width: '100%' }}
            />
          </label>
          <button
            type="submit"
            disabled={cartItems.length === 0 || !slotAt}
            style={{ width: '100%', minHeight: 48 }}
          >
            Pedir
          </button>
        </form>
      )}
    </main>
  );
}
