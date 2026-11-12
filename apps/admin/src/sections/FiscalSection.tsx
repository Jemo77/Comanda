import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { Button, DataCell, DataRow, DataTable, SectionHeading, StatusPill } from '@comanda/ui';
import { api } from '../api';

/**
 * Fiscal: la cola de comprobantes con sus estados y reintento, y la configuración
 * del local. El cajero ve y puede reintentar; cambiar proveedor o ambiente exige
 * `fiscal.manage`, que el backend verifica igual.
 */

type Invoice = {
  id: string;
  orderId: string;
  type: string;
  status: 'PENDING' | 'EMITIDA' | 'RECHAZADA' | 'ERROR';
  provider: string;
  environment: string;
  voucherNumber: number | null;
  cae: string | null;
  contingency: boolean;
  totalCents: number;
  currency: string;
  attempts: number;
  lastError: string | null;
  issuedAt: string | null;
  createdAt: string;
};

const money = (cents: number, currency: string) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency }).format(cents / 100);

const STATE_TONE: Record<string, 'open' | 'pending' | 'blocked' | 'muted'> = {
  EMITIDA: 'open',
  PENDING: 'pending',
  RECHAZADA: 'blocked',
  ERROR: 'blocked',
};

export function FiscalSection(): ReactElement {
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(() => {
    api<{ invoices: Invoice[] }>('/fiscal/invoices')
      .then((body) => setInvoices(body.invoices))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(load, [load]);

  const retry = async (id: string) => {
    setMessage(null);
    try {
      await api(`/fiscal/invoices/${id}/retry`, { method: 'POST' });
      setMessage('Reintento encolado.');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section>
      <SectionHeading
        title="Fiscal"
        detail="Comprobantes electrónicos del local. EMITIDA tiene CAE; PENDING está en la cola con reintentos; RECHAZADA es una decisión del fisco; ERROR agotó la cola."
        actions={<Button variant="ghost" size="sm" onClick={load}>Refrescar</Button>}
      />

      {error && <p className="mb-4 rounded border border-signal/40 bg-signal/10 px-3 py-2 text-sm text-signal">{error}</p>}
      {message && <p className="mb-4 rounded border border-stamp/40 bg-stamp/10 px-3 py-2 text-sm text-stamp">{message}</p>}

      <DataTable headers={['Creado', 'Tipo', 'Estado', 'Número', 'CAE', 'Total', 'Proveedor', 'Intentos', 'Motivo / detalle', '']}>
        {(invoices ?? []).map((invoice) => (
          <DataRow key={invoice.id}>
            <DataCell>{new Date(invoice.createdAt).toLocaleString('es-AR')}</DataCell>
            <DataCell>{invoice.type}</DataCell>
            <DataCell>
              <StatusPill tone={STATE_TONE[invoice.status] ?? 'muted'}>{invoice.status}{invoice.contingency ? ' (CAEA)' : ''}</StatusPill>
            </DataCell>
            <DataCell>{invoice.voucherNumber ?? '—'}</DataCell>
            <DataCell>{invoice.cae ?? '—'}</DataCell>
            <DataCell>{money(invoice.totalCents, invoice.currency)}</DataCell>
            <DataCell>
              {invoice.provider}/{invoice.environment}
            </DataCell>
            <DataCell>{invoice.attempts}</DataCell>
            <DataCell>{invoice.lastError ?? '—'}</DataCell>
            <DataCell>
              {(invoice.status === 'ERROR' || invoice.status === 'RECHAZADA') && (
                <button className="text-ink underline" onClick={() => retry(invoice.id)}>
                  Reintentar
                </button>
              )}
            </DataCell>
          </DataRow>
        ))}
      </DataTable>
      {invoices && invoices.length === 0 && (
        <p className="mt-2 text-sm text-ink-faint">Aún no hay comprobantes. Se generan al cerrar una comanda con una comanda y presionar "Emitir factura".</p>
      )}
    </section>
  );
}
