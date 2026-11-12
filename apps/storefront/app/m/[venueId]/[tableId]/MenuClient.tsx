'use client';

import { useEffect, useMemo, useState } from 'react';

interface Product {
  id: string;
  name: string;
  description: string | null;
  priceCents: number;
  imageUrl: string | null;
  allergens: string[];
  tags: string[];
  available: boolean;
  categoryId: string;
}

interface Category {
  id: string;
  name: string;
}

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000/api/v1';

/**
 * Carrito mínimo pero completo: sube el pedido, muestra la cuenta tal como la
 * confirma el servidor (nunca una suma del lado del navegador) y deja iniciar
 * el pago con la referencia del proveedor.
 */
export function MenuClient({
  venueId,
  tableId,
  token,
  lang,
}: {
  venueId: string;
  tableId: string;
  token: string;
  lang: string;
}) {
  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<Record<string, number>>({});
  const [orderId, setOrderId] = useState<string | null>(null);
  const [bill, setBill] = useState<{
    totals: { totalCents: number; paidCents: number } | null;
  } | null>(null);
  const [paymentRef, setPaymentRef] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${API}/storefront/venues/${venueId}/menu?lang=${lang}`)
      .then((r) => r.json())
      .then((data) => {
        setCategories(data.categories ?? []);
        setProducts(data.products ?? []);
      })
      .catch(() => setError('No se pudo cargar la carta. Probá de nuevo.'));
  }, [venueId, lang]);

  const cartItems = useMemo(() => Object.entries(cart).filter(([, q]) => q > 0), [cart]);

  const productsByCategory = useMemo(() => {
    const map: Record<string, Product[]> = {};
    for (const p of products) (map[p.categoryId] ??= []).push(p);
    return map;
  }, [products]);

  function add(id: string) {
    setCart((c) => ({ ...c, [id]: (c[id] ?? 0) + 1 }));
  }

  async function refreshBill() {
    const res = await fetch(
      `${API}/storefront/venues/${venueId}/tables/${tableId}/bill?token=${token}`,
    );
    if (res.ok) setBill(await res.json());
  }

  async function submitOrder() {
    setError(null);
    const res = await fetch(`${API}/storefront/venues/${venueId}/tables/${tableId}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({
        token,
        guests: 1,
        items: cartItems.map(([productId, quantity]) => ({ productId, quantity })),
      }),
    });
    if (!res.ok) {
      setError('El pedido no se pudo enviar. Avisale al personal.');
      return;
    }
    const data = await res.json();
    setOrderId(data.orderId);
    setCart({});
    await refreshBill();
  }

  async function pay() {
    setError(null);
    const res = await fetch(`${API}/storefront/venues/${venueId}/tables/${tableId}/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token,
        provider: 'mock',
        tipCents: 0,
        sourceEventId: crypto.randomUUID(),
      }),
    });
    if (!res.ok) {
      setError('No se pudo iniciar el pago.');
      return;
    }
    const checkout = await res.json();
    setPaymentRef(checkout.externalRef);
    await refreshBill();
  }

  return (
    <main>
      <h1>Carta</h1>
      {error && (
        <p role="alert" style={{ color: 'crimson' }}>
          {error}
        </p>
      )}

      {orderId && bill?.totals && (
        <section
          style={{ border: '1px solid #ddd', padding: 12, borderRadius: 8, marginBottom: 16 }}
        >
          <h2>Tu cuenta</h2>
          <p>Pedido: {orderId.slice(0, 8)}</p>
          <p>
            Total: ${(bill.totals.totalCents / 100).toFixed(2)} — Pagado: $
            {(bill.totals.paidCents / 100).toFixed(2)}
          </p>
          {paymentRef && (
            <p>
              Referencia de pago: {paymentRef}. En producción te redirige al checkout del proveedor.
            </p>
          )}
          {bill.totals.totalCents > bill.totals.paidCents && !paymentRef && (
            <button onClick={pay} style={{ minHeight: 48 }}>
              Iniciar pago
            </button>
          )}
          <button onClick={refreshBill} style={{ marginLeft: 8, minHeight: 48 }}>
            Actualizar cuenta
          </button>
        </section>
      )}

      {categories.map((c) => (
        <section key={c.id}>
          <h2>{c.name}</h2>
          {(productsByCategory[c.id] ?? []).map((p) => (
            <div
              key={p.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '8px 0',
                borderBottom: '1px solid #eee',
              }}
            >
              {p.imageUrl && (
                <img
                  src={p.imageUrl}
                  alt={p.name}
                  width={56}
                  height={56}
                  style={{ objectFit: 'cover', borderRadius: 8 }}
                />
              )}
              <div style={{ flex: 1 }}>
                <strong>{p.name}</strong>
                {p.description && <p style={{ margin: 0, color: '#555' }}>{p.description}</p>}
                {p.allergens.length > 0 && (
                  <small title="alérgenos">⚠ {p.allergens.join(', ')}</small>
                )}
                {!p.available && <small style={{ color: 'crimson' }}> Agotado</small>}
              </div>
              <span>${(p.priceCents / 100).toFixed(2)}</span>
              <button
                disabled={!p.available}
                onClick={() => add(p.id)}
                style={{ minWidth: 48, minHeight: 48 }}
              >
                +
              </button>
            </div>
          ))}
        </section>
      ))}

      {cartItems.length > 0 && (
        <footer
          style={{
            position: 'sticky',
            bottom: 0,
            background: 'white',
            padding: 12,
            borderTop: '1px solid #ddd',
          }}
        >
          <p>{cartItems.reduce((acc, [, q]) => acc + q, 0)} ítems</p>
          <button onClick={submitOrder} style={{ width: '100%', minHeight: 48 }}>
            Enviar pedido
          </button>
        </footer>
      )}
    </main>
  );
}
