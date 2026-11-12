import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { StatusPill } from '@comanda/ui';
import { db } from './db';

/**
 * Ventana de agrupacion de lecturas.
 *
 * Cero, no `requestAnimationFrame`: una escritura de 40 filas dispara 40 hooks en el
 * mismo tick de IndexedDB, asi que cualquier ventana agrupa. Un frame alcanza y no
 * mete un atraso visible entre el toque del mozo y el numero que aparece.
 */
const COALESCE_MS = 0;

/**
 * Lectura viva de la replica local.
 *
 * La carta y el plano se hidratan **despues** de que el shell monta, porque el POS
 * primero entra con PIN y despues pide la carta al servidor. Un `useEffect` de
 * montaje ve una base vacia y se queda asi: la pantalla dice "este local no tiene
 * el salon cargado" cuando si lo tiene, y el encargado termina cargando el plano de
 * nuevo.
 *
 * Es el equivalente minimo de `useLiveQuery` de `dexie-react-hooks`, escrito aca
 * para no sumar una dependencia mas a un bundle con presupuesto de 300 KB.
 *
 * Se suscribe a **todas** las tablas y no a una sola: el hook se usa en pocas
 * pantallas y la diferencia entre "se actualiza esta tabla" y "se actualiza la
 * replica" no se nota en un salon de veinte mesas.
 */
export function useLiveTable<T>(read: () => Promise<T[]>, deps: readonly unknown[]): T[] {
  const [rows, setRows] = useState<T[]>([]);
  /**
   * Timer de la lectura agrupada, o `null` si no hay ninguna pendiente.
   *
   * `bulkPut` de la carta dispara `creating`/`updating` **por fila**, asi que una
   * hidratacion de 40 productos pide 40 lecturas. Cada una es una consulta de
   * IndexedDB de ida y vuelta: no rompe nada, pero en una tablet de gama media
   * bloquea el hilo lo suficiente como para que el mozo vea la pantalla tartamudear
   * en el momento de abrir el turno.
   *
   * Se colapsan en una sola lectura por tick de evento (ver `COALESCE_MS`). No es una otimizacion
   * prematura: es el caso que pasa **siempre**, en cada arranque y en cada corte de
   * red.
   */
  const pendingRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * `read` suele ser una arrow function inline y cambia en cada render, asi que
   * `reload` se reconstruye unicamente cuando cambia lo que de verdad importa
   * (`deps`). Es el mismo compromiso que hace `react-query` con su `queryKey`: las
   * dependencias las declara quien llama, no la funcion de lectura.
   *
   * Los llamadores de este repo pasan `[]` siempre, porque la lectura depende solo
   * de la tabla, no de un filtro de la pantalla. Los que filtran (la carta por
   * categoria, el plano por sector) filtran en el `useMemo` del componente, no en
   * la lectura, y asi la suscripcion es una sola por pantalla.
   */
  const reload = useCallback(async () => {
    try {
      setRows(await read());
    } catch {
      // La base todavia no abrio, o la tabla no existe en una replica de una
      // version vieja. Se deja lo que hay: una pantalla con la replica anterior es
      // mejor que una pantalla en blanco.
    }
  }, deps);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    /**
     * Se suscribe a los hooks de escritura de cada tabla, no a un evento de la base.
     *
     * Dos cosas que Costan un rato si se inventan:
     *
     *  - `db.on('storages:changed')` **no existe** en Dexie 4. Devuelve `undefined` y
     *    `subscribe` revienta con "cannot read properties of undefined". Lo que
     *    documenta la API como evento de base son `populate`, `blocked`,
     *    `versionchange` y `close`: ninguno sirve para enterarse de una escritura.
     *  - No hay un hook `'*'` por tabla. Los de escritura son `creating`,
     *    `updating` y `deleting`.
     *
     * `bulkPut` dispara `creating` o `updating` **por fila**, asi que la hidratacion
     * de la carta entera dispara el callback una vez por producto. Por eso el
     * handler pasa por `COALESCE_MS`: sin el, abrir el turno hace 24 lecturas de la
     * carta entera en el mismo tick.
     */
    const handler = (): void => {
      if (pendingRef.current !== null) return;
      pendingRef.current = setTimeout(() => {
        pendingRef.current = null;
        void reload();
      }, COALESCE_MS);
    };

    const tables = db.tables;
    for (const table of tables) {
      for (const event of ['creating', 'updating', 'deleting'] as const) {
        table.hook(event).subscribe(handler);
      }
    }

    return () => {
      if (pendingRef.current !== null) {
        clearTimeout(pendingRef.current);
        pendingRef.current = null;
      }
      for (const table of tables) {
        for (const event of ['creating', 'updating', 'deleting'] as const) {
          table.hook(event).unsubscribe(handler);
        }
      }
    };
  }, [reload]);

  return rows;
}

/** Etiqueta de "todavia no hay nada": dice que falta, no solo que no hay. */
export function EmptyState({
  pill,
  children,
}: {
  pill: string;
  children: ReactElement | string;
}): ReactElement {
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="max-w-sm text-center">
        <StatusPill tone="muted">{pill}</StatusPill>
        <p className="mt-3 text-sm text-ink-soft">{children}</p>
      </div>
    </div>
  );
}
