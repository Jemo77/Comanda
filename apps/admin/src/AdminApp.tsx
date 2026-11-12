import { useState, type ReactElement } from 'react';
import {
  AdminNavItem,
  AdminShell,
  Button,
  DataCell,
  DataRow,
  DataTable,
  Field,
  SectionHeading,
  StatusPill,
} from '@comanda/ui';
import { PERMISSION_LABELS, PERMISSION_KEYS } from '@comanda/domain';
import { getToken, login, setToken } from './api';
import { FiscalSection } from './sections/FiscalSection';
import { PromotionsSection } from './sections/PromotionsSection';
import { ReportsSection } from './sections/ReportsSection';

/**
 * Backoffice.
 *
 * Densidad antes que decorators: filas con filete de acero, tipografia de 13px y el
 * contenido pegado al borde. Sin cards flotantes con sombra difusa, que es el kit de
 * dashboard generico que el diseno descarta explicitamente.
 *
 * El nav se arma de secciones reales del producto (PLAN §4), no de items inventados
 * para llenar la barra.
 */
type Section = 'catalogo' | 'salon' | 'caja' | 'equipo' | 'auditoria' | 'fiscal' | 'promociones' | 'reportes';

const SECTIONS: Array<{ key: Section; label: string }> = [
  { key: 'catalogo', label: 'Catálogo' },
  { key: 'salon', label: 'Salón' },
  { key: 'caja', label: 'Caja' },
  { key: 'equipo', label: 'Equipo' },
  { key: 'auditoria', label: 'Auditoría' },
  { key: 'promociones', label: 'Promociones' },
  { key: 'fiscal', label: 'Fiscal' },
  { key: 'reportes', label: 'Reportes' },
];

export function AdminApp(): ReactElement {
  const [section, setSection] = useState<Section>('equipo');
  const [orgName, setOrgName] = useState('Cafe Luna');
  const [session, setSession] = useState<{ name: string } | null>(getToken() ? { name: '' } : null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);

  if (!session) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-enamel">
        <div className="w-full max-w-sm rounded border border-steel bg-tile p-6">
          <h1 className="mb-1 font-display text-xl font-bold">Comanda · Backoffice</h1>
          <p className="mb-4 text-sm text-ink-soft">Entrá con el correo y la contraseña del dueño o encargado.</p>
          <div className="flex flex-col gap-3">
            <Field label="Correo" value={email} onChange={(e) => setEmail(e.target.value)} />
            <label className="flex flex-col gap-1">
              <span className="font-display text-xs font-semibold text-ink-soft">Contraseña</span>
              <input
                type="password"
                className="rounded border border-steel bg-enamel px-3 py-2 text-sm"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            {loginError && <p className="text-sm text-signal">{loginError}</p>}
            <Button
              variant="primary"
              size="sm"
              disabled={loggingIn}
              onClick={async () => {
                setLoggingIn(true);
                setLoginError(null);
                try {
                  const user = await login(email, password);
                  setSession(user);
                } catch (e) {
                  setLoginError(e instanceof Error ? e.message : String(e));
                } finally {
                  setLoggingIn(false);
                }
              }}
            >
              {loggingIn ? 'Entrando…' : 'Entrar'}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <AdminShell
      title="Comanda"
      nav={SECTIONS.map((item) => (
        <AdminNavItem
          key={item.key}
          label={item.label}
          active={section === item.key}
          onSelect={() => setSection(item.key)}
        />
      ))}
      actions={
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setToken(null);
            setSession(null);
          }}
        >
          Salir
        </Button>
      }
    >
      {section === 'promociones' && <PromotionsSection />}
      {section === 'fiscal' && <FiscalSection />}
      {section === 'reportes' && <ReportsSection />}

      {(section === 'catalogo' || section === 'salon' || section === 'caja' || section === 'auditoria') && (
        <p className="text-sm text-ink-faint">
          Esta sección todavía no está cableada a la API en esta fase; el contenido vivo de Fase 2 está en Promociones, Fiscal y Reportes.
        </p>
      )}

      {section === 'equipo' && (
        <>
      <SectionHeading
        title="Equipo"
        detail="Quién entra al mostrador y qué puede hacer en este local."
        actions={
          <Button variant="primary" size="sm">
            Invitar a alguien
          </Button>
        }
      />

      <div className="mb-5 max-w-sm">
        <Field
          label="Organización"
          value={orgName}
          onChange={(event) => setOrgName(event.target.value)}
          hint="Los permisos son por local: el mismo Encargado puede tener más permisos en un bar que en un café."
        />
      </div>

      <TeamTable />

      <section className="mt-8">
        <SectionHeading
          title="Permisos disponibles"
          detail="Catálogo completo de claves. Los roles los agrupan; la autorización siempre se verifica en el servidor."
        />
        <ul className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm text-ink-soft sm:grid-cols-2 lg:grid-cols-3">
          {PERMISSION_KEYS.map((key) => (
            <li key={key} className="flex items-baseline gap-2">
              <code className="font-mono text-2xs text-ink-faint">{key}</code>
              <span>{PERMISSION_LABELS[key]}</span>
            </li>
          ))}
        </ul>
      </section>
        </>
      )}

      <p className="sr-only" aria-live="polite">
        {orgName} · {SECTIONS.find((item) => item.key === section)?.label}
      </p>
    </AdminShell>
  );
}

/**
 * Tabla de equipo.
 *
 * Filas con filete, columna de dinero alineada a la derecha y estado como
 * señalética del local. Es el patrón que se repite en todas las secciones del admin.
 */
function TeamTable(): ReactElement {
  const team = [
    { name: 'Valeria Soto', role: 'Dueño', device: 'Tablet Barra', status: 'active' as const },
    {
      name: 'Marcos Belloni',
      role: 'Encargado',
      device: 'Kiosco Mostrador',
      status: 'active' as const,
    },
    { name: 'Juana Pryce', role: 'Cajero', device: 'Kiosco Mostrador', status: 'active' as const },
    { name: 'Nico Alvarez', role: 'Mozo', device: 'Tablet Barra', status: 'active' as const },
    { name: 'Tomas Reinoso', role: 'Mozo', device: '—', status: 'pending' as const },
  ];

  return (
    <DataTable headers={['Nombre', 'Rol', 'Dispositivo', 'Estado', '']}>
      {team.map((person) => (
        <DataRow key={person.name}>
          <DataCell>
            <span className="font-medium text-ink">{person.name}</span>
          </DataCell>
          <DataCell>{person.role}</DataCell>
          <DataCell className="text-ink-soft">{person.device}</DataCell>
          <DataCell>
            <StatusPill tone={person.status === 'active' ? 'open' : 'pending'}>
              {person.status === 'active' ? 'Activo' : 'Sin dispositivo'}
            </StatusPill>
          </DataCell>
          <DataCell align="right">
            <Button variant="ghost" size="sm">
              Revocar
            </Button>
          </DataCell>
        </DataRow>
      ))}
    </DataTable>
  );
}
