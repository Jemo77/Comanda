import { DEFAULT_ROLES } from '@comanda/domain';
import type { TestDatabase } from './env';

/**
 * Crea los roles por defecto de una organizacion, con sus permisos.
 *
 * Va en el harness y no en cada test porque es exactamente la misma logica que
 * corre `TenancyService.createOrganization`: si divergieran, los tests estarian
 * probando un RBAC que el producto no tiene.
 *
 * Con `ON CONFLICT DO NOTHING`: los roles de sistema ya pueden existir (creados por
 * el alta de la organizacion) y hay que completarlos con sus permisos en vez de
 * fallar o duplicar.
 */
export async function seedDefaultRoles(
  db: TestDatabase,
  orgId: string,
): Promise<Map<string, string>> {
  const byKey = new Map<string, string>();

  await db.asOrg(orgId, async (q: TestDatabase['query']) => {
    for (const role of Object.values(DEFAULT_ROLES)) {
      await q(
        `INSERT INTO roles (org_id, key, name, description, constraints, system)
         VALUES ($1::uuid, $2, $3, $4, $5::jsonb, true)
         ON CONFLICT (org_id, key) DO NOTHING`,
        [orgId, role.key, role.name, role.description, JSON.stringify(role.constraints)],
      );

      const found = await q<{ id: string }>(
        `SELECT id FROM roles WHERE org_id = $1::uuid AND key = $2`,
        [orgId, role.key],
      );
      const roleId = found.rows[0]!.id;
      byKey.set(role.key, roleId);

      for (const permission of role.permissions) {
        await q(
          `INSERT INTO role_permissions (org_id, role_id, permission_key)
           VALUES ($1::uuid, $2::uuid, $3) ON CONFLICT DO NOTHING`,
          [orgId, roleId, permission],
        );
      }
    }
  });

  return byKey;
}

/**
 * Crea un dispositivo en un local, con el estado pedido.
 * Los tests que revocan un dispositivo usan uno propio: revocar el compartido
 * romperia los tests que corren despues y volveria la suite dependiente del orden.
 */
export async function seedDevice(
  db: TestDatabase,
  params: { orgId: string; venueId: string; name: string; fingerprint: string; status?: string },
): Promise<string> {
  const result = await db.asOrg(params.orgId, async (q: TestDatabase['query']) => {
    // `$5` se usa dos veces (status y approved_at). Postgres deduce el tipo de un
    // parametro en su primera aparicion, asi que el `::device_status` va en la
    // primera y el cast del CASE evita que deduzca texto.
    const inserted = await q<{ id: string }>(
      `INSERT INTO devices (org_id, venue_id, name, kind, fingerprint, status, approved_at)
       VALUES ($1::uuid, $2::uuid, $3, 'tablet', $4, $5::device_status,
               CASE WHEN $5::device_status = 'active' THEN now() ELSE NULL END)
       ON CONFLICT (venue_id, fingerprint) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [params.orgId, params.venueId, params.name, params.fingerprint, params.status ?? 'active'],
    );
    return inserted.rows[0]!.id;
  });

  return result;
}

/**
 * Crea un usuario con hash de contrasena y/o PIN.
 * El hash del PIN depende del id del usuario, asi que se calcula DESPUES del insert.
 */
export async function seedUser(
  db: TestDatabase,
  params: {
    orgId: string;
    name: string;
    email: string;
    password?: { plain: string; hasher: { hashPassword(v: string): Promise<string> } };
    pin?: { plain: string; hasher: { hashPin(v: string, userId: string): Promise<string> } };
  },
): Promise<string> {
  return db.asOrg(params.orgId, async (q: TestDatabase['query']) => {
    const inserted = await q<{ id: string }>(
      `INSERT INTO users (org_id, name, email, password_hash, pin_hash, pin_set_at)
       VALUES ($1::uuid, $2, $3, $4, $5, CASE WHEN $5::text IS NOT NULL THEN now() ELSE NULL END)
       RETURNING id`,
      [
        params.orgId,
        params.name,
        params.email,
        params.password ? await params.password.hasher.hashPassword(params.password.plain) : null,
        // Se inserta un hash placeholder y se reemplaza abajo, porque depende del id.
        params.pin ? 'placeholder' : null,
      ],
    );

    const id = inserted.rows[0]!.id;
    if (params.pin) {
      await q(`UPDATE users SET pin_hash = $2 WHERE id = $1::uuid`, [
        id,
        await params.pin.hasher.hashPin(params.pin.plain, id),
      ]);
    }
    return id;
  });
}

/** Asigna un rol a un usuario en un local concreto. */
export async function assignRole(
  db: TestDatabase,
  params: { orgId: string; userId: string; roleId: string; venueId: string | null },
): Promise<void> {
  await db.asOrg(params.orgId, (q: TestDatabase['query']) =>
    q(
      `INSERT INTO user_roles (org_id, user_id, role_id, venue_id)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid) ON CONFLICT DO NOTHING`,
      [params.orgId, params.userId, params.roleId, params.venueId],
    ),
  );
}
