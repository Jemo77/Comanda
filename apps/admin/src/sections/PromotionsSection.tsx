import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { Button, DataCell, DataRow, DataTable, Field, SectionHeading } from '@comanda/ui';
import { api } from '../api';

/**
 * Promociones: alta de happy hour, 2x1, porcentaje y precio fijo.
 *
 * La forma del formulario es la del motor (`@comanda/pricing-engine`): tipo,
 * alcance, horario local, prioridad y si se apila. Lo que se guarda en
 * `price_rules` es exactamente lo que el motor evalua en el POS y en el servidor,
 * no una interpretacion nuestra.
 */

type Rule = {
  id: string;
  name: string;
  type: string;
  scope: string;
  scopeId: string | null;
  priority: number;
  stackable: boolean;
  active: boolean;
  schedule: { daysOfWeek: number[]; from: string; to: string; timezone: string } | null;
  params: Record<string, number>;
};

const TYPES: Array<{ value: string; label: string; hint: string }> = [
  { value: 'PERCENT', label: '% de descuento', hint: 'En basis points: 2000 = 20% off' },
  { value: 'FIXED', label: 'Descuento fijo', hint: 'Centavos a restar por unidad' },
  { value: 'BOGO', label: '2x1', hint: 'El más barato gratis, con cantidad par' },
  { value: 'NXM', label: 'NxM', hint: 'Llevas N, pagas N-M' },
  { value: 'PRICE_OVERRIDE', label: 'Precio fijo', hint: 'Precio final por unidad, en centavos' },
];

const DAY_LABELS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

