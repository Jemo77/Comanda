# Sistema de diseño "Enamel & Ink" — Comanda

> Dirección visual de `apps/pos`, `apps/admin` y `packages/ui`.
> Derivada del sujeto real: barras y cafés argentinos. No es un dashboard genérico.

## 1. Sujeto y usuario

- **Sujeto:** el mostrador de una barra o cafetería. Acero, enamel, papel térmico,
  cinta de caution, letrero de "ABIERTO/CERRADO", azulejos, plumón sobre la pizarra.
- **Usuario real:** el mozo, de pie, con las manos ocupadas, mirando la pantalla
  un segundo y medio por vez. No lee: **reconoce**.
- **Trabajo principal del diseño:** que una acción se ejecute sin leer, en poco tiempo,
  con luz mala, y que un cobro sea imposible de confundir con una anulación.

## 2. Fundamento conceptual

El POS no se ve como "una app": se ve como **la pizarra y el rollo de comanda**.
Dos superficies físicas, dos trabajos distintos:

| Zona | Objeto real | Trabajo |
| - | - | - |
| Spine izquierdo | fichas deIndexes / cartelera de la barra | navegar categorías |
| Superficie central | rollo de comanda (papel térmico) | leer el pedido |
| Rail derecho | bloc de cuenta | total, cobrar |

De ahí sale la regla de oro: **el centro es un ticket con columna de puntos**,
no una grilla de tarjetas.

## 3. Color

Base "enamel & ink": fondo de esmalte frío gris-azulado, tinta casi negra,
acento azulejo (vajillafederal / señalética), rojo "CERRADO" para destructivo.

| Token | Hex | Rol |
| - | - | - |
| `enamel` | `#E4E7EA` | fondo global (esmalte /Steel signage) |
| `tile` | `#F2F4F6` | superficie elevada (papel, planillas) |
| `steel` | `#CDD3D8` | reglas, bordes, separadores (acero) |
| `ink` | `#14181C` | texto primario |
| `ink-soft` | `#5A646E` | texto secundario, metadatos |
| `azulejo` | `#1F5FA9` | acción primaria, selección, foco |
| `coca` | `#C1272D` | acción irreversible, anulación, error |
| `abierto` | `#1B7A4B` | disponible / success / estado LIBRE |
| `caution` | `#D89B12` | advertencia, PENDIENTE |

**Sobre "enamel" y "tile":** el fondo NO es crema cálido (#F4F1EA) ni casi negro
(#0B0B0B). Es un gris-azul frío de esmalte, que además es el que menos cansa la
vista en un turno de 8 horas con luz de fluorescente.

**Regla de acento:** `azulejo` y `coca` son excluyentes en un mismo control.
Nunca los dos en el mismo botón. Un botón que anula es `coca` o no es nada.

## 4. Tipografía

Dos familias, roles claramente distintos.

| Familia | Rol | Detalle |
| - | - | - |
| **Archivo** (variable) | Toda la chrome de UI, navegación, botones, títulos | Grotesca de señalética: `Archivo` con `wdth` variable para el spine (condensada 88%) y títulos en `wdth 110%`, `wght 700`. |
| **IBM Plex Mono** | Ticket, precios, SKUs, códigos, hashes de auditoría | El rollo térmico es monoespaciado por naturaleza; tabular numerals para columnas de dinero. |

- Escala: 11 / 12 / 13 / 15 / 18 / 22 / 30 / 44 px, `line-height` 1.25 en display,
  1.5 en texto.
- Ancho de línea de cuerpo < 70 caracteres (el centro del POS son tickets cortos).
- Sin versalitas para etiquetas. Los labels van en `Archivo` 12px `wght 600`,
  tracking normal, sentence case.
- Prohibido: intercalar una palabra en itálica/color dentro de un titular para
  "marcar" (es el tell más común de una página generada).

## 5. Layout

### POS — "barra" de dos zonas, sin scroll global

```
┌──────────┬─────────────────────────────────────┬──────────────┐
│  spine   │        ROLLO DE COMANDA             │  BLOQUE      │
│          │                                     │              │
│ insignia │  2x CAPUCHINO  MEDIO                │  Subtotal    │
│          │  ....................  $ 3.400      │  $ 14.200    │
│ bar      │  1x FLAN con dulce   $ 2.100        │  ─────────   │
│ ▸ (sel)  │                                     │  Servicio 10% │
│ cafeteria│  ─────────────────────────────       │  $ 15.620    │
│(ptas/▾)  │ · PIDIÓ CUENTA · 21:14            │              │
│Finde     │                                     │  [ COBRAR ]  │
│          │                                     │              │
│ 56px hit │                                     │  48px min    │
└──────────┴─────────────────────────────────────┴──────────────┘
```

- **Alineación:** todo el contenido a la izquierda EXCEPTO las columnas de dinero,
  que se alinean a la derecha con un ancho fijo. Es la única justificación a la derecha
  del producto y cumple una función: comparar precios de un vistazo.
- **Puntos guía (`........`):** el rollo separa texto y precio con puntos hasta la
  columna, convención de ticket real. Codifica alineación; no decora.
- **Targets táctiles ≥ 48px**, reales (padding incluido), verificado en test.
- Grid de productos: 3 columnas mínimo en 1024px, 2 en tablet, 2 grandes en teléfono.
- El spine es `position: sticky`, no navega: no hay scroll global en el POS.

### Admin — planilla, no dashboard de tarjetas

```
┌─────────────────────────────────────────────────────────┐
│ COMANDA · catálogo · stock · caja · equipo · fiscal      │ ← nav, regla acero
├─────────────────────────────────────────────────────────┤
│  búsqueda…                    │  128 ítems               │
│  ┌──────────────────────────────────────────────────┐   │
│  │ CORTADO         molleja 1kg      $ 9.400  ACTIVO │   │ ← filas con regla
│  │ JAMÓN cocido    cocido 1kg      $ 14.200 ACTIVO │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

- Filas con filete de acero de 1px, sin cards, sin sombras difusas.
- Todo `radius: 2px` (acero/alambre) salvo el ticket (sin radius, es papel).
- Cero degradados decorativos.

## 6. Principios

1. **Una sola cosa memorable:** el rollo de comanda con columna de puntos. Todo lo
   demás es discreto.
2. **Enamel & ink:** una tinta, un esmalte, dos acentos excluyentes.
3. **Cero chrome de plantilla:** sin eyebrows en versalitas, sin `A · B · C`, sin
   `WORD — fragment`, sin `→` pegado a los botones, sin mono para etiquetas
   (el mono es para tickets, que es su razón de existir).
4. **La acción se llama como ocurre:** "Cobrar" produce "Cobro registrado".
   "Anular ítem" produce "Ítem anulado".
5. **Cinta de caution solo donde es verdad:** el rayado amarillo/negro se usa
   únicamente en acciones irreversibles, de ~4px de alto, como cinta real.
6. **Accesibilidad:** contraste AA verificado en tokens, foco visible de 2px
   `azulejo` con offset 2px, `prefers-reduced-motion` respetado
   (las únicas animaciones son las que responden a una acción del usuario).
7. **Offline visible:** el indicador de estado (online / offline / N eventos
   pendientes) vive en la barra del spine, no en un badge flotante.

## 7. Tokens de motion

- Entrada de página: una sola secuencia orquestada (fade del ticket, 120ms).
- Hover/focus: transiciones de 80ms en color y border-color únicamente.
- Nada de `fade-and-slide-up` por sección, nada de hover en todas las cards.