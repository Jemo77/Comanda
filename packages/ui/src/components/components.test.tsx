/**
 * Tests del design system.
 *
 * Se centran en lo que no se ve mirando la pantalla: targets tactiles, foco
 * visible, y que los componentes no digan una cosa y hagan otra.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Button } from './Button';
import { Field, PinDots, PinPad } from './Field';
import { ConnectionBadge, StatusPill } from './StatusPill';
import { TicketLine, TicketTotal } from './TicketLine';
import { SpineItem } from './Spine';
import { DataCell, DataRow, DataTable } from './Shell';

const render = (node: Parameters<typeof renderToStaticMarkup>[0]): string =>
  renderToStaticMarkup(node);

describe('Button', () => {
  it('un boton destructivo siempre lleva cinta de caution', () => {
    // La accion irreversible se anuncia antes de confirmarla, no despues.
    expect(render(<Button variant="destructive">Anular</Button>)).toContain('button-caution');
    expect(render(<Button variant="primary">Cobrar</Button>)).not.toContain('button-caution');
  });

  it('la cinta de caution esta definida en el CSS, no en el marcado', () => {
    // El rayado vive en styles.css. Si alguien la borra de ahi, el boton
    // destructivo sigue renderizando el elemento pero queda invisible, asi que
    // el test tiene que mirar el CSS y no solo el HTML.
    const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
    expect(css).toContain('.caution-tape');
    expect(css).toContain('repeating-linear-gradient');
    // Usa caution e ink, los dos colores de la cinta real.
    expect(css).toMatch(/\.caution-tape[\s\S]*?--color-caution[\s\S]*?--color-ink/);
  });

  it('usa type="button" por defecto para no enviar formularios por accidente', () => {
    expect(render(<Button>Cobrar</Button>)).toContain('type="button"');
  });

  it('respeta un type explicito', () => {
    expect(render(<Button type="submit">Guardar</Button>)).toContain('type="submit"');
  });

  it('expone el estado disabled a la tecnologia asistiva', () => {
    expect(render(<Button disabled>Cobrar</Button>)).toContain('disabled');
  });

  it('el tamano grande es el que se usa con una sola mano', () => {
    expect(render(<Button size="lg">Cobrar</Button>)).toContain('h-14');
  });
});

describe('TicketLine', () => {
  it('muestra el importe formateado para es-AR', () => {
    const html = render(
      <TicketLine totalCents={3400} currency="ARS">
        Capuchino
      </TicketLine>,
    );
    expect(html).toContain('34,00');
    expect(html).toContain('Capuchino');
  });

  it('incluye la guia de puntos que separa texto y precio', () => {
    expect(
      render(
        <TicketLine totalCents={100} currency="ARS">
          X
        </TicketLine>,
      ),
    ).toContain('ticket-leader');
  });

  it('un item anulado queda tachado y atenuado', () => {
    const html = render(
      <TicketLine totalCents={100} currency="ARS" voided>
        Capuchino
      </TicketLine>,
    );
    // El tachado va en color coca, no en tinta: es la senal de que algo se perdio.
    expect(html).toContain('line-through');
    expect(html).toContain('decoration-coca');
    expect(html).toContain('text-ink-faint');
  });

  it('un item activo no queda tachado', () => {
    const html = render(
      <TicketLine totalCents={100} currency="ARS">
        Capuchino
      </TicketLine>,
    );
    expect(html).not.toContain('line-through');
  });

  it('muestra la cantidad solo si se pasa', () => {
    expect(
      render(
        <TicketLine totalCents={100} currency="ARS">
          X
        </TicketLine>,
      ),
    ).not.toContain('1x');
    expect(
      render(
        <TicketLine quantity={2} totalCents={100} currency="ARS">
          X
        </TicketLine>,
      ),
    ).toContain('2x');
  });

  it('los importes usan cifras tabulares', () => {
    expect(
      render(
        <TicketLine totalCents={100} currency="ARS">
          X
        </TicketLine>,
      ),
    ).toContain('tabular');
  });
});

describe('TicketTotal', () => {
  it('el total usa cuerpo grande y el subtotal tinta suave', () => {
    expect(render(<TicketTotal label="Subtotal" amountCents={1000} currency="ARS" />)).toContain(
      'text-ink-soft',
    );
    expect(
      render(<TicketTotal label="Total" amountCents={1000} currency="ARS" emphasis />),
    ).toContain('text-lg');
  });

  it('marca en rojo un importe negativo, como un comprobante real', () => {
    expect(
      render(<TicketTotal label="Descuento" amountCents={-500} currency="ARS" negative />),
    ).toContain('text-coca');
  });
});

describe('StatusPill', () => {
  it('los estados disponibles usan los colores de la señaletica', () => {
    expect(render(<StatusPill tone="open">Libre</StatusPill>)).toContain('text-abierto');
    expect(render(<StatusPill tone="pending">Pidió cuenta</StatusPill>)).toContain('text-caution');
    expect(render(<StatusPill tone="blocked">Bloqueada</StatusPill>)).toContain('text-coca');
  });

  it('el estado dice con palabras, no solo con color', () => {
    // Un punto de color no dice nada a quien tiene baja vision.
    const html = render(<StatusPill tone="open">Libre</StatusPill>);
    expect(html).toContain('Libre');
    expect(html).not.toContain('●');
  });
});

describe('ConnectionBadge', () => {
  it('distingue los tres estados del POS', () => {
    expect(render(<ConnectionBadge status="online" />)).toContain('En línea');
    expect(render(<ConnectionBadge status="offline" pendingEvents={3} />)).toContain(
      'Sin conexión',
    );
    expect(render(<ConnectionBadge status="syncing" pendingEvents={12} />)).toContain(
      'Sincronizando 12',
    );
  });

  it('anuncia el cambio de estado a lectores de pantalla', () => {
    expect(render(<ConnectionBadge status="offline" />)).toContain('aria-live="polite');
  });

  it('muestra cuantos eventos quedan sin sincronizar', () => {
    expect(render(<ConnectionBadge status="offline" pendingEvents={7} />)).toContain('7');
  });
});

describe('Field', () => {
  it('enlaza el error con el campo y lo marca como invalido', () => {
    const html = render(
      <Field label="Correo" error="Ese correo no esta registrado" defaultValue="x@y" />,
    );
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('Ese correo no esta registrado');
  });

  it('el label siempre esta visible y enlazado al input', () => {
    const html = render(<Field label="PIN" />);
    expect(html).toContain('<label');
    expect(html).toContain('PIN');
    expect(html).toMatch(/for="[^"]+"/);
  });

  it('usa el hint cuando no hay error', () => {
    const html = render(<Field label="Correo" hint="Solo para entrar al local" />);
    expect(html).toContain('Solo para entrar al local');
    expect(html).not.toContain('role="alert"');
  });
});

describe('PinPad', () => {
  it('ofrece los diez digitos y una accion de borrado', () => {
    const html = render(<PinPad onDigit={() => {}} onBackspace={() => {}} onSubmit={() => {}} />);
    for (const digit of ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']) {
      expect(html, digit).toContain(`>${digit}<`);
    }
    expect(html).toContain('Borrar');
  });

  it('los digitos tienen target de 64px, mayor que el minimo de 48', () => {
    // El PIN se tipea con guantes y sin mirar: el target es mayor que el estandar.
    const html = render(<PinPad onDigit={() => {}} onBackspace={() => {}} onSubmit={() => {}} />);
    expect(html).toContain('h-16');
  });

  it('PinDots no revela el valor tipeado', () => {
    const html = render(<PinDots length={3} max={6} />);
    expect(html).toContain('3 de 6 digitos');
    expect(html).not.toMatch(/\d{4,}/);
  });
});

describe('Spine', () => {
  it('el item activo se marca como pagina actual', () => {
    expect(render(<SpineItem label="Bar" active />)).toContain('aria-current="page"');
    expect(render(<SpineItem label="Bar" />)).not.toContain('aria-current');
  });

  it('muestra la marca de seleccion con barra de canto', () => {
    // Un fondo de color seria ambiguo sobre el panel oscuro.
    expect(render(<SpineItem label="Bar" active />)).toContain('absolute inset-y-0 left-0');
  });
});

describe('DataTable', () => {
  it('una celda de dinero es la unica alineada a la derecha', () => {
    const html = render(
      <DataTable headers={['Producto', 'Precio']}>
        <DataRow>
          <DataCell>Cortado</DataCell>
          <DataCell align="right">$ 9.400</DataCell>
        </DataRow>
      </DataTable>,
    );
    expect(html).toContain('text-right');
    expect(html).toContain('tabular');
  });

  it('las filas se separan con filete de acero, no con sombra', () => {
    const html = render(
      <DataTable headers={['x']}>
        <DataRow>
          <DataCell>y</DataCell>
        </DataRow>
      </DataTable>,
    );
    expect(html).toContain('rule-row');
    expect(html).not.toContain('shadow-lg');
  });

  it('los encabezados de columna se anuncian como tales', () => {
    const html = render(
      <DataTable headers={['Producto']}>
        <DataRow>
          <DataCell>x</DataCell>
        </DataRow>
      </DataTable>,
    );
    expect(html).toContain('scope="col"');
  });
});
