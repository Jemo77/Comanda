# ADR-0009 · Token QR de mesa: HMAC con secreto en variable de entorno

- **Estado:** aceptada
- **Fecha:** 2026-10-02

## Contexto

Fase 3 pone un QR en cada mesa. El cliente lo escanea y
el navegador abre `/m/:venueId/:tableId?token=...`. Ese
token es **la única credencial** del pedido: cualquiera
que lo tenga puede abrir una cuenta en esa mesa. No hay
sesión, no hay login, no hay segundo factor. La pregunta
es cómo emitirlo y verificarlo sin una tabla de tokens ni
una consulta por escaneo.

## Opciones

### 1. Token aleatorio guardado en la base

Un UUIDv7 por mesa, en `tables.qr_token`. Verificar es
un `SELECT`.

El token **válido para siempre** es el problema: se
imprime en papel y nadie rota un sticker pegado a la
mesa. Si una foto del QR se filtra, la mesa está abierta
hasta que alguien cambie el sticker a mano. Y una tabla
de tokens es un blanco: una lectura de `tables` completa
(abandonada por otro bug de RLS) entrega todas las mesas.

### 2. JWT firmado

El token viaja con su contenido (venue, mesa, expiración)
y una firma. La API verifica la firma y lee los claims.

Trae lo que no necesitamos: expiración (un QR de mesa no
"vence" mientras el sticker esté ahí), algoritmo a elegir
y renovación. El payload además **codifica los ids**, lo
que invita a filtrarlos por error en logs y en la URL.

### 3. HMAC del par (venue, mesa) con secreto en env — **elegida**

```
token = base64url( hmac_sha256(QR_TOKEN_SECRET,
            "comanda-table-qr|" + venueId + "|" + tableId + "|" + version)
          ).slice(0, 22)
```

El secreto **no está en la base**: está en `QR_TOKEN_SECRET`
(variable de entorno). La base guarda solo la **versión**
(`tables.qr_token_version`, migración `0012`).

## Decisión

- **Verificar** es puro: HMAC + comparación timing-safe,
  sin consulta. No hay tabla de tokens que leer (ni que
  filtrar por RLS, aunque la función de resolución sí abre
  contexto de tenant).
- **Rotar** un QR es `UPDATE tables SET qr_token_version =
  qr_token_version + 1`: todos los stickers impresos con la
  versión anterior dejan de validar de inmediato, sin reimprimir
  la mesa. Basta con cambiar un registro.
- **Truncar a 22 caracteres** base64url: 128 bits de
  entropía del HMAC. Más largo no agrega seguridad (el HMAC
  ya es 256 bits) y sí alarga el QR; más corto permite
  colisiones factibles.
- **El payload es opaco**: no lleva ids. La API verifica
  el HMAC sobre **cada** mesa del local hasta encontrar la
  que coincide —el costo es lineal en mesas del local (decenas,
  no miles) y no hay consulta a la tabla de tokens porque
  no existe.

El token **no expira** por tiempo: un QR de mesa es una
credencial de larga vida que se rota por evento (foto
filtrada, cambio de sala), no por reloj. Esa es la
diferencia con una sesión.

## Consecuencias

- **El secreto es crítico.** Si `QR_TOKEN_SECRET` se filtra,
  cualquiera puede forjar tokens de cualquier mesa de
  cualquier local. Rotarlo invalida todos los QR impresos
  (todos quedan en versión 0 contra el nuevo secreto,
  salvo que se re-versionen), así que es un incidente:
  cambiar la variable y correr `UPDATE ... SET qr_token_version = qr_token_version + 1`.
- **La verificación es O(mesas del local).** Sin índice en
  el token (no lo hay: se calcula, no se busca), un local
  con 200 mesas son 200 HMAC por escaneo —microsegundos
  cada uno. Un QR por mesa **no** escala a millones de
  locales por escaneo; esto es un negocio de decenas de
  mesas por local.
- **No hay endpoint de "regenerar QR" público**: imprimir
  un token nuevo es una acción de staff (permiso
  `tables.update`, que ya existe para el mapa de mesas).
- **El token viaja en la URL** (`?token=`). Eso es lo que
  es un QR: legible por la cámara. Por eso es 404 y no 403
  cuando no verifica: no revelar que la mesa existe vale
  más que un código de error preciso.
- **No sustituye al POS**: el QR abre la cuenta del
  cliente; el mozo la ve en el POS/KDS y la cierra. El
  pedido del QR es un evento más de la misma comanda.

## Relación con el pago

El token QR autentica **al cliente con la mesa**; el
webhook de pago autentica **al proveedor con la API**
(`PAYMENT_WEBHOOK_SECRET`, distinto). Dos secretos, dos
problemas: uno impreso en papel, otro entre servidores.
