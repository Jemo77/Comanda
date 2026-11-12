# @comanda/ui

Design system de Comanda. Tokens **"Enamel & Ink"** y primitivas accesibles.
La direccion visual completa esta en [`docs/DESIGN.md`](../../docs/DESIGN.md); este
README es la guia de uso.

## Concepto en una linea

El POS se ve como **la pizarra y el rollo de comanda**: enamel, tinta, acero, y el
ticket como superficie central. De ahi sale el elemento memorable del producto,
la linea de ticket con guia de puntos (`ticket-leader`).

## Tokens

Definidos en `src/styles.css` con `@theme` (Tailwind v4). Los colores no se
redefinen en las apps: se importan de ahi.

| Token | Hex | Rol |
| - | - | - |
| `enamel` | `#E4E7EA` | fondo global |
| `tile` | `#F2F4F6` | superficie elevada |
| `steel` | `#CDD3D8` | reglas y bordes |
| `ink` | `#14181C` | texto primario |
| `azulejo` | `#1F5FA9` | accion primaria, seleccion, foco |
| `coca` | `#C1272D` | accion irreversible |
| `abierto` | `#1B7A4B` | disponible |
| `caution` | `#D89B12` | pendiente, cinta |

**Regla de acento:** `azulejo` y `coca` son excluyentes en un mismo control. No
existe un boton "primario destructivo": un boton que anula es `destructive` o no
es nada.

## Tipografia

Archivo (chrome de UI, spine, botones) e IBM Plex Mono (ticket, precios, SKUs,
hashes). El monoespaciado esta Justificado por el rollo termico y las columnas de
dinero, no por moda.

## Componentes

| Componente | Para que |
| - | - |
| `Button` | Acciones. 48px minimo, `lg` de 56px para una sola mano. `variant="destructive"` lleva cinta de caution obligatoria. |
| `Spine`, `SpineItem` | Columna vertical fija de categorias. Activo con barra de canto, no con fondo de color. |
| `TicketLine`, `TicketTotal`, `TicketRule` | El rollo de comanda. Guia de puntos y precio alineado a la derecha. |
| `StatusPill`, `ConnectionBadge` | Estados como senaletica del local. Siempre con palabra, nunca solo color. |
| `Field`, `PinPad`, `PinDots`, `FormError` | Formularios. Label siempre visible, error enlazado con `aria-describedby`. |
| `AdminShell`, `AdminNavItem`, `DataTable`, `DataRow`, `DataCell` | Planilla densa con filete de acero. Sin cards ni sombras difusas. |

## Reglas que los componentes respetan

- **Targets tactiles >= 48px.** Verificado en `components.test.tsx`.
- **Foco visible**: un unico anillo (`--focus-ring`) en todo el producto.
- **`prefers-reduced-motion` respetado** en CSS. Las transiciones duran 80ms y
  solo cambian color y borde; nada de `transform`.
- **Sin chrome de plantilla**: nada de eyebrows en versalitas, nada de
  `A · B · C`, nada de flechas pegadas a los botones.
- **Copy coherente**: la accion y su exito usan el mismo verbo.

## Tests

```bash
pnpm test   # 30 tests
```

Renderizan a markup estatico y verifican lo que no se ve en una captura: targets
tactiles, atributos ARIA, y que el rayado de caution exista en el CSS (si
alguien lo borra de ahi, el elemento sigue renderizando pero queda invisible).

## Consumo

```tsx
import '@comanda/ui/styles.css';
import { Button, TicketLine } from '@comanda/ui';
```

El paquete exporta **codigo fuente**, no `dist`: las apps lo compilan con su
propio Vite y el CSS entra en el bundle una sola vez.