export function PromotionsSection(): ReactElement {
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [type, setType] = useState('PERCENT');
  const [scope, setScope] = useState('PRODUCT');
  const [scopeId, setScopeId] = useState('');
  const [priority, setPriority] = useState('10');
  const [stackable, setStackable] = useState(false);
  const [days, setDays] = useState<number[]>([1, 2, 3, 4]);
  const [from, setFrom] = useState('18:00');
  const [to, setTo] = useState('20:00');
  const [bps, setBps] = useState('2000');
  const [cents, setCents] = useState('500');
  const [priceCents, setPriceCents] = useState('2500');
  const [n, setN] = useState('2');
  const [m, setM] = useState('1');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(() => {
    api<{ rules: Rule[] }>('/promotions')
      .then((body) => setRules(body.rules))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(load, [load]);

  const params = useMemo(() => {
    switch (type) {
      case 'PERCENT':
        return { bps: Number(bps) };
      case 'FIXED':
        return { cents: Number(cents) };
      case 'PRICE_OVERRIDE':
        return { priceCents: Number(priceCents) };
      case 'NXM':
        return { n: Number(n), m: Number(m) };
      default:
        return {};
    }
  }, [type, bps, cents, priceCents, n, m]);

  const toggleDay = (day: number) => {
    setDays((current) => (current.includes(day) ? current.filter((d) => d !== day) : [...current, day].sort()));
  };

  const create = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        name,
        type,
        scope,
        scopeId: scope === 'ORDER' ? null : scopeId || null,
        priority: Number(priority),
        stackable,
        params,
        schedule: {
          daysOfWeek: days,
          from,
          to,
          timezone: 'America/Argentina/Buenos_Aires',
        },
      };
      await api('/promotions', { method: 'POST', body });
      setName('');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const deactivate = async (id: string) => {
    try {
      await api(`/promotions/${id}`, { method: 'DELETE' });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const typeLabel = (t: string) => TYPES.find((x) => x.value === t)?.label ?? t;

  return (
    <section>
      <SectionHeading title="Promociones" detail="Happy hour por franja y día, 2x1, porcentajes y precio fijo. Se aplican en POS y en el servidor con el mismo motor." />

      {error && <p className="mb-4 rounded border border-signal/40 bg-signal/10 px-3 py-2 text-sm text-signal">{error}</p>}

      <div className="mb-6 grid max-w-2xl grid-cols-2 gap-3">
        <Field label="Nombre" value={name} onChange={(e) => setName(e.target.value)} hint="Ej: Happy Hour Fernet" />
        <label className="flex flex-col gap-1">
          <span className="font-display text-xs font-semibold text-ink-soft">Tipo</span>
          <select className="rounded border border-steel bg-tile px-3 py-2 text-sm" value={type} onChange={(e) => setType(e.target.value)}>
            {TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          <span className="text-xs text-ink-faint">{TYPES.find((t) => t.value === type)?.hint}</span>
        </label>

        <label className="flex flex-col gap-1">
          <span className="font-display text-xs font-semibold text-ink-soft">Alcance</span>
          <select className="rounded border border-steel bg-tile px-3 py-2 text-sm" value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="PRODUCT">Producto</option>
            <option value="CATEGORY">Categoría</option>
            <option value="ORDER">Toda la comanda</option>
          </select>
        </label>

        {scope !== 'ORDER' && <Field label="ID de producto/categoría" value={scopeId} onChange={(e) => setScopeId(e.target.value)} />}

        <Field label="Prioridad" value={priority} onChange={(e) => setPriority(e.target.value)} hint="Mayor gana" />

        {type === 'PERCENT' && <Field label="Porcentaje (bps)" value={bps} onChange={(e) => setBps(e.target.value)} hint="2000 = 20%" />}
        {type === 'FIXED' && <Field label="Descuento (centavos)" value={cents} onChange={(e) => setCents(e.target.value)} />}
        {type === 'PRICE_OVERRIDE' && <Field label="Precio final (centavos)" value={priceCents} onChange={(e) => setPriceCents(e.target.value)} />}
        {type === 'NXM' && (
          <>
            <Field label="N (llevas)" value={n} onChange={(e) => setN(e.target.value)} />
            <Field label="M (bonificas)" value={m} onChange={(e) => setM(e.target.value)} />
          </>
        )}

        <div>
          <span className="font-display text-xs font-semibold text-ink-soft">Días</span>
          <div className="mt-1 flex gap-1">
            {DAY_LABELS.map((label, day) => (
              <button
                key={label}
                type="button"
                aria-pressed={days.includes(day)}
                onClick={() => toggleDay(day)}
                className={`min-h-10 rounded border px-2 text-xs ${days.includes(day) ? 'border-ink bg-ink text-enamel' : 'border-steel bg-tile'}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <Field label="Desde" value={from} onChange={(e) => setFrom(e.target.value)} />
        <Field label="Hasta" value={to} onChange={(e) => setTo(e.target.value)} />

        <label className="flex items-center gap-2 pt-6 text-sm">
          <input type="checkbox" checked={stackable} onChange={(e) => setStackable(e.target.checked)} />
          Se apila con otras promos
        </label>
      </div>

      <Button variant="primary" size="sm" onClick={create} disabled={submitting || !name}>
        {submitting ? 'Guardando…' : 'Crear promoción'}
      </Button>

      <div className="mt-6">
        <DataTable headers={['Nombre', 'Tipo', 'Alcance', 'Horario', 'Prioridad', 'Estado', '']}>
          {(rules ?? []).map((rule) => (
            <DataRow key={rule.id}>
              <DataCell>{rule.name}</DataCell>
              <DataCell>{typeLabel(rule.type)}</DataCell>
              <DataCell>{rule.scope}</DataCell>
              <DataCell>
                {rule.schedule ? `${rule.schedule.from}–${rule.schedule.to}` : 'Siempre'}
              </DataCell>
              <DataCell>{rule.priority}</DataCell>
              <DataCell>{rule.active ? 'Activa' : 'Baja'}</DataCell>
              <DataCell>
                {rule.active && (
                  <button className="text-signal underline" onClick={() => deactivate(rule.id)}>
                    Dar de baja
                  </button>
                )}
              </DataCell>
            </DataRow>
          ))}
        </DataTable>
        {rules && rules.length === 0 && <p className="mt-2 text-sm text-ink-faint">No hay promociones.</p>}
      </div>
    </section>
  );
}
