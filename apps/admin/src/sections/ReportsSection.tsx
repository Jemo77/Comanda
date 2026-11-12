import { useCallback, useMemo, useState, type ReactElement } from 'react';
import { Button, DataCell, DataRow, DataTable, SectionHeading } from '@comanda/ui';
import { api } from '../api';

/**
 * Reportes básicos: ventas por día, producto o categoría. Los importes ya vienen
 * en centavos desde la API; acá solo se formatean.
 */

type Row = { group: string; ordersCount: number; units: number; totalCents: number };
type Report = { totalCents: number; ordersCount: number; averageTicketCents: number; currency: string; rows: Row[] };

const money = (cents: number, currency: string) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency }).format(cents / 100);

export function ReportsSection(): ReactElement {
  const [groupBy, setGroupBy] = useState<'day' | 'product' | 'category'>('day');
  const [days, setDays] = useState('30');
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const to = new Date();
      const from = new Date(to.getTime() - Number(days) * 86_400_000);
      const body = await api<Report>(
        `/reports/sales?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}&groupBy=${groupBy}`,
      );
      setReport(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [days, groupBy]);

  const currency = useMemo(() => report?.currency ?? 'ARS', [report]);

  return (
    <section>
      <SectionHeading title="Reportes" detail="Ventas por día, producto o categoría. Los rangos son inclusivos en el día de cierre." />

      <div className="mb-4 flex items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="font-display text-xs font-semibold text-ink-soft">Agrupar por</span>
          <select className="rounded border border-steel bg-tile px-3 py-2 text-sm" value={groupBy} onChange={(e) => setGroupBy(e.target.value as 'day' | 'product' | 'category')}>
            <option value="day">Día</option>
            <option value="product">Producto</option>
            <option value="category">Categoría</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-display text-xs font-semibold text-ink-soft">Últimos (días)</span>
          <input className="rounded border border-steel bg-tile px-3 py-2 text-sm" value={days} onChange={(e) => setDays(e.target.value)} inputMode="numeric" />
        </label>
        <Button variant="primary" size="sm" onClick={load}>
          Consultar
        </Button>
      </div>

      {error && <p className="mb-4 rounded border border-signal/40 bg-signal/10 px-3 py-2 text-sm text-signal">{error}</p>}

      {report && (
        <>
          <p className="mb-4 text-sm text-ink-soft">
            Total: <strong>{money(report.totalCents, currency)}</strong> · {report.ordersCount} comandas · ticket promedio {money(report.averageTicketCents, currency)}
          </p>
          <DataTable headers={[groupBy === 'day' ? 'Día' : 'Grupo', 'Comandas', 'Unidades', 'Total']}>
            {report.rows.map((row) => (
              <DataRow key={row.group}>
                <DataCell>{row.group}</DataCell>
                <DataCell>{row.ordersCount}</DataCell>
                <DataCell>{row.units}</DataCell>
                <DataCell>{money(row.totalCents, currency)}</DataCell>
              </DataRow>
            ))}
          </DataTable>
        </>
      )}
    </section>
  );
}
