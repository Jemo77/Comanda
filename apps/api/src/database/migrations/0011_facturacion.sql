-- =============================================================================
-- Comanda · Fase 2: factura electronica (configuracion + comprobantes)
--
-- Dos tablas:
--
--  - `fiscal_settings`: una fila por local. Donde vive el proveedor, el
--    ambiente (homo/prod), el punto de venta y cuantos reintentos hay que darle
--    a la cola. El certificado NUNCA se guarda aca: solo una referencia
--    (`cert_ref`) a donde esta el cert, cifrado aparte.
--
--  - `invoices`: la cola y el libro, a la vez. Una factura recien encolada es
--    status PENDING; la cola la reclama con `platform_claim_pending_fiscal_invoices`
--    y el proveedor la autorizo -> EMITIDA. Si el proveedor la rechaza es
--    RECHAZADA (decision terminal del fisco); si se agota la cola es ERROR.
--
-- Idempotencia de la cola: `(org_id, order_id, type)` es UNIQUE para FACT. La
-- nota de credito usa `credit_note_for` para referenciar la original y si puede.
-- =============================================================================

CREATE TABLE fiscal_settings (
  venue_id uuid PRIMARY KEY REFERENCES venues(id) ON DELETE CASCADE,
  org_id uuid NOT NULL,
  -- mock | afip. El adapter se elige aca y no en codigo de modulos.
  provider varchar(16) NOT NULL DEFAULT 'mock',
  -- homo | prod. El default es homologacion a proposito: un local que factura
  -- contra produccion sin pasar por homo es el bug que mas caro sale.
  environment varchar(8) NOT NULL DEFAULT 'homo',
  point_of_sale varchar(8) NOT NULL DEFAULT '00001',
  -- CUIT del local (sin guiones). Vacio si el provider es mock.
  cuit varchar(11) NOT NULL DEFAULT '',
  -- Referencia al material fiscal (cert + key) en el vault. El material en si
  -- nunca toca la base.
  cert_ref varchar(120) NOT NULL DEFAULT '',
  -- Contingencia CAEA: numero vigente y fecha de vencimiento. Se usa solo cuando
  -- WSFE no responde; facturar sin CAE vencido tampoco es opcion.
  caea_number varchar(16) NOT NULL DEFAULT '',
  caea_expires_on date,
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0 AND max_attempts <= 20),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fiscal_settings_provider_valid CHECK (provider IN ('mock','afip')),
  CONSTRAINT fiscal_settings_environment_valid CHECK (environment IN ('homo','prod'))
);

CREATE INDEX fiscal_settings_org_idx ON fiscal_settings (org_id);

CREATE TABLE invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  -- FACT_A | FACT_B | FACT_C | NC_A | NC_B | NC_C
  type varchar(6) NOT NULL,
  -- PENDING | EMITIDA | RECHAZADA | ERROR
  status varchar(10) NOT NULL DEFAULT 'PENDING',
  provider varchar(16) NOT NULL,
  environment varchar(8) NOT NULL,
  point_of_sale varchar(8) NOT NULL,
  voucher_number integer,
  cae varchar(20),
  cae_due date,
  -- Contingencia CAEA: se emite lo mas parecido a una factura real mientras WSFE
  -- no responde. Queda marcado para presentarla despues.
  contingency boolean NOT NULL DEFAULT false,
  -- Contenido empaquetado para el QR fiscal: la URL que exige AFIP. Se persiste
  -- porque el ticket lo imprime el POS y la reimpresion tiene que ser igual.
  qr_payload text,
  receiver jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Totales en centavos, SIEMPRE enteros.
  neto_cents integer NOT NULL CHECK (neto_cents >= 0),
  iva_cents integer NOT NULL CHECK (iva_cents >= 0),
  total_cents integer NOT NULL CHECK (total_cents >= 0),
  currency varchar(3) NOT NULL DEFAULT 'ARS',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error varchar(500),
  raw_request jsonb,
  raw_response jsonb,
  credit_note_for uuid REFERENCES invoices(id) ON DELETE SET NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  issued_at timestamptz,
  CONSTRAINT invoices_type_valid CHECK (type IN ('FACT_A','FACT_B','FACT_C','NC_A','NC_B','NC_C')),
  CONSTRAINT invoices_status_valid CHECK (status IN ('PENDING','EMITIDA','RECHAZADA','ERROR')),
  -- Lo emitido tiene CAE (o CAEA de contingencia) y numero; lo demas no.
  CONSTRAINT invoices_issued_consistent CHECK (
    status <> 'EMITIDA' OR (cae IS NOT NULL AND voucher_number IS NOT NULL AND issued_at IS NOT NULL)
  )
);

CREATE INDEX invoices_org_status_idx ON invoices (org_id, status, created_at DESC);
CREATE INDEX invoices_order_idx ON invoices (order_id);
CREATE INDEX invoices_pending_idx ON invoices (status, next_attempt_at) WHERE status = 'PENDING';
-- Una sola FACT original por comanda (las NC referencian a la FACT, no la duplican).
CREATE UNIQUE INDEX invoices_one_fact_per_order_key
  ON invoices (order_id, type) WHERE type LIKE 'FACT%' AND status <> 'ERROR';

-- =============================================================================
-- RLS
-- =============================================================================
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['fiscal_settings', 'invoices']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR SELECT USING (org_id = nullif(current_setting(''app.current_org'', true), '''')::uuid)',
      t || '_tenant_select', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR INSERT WITH CHECK (org_id = nullif(current_setting(''app.current_org'', true), '''')::uuid)',
      t || '_tenant_insert', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR UPDATE USING (org_id = nullif(current_setting(''app.current_org'', true), '''')::uuid) WITH CHECK (org_id = nullif(current_setting(''app.current_org'', true), '''')::uuid)',
      t || '_tenant_update', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR DELETE USING (org_id = nullif(current_setting(''app.current_org'', true), '''')::uuid)',
      t || '_tenant_delete', t);
  END LOOP;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON fiscal_settings, invoices TO comanda_app;

-- =============================================================================
-- Reclamo de la cola fiscal (plataforma, no de tenant)
--
-- El worker corre sin contexto de tenant (procesa todos los locales), asi que
-- no puede leer `invoices` por una query normal: RLS le devolveria 0 filas.
-- Como `platform_find_organization`, esto es SECURITY DEFINER y marca el intento
-- en la misma transaccion, asi dos workers no toman la misma fila.
-- =============================================================================
CREATE OR REPLACE FUNCTION platform_claim_pending_fiscal_invoices(p_limit integer)
RETURNS TABLE (id uuid, org_id uuid, venue_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  UPDATE invoices i
     SET attempts = i.attempts + 1,
         next_attempt_at = now() + interval '10 minutes',
         updated_at = now()
   WHERE i.id IN (
     SELECT i2.id
       FROM invoices i2
      WHERE i2.status = 'PENDING'
        AND i2.next_attempt_at <= now()
      ORDER BY i2.next_attempt_at
      LIMIT p_limit
      FOR UPDATE SKIP LOCKED
   )
  RETURNING i.id, i.org_id, i.venue_id;
END;
$$;

REVOKE ALL ON FUNCTION platform_claim_pending_fiscal_invoices(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_claim_pending_fiscal_invoices(integer) TO comanda_app;
