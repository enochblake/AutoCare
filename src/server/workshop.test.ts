import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
let db: PGlite;
async function scalar(sql: string, params: unknown[] = []) {
  const r = await db.query<Record<string, unknown>>(sql, params);
  return Object.values(r.rows[0])[0];
}
async function fails(sql: string, params: unknown[], message: string) {
  await db.exec("savepoint expected_failure");
  let caught: unknown;
  try {
    await db.query(sql, params);
  } catch (error) {
    caught = error;
  }
  await db.exec(
    "rollback to savepoint expected_failure; release savepoint expected_failure",
  );
  expect(String(caught)).toContain(message);
}
const quoteLines = [
  {
    description: "Spark plugs",
    quantity: 4,
    unitPrice: 500,
    inventoryItemId: id(60),
  },
  {
    description: "Labour",
    quantity: 1,
    unitPrice: 1000,
    inventoryItemId: null,
  },
];
async function quote(lines = quoteLines) {
  return (await scalar("select send_repair_quote($1,$2,$3::jsonb,$4)", [
    id(1),
    id(50),
    JSON.stringify(lines),
    "Full repair",
  ])) as string;
}
async function approve(q: string) {
  await db.query("select decide_repair_quote($1,$2,'APPROVED')", [id(2), q]);
}
async function readMigration(file: string) {
  // PGlite omits pgcrypto and Supabase's platform-only advisor extensions.
  return (await readFile(path.join("supabase/migrations", file), "utf8"))
    .replace("create extension if not exists pgcrypto;", "")
    .replace(/^(?:CREATE|COMMENT ON) EXTENSION "(?:hypopg|index_advisor)"[^;]*;/gm, "");
}
describe("workshop database workflows", () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(
      "create role anon; create role authenticated; create role service_role bypassrls; create schema auth; grant usage on schema auth to anon,authenticated; create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz); create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);",
    );
    // Supabase grants new public tables to browser roles unless explicitly revoked.
    await db.exec(
      "alter default privileges in schema public grant all on tables to anon,authenticated,service_role",
    );
    const dir = path.resolve("supabase/migrations");
    for (const file of (await readdir(dir))
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      await db.exec(await readMigration(file));
    }
    for (let n = 1; n <= 6; n++) {
      await db.query("insert into auth.users values($1,$2,now())", [
        id(n),
        `person${n}@example.com`,
      ]);
      await db.query(
        "insert into profiles(id,email,first_name,last_name) values($1,$2,'Test','Person')",
        [id(n), `person${n}@example.com`],
      );
    }
    await db.query(
      "insert into franchises(id,name,slug,email,owner_id) values($1,'Garage','garage','garage@example.com',$2)",
      [id(10), id(1)],
    );
    await db.query(
      "insert into plans(id,name,code,monthly_price,max_shops,max_staff) values($1,'Starter','STARTER',3500,1,8)",
      [id(11)],
    );
    await db.query(
      "insert into subscriptions(franchise_id,plan_id,trial_ends_at,current_period_starts_at,current_period_ends_at) values($1,$2,now()+interval '14 days',now(),now()+interval '14 days')",
      [id(10), id(11)],
    );
    await db.query(
      "insert into shops(id,franchise_id,name,slug,email,address,county) values($1,$2,'Branch','branch','branch@example.com','Street','Nairobi')",
      [id(20), id(10)],
    );
    await db.query(
      "insert into memberships(id,user_id,franchise_id,shop_id,role) values($1,$2,$3,null,'FRANCHISE_OWNER'),($4,$5,$3,$6,'MECHANIC'),($7,$8,$3,$6,'ACCOUNTANT')",
      [id(70), id(1), id(10), id(71), id(3), id(20), id(72), id(6)],
    );
    await db.query(
      "insert into vehicles(id,owner_id,registration,make,model,year,mileage_km) values($1,$2,'KDA 123A','Toyota','Fielder',2020,10000)",
      [id(30), id(2)],
    );
    for (const n of [40, 41])
      await db.query(
        "insert into bookings(id,reference,franchise_id,shop_id,customer_id,vehicle_id,status,scheduled_at) values($1,$2,$3,$4,$5,$6,'CONFIRMED',now()+interval '14 days')",
        [id(n), `BK-${n}`, id(10), id(20), id(2), id(30)],
      );
    await db.query(
      "insert into jobs(id,reference,franchise_id,shop_id,booking_id,customer_id,vehicle_id) values($1,'JOB-50',$2,$3,$4,$5,$6)",
      [id(50), id(10), id(20), id(40), id(2), id(30)],
    );
    await db.query("update jobs set assigned_mechanic_id=$1 where id=$2", [
      id(71),
      id(50),
    ]);
    await db.query(
      "insert into inventory_items(id,franchise_id,shop_id,sku,name,quantity_on_hand,reorder_level,unit_cost,selling_price) values($1,$2,$3,'PLUG','Spark plug',10,2,300,500)",
      [id(60), id(10), id(20)],
    );
    await db.query(
      "insert into workshop_bays(id,shop_id,name) values($1,$2,'Bay 1'),($3,$2,'Bay 2')",
      [id(80), id(20), id(81)],
    );
  }, 60000);
  beforeEach(async () => {
    await db.exec("begin");
  });
  afterEach(async () => {
    await db.exec("rollback");
  });
  afterAll(async () => {
    await db?.close();
  });
  it("preserves a pre-existing RLS event trigger and its handler during the snapshot migration", async () => {
    await db.exec(`
      create or replace function public.rls_auto_enable() returns event_trigger
      language plpgsql as $$ begin return; end $$;
      revoke execute on function public.rls_auto_enable() from service_role;
    `);
    const trigger = `select json_build_object('oid', t.oid, 'function', pg_get_functiondef(p.oid), 'acl', p.proacl)
      from pg_event_trigger t join pg_proc p on p.oid = t.evtfoid where t.evtname = 'ensure_rls'`;
    const before = await scalar(trigger);
    await db.exec(await readMigration("20261118180231_remote_schema.sql"));
    expect(await scalar(trigger)).toEqual(before);
  });
  it("returns null for unset or empty subject claims and preserves valid UUIDs", async () => {
    expect(await scalar("select auth.uid()")).toBeNull();
    await db.query("select set_config('request.jwt.claim.sub','',true)");
    expect(await scalar("select auth.uid()")).toBeNull();
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [id(3)]);
    expect(await scalar("select auth.uid()")).toBe(id(3));
  });
  it("enforces booking capacity for a shop's local day", async () => {
    const scheduledAt = await scalar(
      `select ((date_trunc('week', now() at time zone 'Africa/Nairobi') + interval '7 days 10 hours')
        at time zone 'Africa/Nairobi')::text`,
    );
    await db.query("update shops set booking_capacity=1 where id=$1", [id(20)]);
    await db.query(
      "update bookings set scheduled_at=$1,status=case when id=$2 then 'CANCELLED' else 'DECLINED' end where shop_id=$3",
      [scheduledAt, id(40), id(20)],
    );
    await db.exec("set local role service_role");

    const sql = "select create_booking($1,$2,$3,null,$4,null,$5)";
    const args = [id(2), id(20), id(30)];
    const bookingId = await scalar(sql, [...args, scheduledAt, "CAPACITY-LAST"]);
    expect(await scalar("select status from bookings where id=$1", [bookingId])).toBe("REQUESTED");
    await fails(sql, [...args, scheduledAt, "CAPACITY-OVER"], "CAPACITY_REACHED");

    const nextDay = await scalar("select ($1::timestamptz + interval '1 day')::text", [scheduledAt]);
    await scalar(sql, [...args, nextDay, "CAPACITY-NEXT"]);
    expect(
      (await db.query("select reference from bookings where shop_id=$1 and status not in ('CANCELLED','DECLINED') order by reference", [id(20)])).rows,
    ).toEqual([{ reference: "CAPACITY-LAST" }, { reference: "CAPACITY-NEXT" }]);
  });
  it("uses the same lock key for bookings on the same shop-local date", async () => {
    // PGlite is single-session, so record the keys passed by the real booking RPC.
    await db.exec(`
      set local time zone 'UTC';
      create temp table booking_lock_keys (key bigint);
      create function public.pg_advisory_xact_lock(bigint) returns void language sql
        as $$ insert into pg_temp.booking_lock_keys values ($1) $$;
      alter function public.create_booking(uuid,uuid,uuid,uuid,timestamptz,text,text)
        set search_path = public, pg_catalog;
    `);
    await db.query(
      `update shops set opening_hours=jsonb_set(opening_hours,'{mon,open}','"00:00"') where id=$1`,
      [id(20)],
    );
    const sql = `select create_booking($1,$2,$3,null,
      (date_trunc('week',now() at time zone 'Africa/Nairobi') + interval '21 days' + $4::interval)
        at time zone 'Africa/Nairobi',null,$5)`;
    const args = [id(2), id(20), id(30)];
    const distinctKeys = "select count(distinct key) from pg_temp.booking_lock_keys";
    await db.query(sql, [...args, "30 minutes", "LOCK-EARLY"]);
    await db.exec("set local datestyle = 'SQL, DMY'");
    await db.query(sql, [...args, "10 hours", "LOCK-LATE"]);
    expect(await scalar(distinctKeys)).toBe(1);
    await db.query(sql, [...args, "1 day 10 hours", "LOCK-NEXT-DAY"]);
    expect(await scalar(distinctKeys)).toBe(2);
  });
  it.each(["TRIAL", "ACTIVE", "PAST_DUE"])("blocks booking and workshop writes for %s without changing existing records", async (status) => {
    await db.query("update franchises set status=$1 where id=$2", [status, id(10)]);
    await db.query(
      `update subscriptions set
        trial_ends_at=case when $1='TRIAL' then clock_timestamp() else trial_ends_at end,
        current_period_ends_at=case when $1='ACTIVE' then clock_timestamp() else current_period_ends_at end
        where franchise_id=$2`,
      [status, id(10)],
    );
    await db.query("update bookings set status='REQUESTED' where id=$1", [id(41)]);
    await db.exec("set local role service_role");
    await fails(
      "select create_booking($1,$2,$3,null,date_trunc('week',now())+interval '14 days 7 hours',null,'BLOCKED')",
      [id(2), id(20), id(30)], status === "PAST_DUE" ? "SHOP_NOT_FOUND" : "TENANT_READ_ONLY",
    );
    await fails("select decide_booking($1,$2,'CONFIRMED',null)", [id(41), id(1)], "TENANT_READ_ONLY");
    expect(await scalar("select status from bookings where id=$1", [id(41)])).toBe("REQUESTED");
    await db.query("update bookings set status='CONFIRMED' where id=$1", [id(41)]);
    await fails("select create_job_from_booking($1,$2,'BLOCKED')", [id(41), id(1)], "TENANT_READ_ONLY");
    await fails("select send_repair_quote($1,$2,$3::jsonb,null)", [id(1), id(50), JSON.stringify(quoteLines)], "TENANT_READ_ONLY");
    expect(await scalar("select count(*) from jobs")).toBe(1);
    expect(await scalar("select count(*) from repair_quotes")).toBe(0);
  });
  it("restores writes after a paid renewal and fails closed for a missing subscription", async () => {
    await db.exec("set local role service_role");
    await db.query("update franchises set status='PAST_DUE' where id=$1", [id(10)]);
    await fails("select assert_tenant_writable($1)", [id(10)], "TENANT_READ_ONLY");
    await db.query("update subscriptions set trial_ends_at=now()-interval '1 day', current_period_ends_at=now()+interval '1 month' where franchise_id=$1", [id(10)]);
    await db.query("update franchises set status='ACTIVE' where id=$1", [id(10)]);
    expect(await quote()).toEqual(expect.any(String));
    await db.query("delete from subscriptions where franchise_id=$1", [id(10)]);
    await fails("select assert_tenant_writable($1)", [id(10)], "TENANT_READ_ONLY");
  });
  it("preserves a customer's quote and payment actions while garage job writes are paused", async () => {
    const pendingQuote = await quote();
    await db.query(
      "insert into invoices(id,number,franchise_id,shop_id,customer_id,status,subtotal,tax_amount,total_amount) values($1,'EXISTING',$2,$3,$4,'ISSUED',1000,0,1000)",
      [id(900), id(10), id(20), id(2)],
    );
    await db.query("update franchises set status='PAST_DUE' where id=$1", [id(10)]);
    await db.exec("set local role service_role");
    await approve(pendingQuote);
    expect(await scalar("select status from repair_quotes where id=$1", [pendingQuote])).toBe("APPROVED");
    await fails("select transition_repair_job($1,$2,'IN_PROGRESS')", [id(1), id(50)], "TENANT_READ_ONLY");
    await fails("select issue_repair_invoice($1,$2,'BLOCKED')", [id(50), id(1)], "TENANT_READ_ONLY");
    await fails("select record_service_mileage($1,$2,12000)", [id(1), id(50)], "TENANT_READ_ONLY");
    const payment = await scalar("select reserve_sandbox_payment($1,$2,'STRIPE')", [id(900), id(2)]) as { id: string; reference: string };
    await db.query("update payments set provider_reference='cs_test_read_only',status='PROCESSING' where id=$1", [payment.id]);
    expect(await scalar("select settle_verified_invoice_payment($1,'STRIPE','cs_test_read_only',100000,'KES',true)", [payment.reference])).toBe(true);
    expect(await scalar("select amount_paid from invoices where id=$1", [id(900)])).toBe("1000.00");
  });
  it("denies browser roles access to the entitlement check", async () => {
    for (const role of ["anon", "authenticated"]) {
      expect(await scalar("select has_function_privilege($1,'public.assert_tenant_writable(uuid)','execute')", [role])).toBe(false);
    }
  });
  it("keeps operational table access server-only for every CRUD operation", async () => {
    for (const table of [
      "bookings",
      "jobs",
      "invoices",
      "inventory_items",
      "service_catalog",
      "shops",
      "payments",
      "subscriptions",
      "staff_invitations",
      "audit_logs",
      "vehicle_history_shares",
      "franchises",
      "invoice_lines",
      "job_stages",
      "notifications",
      "plans",
      "push_devices",
      "repair_tasks",
      "repair_photos",
      "repair_quotes",
      "repair_quote_lines",
      "job_part_movements",
      "workshop_bays",
      "workshop_slots",
      "maintenance_reminders",
    ]) {
      for (const operation of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        for (const role of ["anon", "authenticated", "service_role"]) {
          expect(
            await scalar("select has_table_privilege($1,$2,$3)", [
              role,
              `public.${table}`,
              operation,
            ]),
            `${role} ${operation} on ${table}`,
          ).toBe(role === "service_role");
        }
      }
      expect(
        await scalar(
          "select relrowsecurity from pg_class where oid=$1::regclass",
          [`public.${table}`],
        ),
      ).toBe(true);
    }
  });
  it("preserves owner-scoped vehicle access without exposing another owner's vehicles", async () => {
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [id(2)]);
    await db.exec("set local role authenticated");
    expect(await scalar("select id from vehicles")).toBe(id(30));
    await db.query("update vehicles set mileage_km=11000 where id=$1", [id(30)]);
    expect(await scalar("select mileage_km from vehicles")).toBe(11000);
    await fails(
      "update vehicles set owner_id=$1 where id=$2",
      [id(3), id(30)],
      "violates row-level security policy",
    );
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [id(3)]);
    expect(await scalar("select count(*) from vehicles")).toBe(0);
    expect(
      (await db.query("update vehicles set mileage_km=1 where id=$1 returning id", [id(30)])).rows,
    ).toEqual([]);
  });
  it.each([
    { column: "global_role", value: "PLATFORM_ADMIN" },
    { column: "email", value: "spoofed@example.com" },
    { column: "is_active", value: true },
    { column: "phone_encrypted", value: "forged-ciphertext" },
    { column: "phone_search_hash", value: "forged-search-hash" },
  ])("blocks browser updates to profile $column", async ({ column, value }) => {
    if (column === "is_active") {
      await db.query("update profiles set is_active=false where id=$1", [id(3)]);
    }
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [id(3)]);
    await db.exec("set local role authenticated");
    await fails(
      `update profiles set ${column}=$1 where id=$2`,
      [value, id(3)],
      "permission denied for table profiles",
    );
    for (const role of ["anon", "authenticated"]) {
      expect(
        await scalar("select has_table_privilege($1,'public.profiles','UPDATE')", [
          role,
        ]),
      ).toBe(false);
      expect(
        await scalar(
          "select has_column_privilege($1,'public.profiles',$2,'UPDATE')",
          [role, column],
        ),
      ).toBe(false);
    }
  });
  it("preserves self-only profile reads and hides profiles from anonymous users", async () => {
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [id(3)]);
    await db.exec("set local role authenticated");
    expect((await db.query("select id,email from profiles")).rows).toEqual([
      { id: id(3), email: "person3@example.com" },
    ]);
    await db.exec("set local role anon");
    expect((await db.query("select id from profiles")).rows).toEqual([]);
  });
  it("preserves server-managed profile updates", async () => {
    await db.exec("set local role service_role");
    expect(
      (
        await db.query(
          "update profiles set global_role='PLATFORM_ADMIN',email='verified@example.com',is_active=false,phone_encrypted='server-ciphertext',phone_search_hash='server-search-hash' where id=$1 returning global_role,email,is_active,phone_encrypted,phone_search_hash",
          [id(3)],
        )
      ).rows,
    ).toEqual([
      {
        global_role: "PLATFORM_ADMIN",
        email: "verified@example.com",
        is_active: false,
        phone_encrypted: "server-ciphertext",
        phone_search_hash: "server-search-hash",
      },
    ]);
    expect(await scalar("select count(*) from profiles")).toBe(6);
  });
  it.each([
    {
      name: "mechanic",
      role: "MECHANIC",
      profileActive: true,
      memberActive: true,
      status: "ACTIVE",
    },
    {
      name: "accountant",
      role: "ACCOUNTANT",
      profileActive: true,
      memberActive: true,
      status: "ACTIVE",
    },
    {
      name: "disabled profile",
      role: "MECHANIC",
      profileActive: false,
      memberActive: true,
      status: "ACTIVE",
    },
    {
      name: "inactive membership",
      role: "MECHANIC",
      profileActive: true,
      memberActive: false,
      status: "ACTIVE",
    },
    {
      name: "suspended garage",
      role: "MECHANIC",
      profileActive: true,
      memberActive: true,
      status: "SUSPENDED",
    },
  ])("blocks direct invoice tampering for $name", async (actor) => {
    await db.query("update profiles set is_active=$1 where id=$2", [
      actor.profileActive,
      id(3),
    ]);
    await db.query("update memberships set role=$1,is_active=$2 where id=$3", [
      actor.role,
      actor.memberActive,
      id(71),
    ]);
    await db.query("update franchises set status=$1 where id=$2", [
      actor.status,
      id(10),
    ]);
    await db.query(
      "insert into invoices(id,number,franchise_id,shop_id,customer_id,status,subtotal,tax_amount,total_amount) values($1,'DIRECT-WRITE',$2,$3,$4,'ISSUED',1000,0,1000)",
      [id(900), id(10), id(20), id(2)],
    );
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [
      id(3),
    ]);
    await db.exec("set local role authenticated");
    expect(await scalar("select auth.uid()")).toBe(id(3));
    await fails(
      "update invoices set status='PAID',amount_paid=1000 where id=$1",
      [id(900)],
      "permission denied for table invoices",
    );
    await db.exec("set local role service_role");
    expect(
      await scalar("select status from invoices where id=$1", [id(900)]),
    ).toBe("ISSUED");
    expect(
      await scalar("select amount_paid from invoices where id=$1", [id(900)]),
    ).toBe("0.00");
  });
  it("blocks a mechanic from directly reading another branch's internal booking notes", async () => {
    await db.query(
      "insert into shops(id,franchise_id,name,slug,email,address,county) values($1,$2,'Other branch','other','other@example.com','Street','Nairobi')",
      [id(21), id(10)],
    );
    await db.query(
      "insert into bookings(id,reference,franchise_id,shop_id,customer_id,vehicle_id,scheduled_at,internal_notes) values($1,'OTHER-BRANCH',$2,$3,$4,$5,now()+interval '14 days','Private branch note')",
      [id(42), id(10), id(21), id(2), id(30)],
    );
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [
      id(3),
    ]);
    await db.exec("set local role authenticated");
    await fails(
      "select internal_notes from bookings where id=$1",
      [id(42)],
      "permission denied for table bookings",
    );
    await db.exec("set local role service_role");
    expect(
      await scalar("select internal_notes from bookings where id=$1", [id(42)]),
    ).toBe("Private branch note");
  });
  it("blocks forged history consent and protects existing grants from garage staff", async () => {
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [
      id(3),
    ]);
    await db.exec("set local role authenticated");
    await fails(
      "insert into vehicle_history_shares(vehicle_id,franchise_id,owner_id) values($1,$2,$3)",
      [id(30), id(10), id(2)],
      "permission denied for table vehicle_history_shares",
    );
    await db.exec("set local role service_role");
    expect(await scalar("select count(*) from vehicle_history_shares")).toBe(0);
    await db.query(
      "insert into vehicle_history_shares(vehicle_id,franchise_id,owner_id) values($1,$2,$3)",
      [id(30), id(10), id(2)],
    );
    await db.exec("set local role authenticated");
    await fails(
      "update vehicle_history_shares set owner_id=$1 where vehicle_id=$2",
      [id(3), id(30)],
      "permission denied for table vehicle_history_shares",
    );
    await fails(
      "delete from vehicle_history_shares where vehicle_id=$1",
      [id(30)],
      "permission denied for table vehicle_history_shares",
    );
    await db.exec("set local role service_role");
    expect(await scalar("select owner_id from vehicle_history_shares")).toBe(
      id(2),
    );
    await db.query("delete from vehicle_history_shares where vehicle_id=$1", [
      id(30),
    ]);
    expect(await scalar("select count(*) from vehicle_history_shares")).toBe(0);
  });
  it("requires customer approval and rejects unauthorized or stale decisions", async () => {
    const first = await quote();
    await fails(
      "select decide_repair_quote($1,$2,'APPROVED')",
      [id(4), first],
      "FORBIDDEN",
    );
    const second = await quote();
    await fails(
      "select decide_repair_quote($1,$2,'APPROVED')",
      [id(2), first],
      "QUOTE_CHANGED",
    );
    await approve(second);
    const result = await db.query<{
      total: string;
      decided_by: string;
      decided_at: string;
    }>("select total,decided_by,decided_at from repair_quotes where id=$1", [
      second,
    ]);
    expect(result.rows[0]).toMatchObject({
      total: "3000.00",
      decided_by: id(2),
    });
    expect(result.rows[0].decided_at).toBeTruthy();
  });
  it("blocks work before approval and again after a revised quote", async () => {
    await db.query(
      "insert into repair_tasks(id,job_id,title) values($1,$2,'Fit spark plugs')",
      [id(90), id(50)],
    );
    await fails(
      "update repair_tasks set status='IN_PROGRESS' where id=$1",
      [id(90)],
      "APPROVAL_REQUIRED",
    );
    const first = await quote();
    await approve(first);
    await db.query("update repair_tasks set status='IN_PROGRESS' where id=$1", [
      id(90),
    ]);
    await quote();
    await fails(
      "update repair_tasks set status='COMPLETED' where id=$1",
      [id(90)],
      "APPROVAL_REQUIRED",
    );
    expect(
      await scalar("select status from repair_quotes where id=$1", [first]),
    ).toBe("APPROVED");
  });
  it("deducts parts once, audits the actor, and returns stock", async () => {
    await approve(await quote());
    const params = [id(3), id(50), id(60), 4, "USE", id(100)];
    await db.query("select record_job_parts($1,$2,$3,$4,$5,$6)", params);
    await db.query("select record_job_parts($1,$2,$3,$4,$5,$6)", params);
    expect(
      await scalar("select quantity_on_hand from inventory_items where id=$1", [
        id(60),
      ]),
    ).toBe("6.000");
    expect(await scalar("select count(*) from job_part_movements")).toBe(1);
    expect(await scalar("select actor_id from job_part_movements")).toBe(id(3));
    await fails(
      "select record_job_parts($1,$2,$3,1,'USE',$4)",
      [id(3), id(50), id(60), id(101)],
      "EXCEEDS_APPROVED",
    );
    await db.query("select record_job_parts($1,$2,$3,2,'RETURN',$4)", [
      id(3),
      id(50),
      id(60),
      id(102),
    ]);
    expect(
      await scalar("select quantity_on_hand from inventory_items where id=$1", [
        id(60),
      ]),
    ).toBe("8.000");
    await fails(
      "select record_job_parts($1,$2,$3,3,'RETURN',$4)",
      [id(3), id(50), id(60), id(103)],
      "INVALID_RETURN",
    );
  });
  it("prevents stock shortages and unauthorized mechanics from changing stock", async () => {
    await approve(await quote());
    await db.query(
      "update inventory_items set quantity_on_hand=1 where id=$1",
      [id(60)],
    );
    await fails(
      "select record_job_parts($1,$2,$3,4,'USE',$4)",
      [id(3), id(50), id(60), id(100)],
      "INSUFFICIENT_STOCK",
    );
    await fails(
      "select record_job_parts($1,$2,$3,1,'USE',$4)",
      [id(4), id(50), id(60), id(101)],
      "FORBIDDEN",
    );
    expect(await scalar("select count(*) from job_part_movements")).toBe(0);
  });
  it("issues exactly one itemized invoice and never bills stock twice", async () => {
    await fails(
      "select issue_repair_invoice($1,$2,'INV-1')",
      [id(50), id(6)],
      "APPROVAL_REQUIRED",
    );
    await approve(await quote());
    await fails(
      "select issue_repair_invoice($1,$2,'INV-1')",
      [id(50), id(6)],
      "PARTS_MISMATCH",
    );
    await db.query("select record_job_parts($1,$2,$3,4,'USE',$4)", [
      id(3),
      id(50),
      id(60),
      id(100),
    ]);
    const invoice = await scalar("select issue_repair_invoice($1,$2,'INV-1')", [
      id(50),
      id(6),
    ]);
    expect(
      await scalar("select issue_repair_invoice($1,$2,'INV-2')", [
        id(50),
        id(6),
      ]),
    ).toBe(invoice);
    expect(
      await scalar(
        "select sum(line_total) from invoice_lines where invoice_id=$1",
        [invoice],
      ),
    ).toBe("3000.00");
    expect(
      await scalar("select count(*) from invoice_lines where invoice_id=$1", [
        invoice,
      ]),
    ).toBe(2);
    await fails(
      "select send_repair_quote($1,$2,$3::jsonb,'changed')",
      [id(1), id(50), JSON.stringify(quoteLines)],
      "JOB_CLOSED",
    );
  });
  it("blocks overlapping bay and mechanic bookings but allows adjacent slots", async () => {
    const start = await scalar(
      "select date_trunc('week',now())+interval '14 days 6 hours'",
    );
    const end = new Date(
      new Date(String(start)).getTime() + 3600000,
    ).toISOString();
    await db.query("select save_workshop_slot($1,$2,$3,$4,$5,$6)", [
      id(1),
      id(40),
      id(71),
      id(80),
      start,
      end,
    ]);
    await fails(
      "select save_workshop_slot($1,$2,$3,$4,$5,$6)",
      [id(1), id(41), id(71), id(81), start, end],
      "SLOT_CONFLICT",
    );
    const nextEnd = new Date(new Date(end).getTime() + 3600000).toISOString();
    await db.query("select save_workshop_slot($1,$2,$3,$4,$5,$6)", [
      id(1),
      id(41),
      id(71),
      id(80),
      end,
      nextEnd,
    ]);
    expect(await scalar("select count(*) from workshop_slots")).toBe(2);
  });
  it("accepts invitations only for the verified intended account", async () => {
    await db.query(
      "insert into staff_invitations(id,franchise_id,shop_id,email,role,invited_by) values($1,$2,$3,'person5@example.com','MECHANIC',$4)",
      [id(110), id(10), id(20), id(1)],
    );
    await fails(
      "select accept_staff_invitation($1,$2,$3)",
      [id(4), id(110), "person4@example.com"],
      "INVITATION_INVALID",
    );
    await db.query("update franchises set status='PAST_DUE' where id=$1", [id(10)]);
    await fails(
      "select accept_staff_invitation($1,$2,$3)",
      [id(5), id(110), "person5@example.com"],
      "TENANT_READ_ONLY",
    );
    await db.query("update franchises set status='TRIAL' where id=$1", [id(10)]);
    await db.query("select accept_staff_invitation($1,$2,$3)", [
      id(5),
      id(110),
      "person5@example.com",
    ]);
    expect(
      await scalar("select role from memberships where user_id=$1", [id(5)]),
    ).toBe("MECHANIC");
    await fails(
      "select accept_staff_invitation($1,$2,$3)",
      [id(5), id(110), "person5@example.com"],
      "INVITATION_INVALID",
    );
  });
  it("records service mileage and refuses a lower reading", async () => {
    await db.query("select record_service_mileage($1,$2,12000)", [
      id(3),
      id(50),
    ]);
    expect(
      await scalar("select mileage_km from vehicles where id=$1", [id(30)]),
    ).toBe(12000);
    await fails(
      "select record_service_mileage($1,$2,11000)",
      [id(3), id(50)],
      "INVALID_MILEAGE",
    );
  });
  it("denies browser roles access to private tables and mutation RPCs", async () => {
    expect(
      await scalar(
        "select has_function_privilege('authenticated','public.send_repair_quote(uuid,uuid,jsonb,text)','execute')",
      ),
    ).toBe(false);
    expect(
      await scalar(
        "select has_table_privilege('anon','public.vehicle_history_shares','select')",
      ),
    ).toBe(false);
    expect(
      await scalar(
        "select relrowsecurity from pg_class where oid='public.staff_invitations'::regclass",
      ),
    ).toBe(true);
  });
  it("allows the server role to run the complete quote and invoice flow", async () => {
    await db.exec("set local role service_role");
    await approve(await quote());
    await db.query("select record_job_parts($1,$2,$3,4,'USE',$4)", [
      id(3),
      id(50),
      id(60),
      id(100),
    ]);
    expect(
      await scalar("select issue_repair_invoice($1,$2,'INV-SERVER')", [
        id(50),
        id(6),
      ]),
    ).toBeTruthy();
  });
  describe("atomic repair status transitions", () => {
    async function prepareRepair() {
      await approve(await quote());
      await db.query(
        "insert into repair_tasks(id,job_id,title,status) values($1,$2,'Fit spark plugs','COMPLETED')",
        [id(90), id(50)],
      );
      await db.query("update jobs set status='IN_PROGRESS' where id=$1", [id(50)]);
    }
    const transition = (status: string, actor = id(1)) =>
      db.query("select transition_repair_job($1,$2,$3)", [actor, id(50), status]);
    const notices = () => scalar("select count(*) from notifications where type='REPAIR_STATUS'");

    it("saves handover once and preserves completed_at on retries", async () => {
      await prepareRepair();
      await db.exec("set local role service_role");
      await transition("READY", id(3));
      await transition("READY", id(3));
      expect(await scalar("select status from jobs where id=$1", [id(50)])).toBe("READY");
      expect(await scalar("select status from bookings where id=$1", [id(40)])).toBe("READY_FOR_COLLECTION");
      expect(await notices()).toBe(1);
      expect((await db.query("select user_id,data from notifications where type='REPAIR_STATUS'")).rows).toEqual([
        { user_id: id(2), data: { jobId: id(50), status: "READY" } },
      ]);
      await transition("COMPLETED");
      expect(await scalar("select completed_at from jobs where id=$1", [id(50)])).toBeTruthy();
      await db.query("update jobs set completed_at='2026-01-01T00:00:00Z' where id=$1", [id(50)]);
      const completedAt = await scalar("select completed_at from jobs where id=$1", [id(50)]);
      await transition("COMPLETED");
      expect(await scalar("select completed_at from jobs where id=$1", [id(50)])).toEqual(completedAt);
      expect(await scalar("select status from bookings where id=$1", [id(40)])).toBe("COMPLETED");
      expect(await notices()).toBe(2);
    });

    it.each([
      ["bookings", "READY"], ["notifications", "READY"],
      ["bookings", "COMPLETED"], ["notifications", "COMPLETED"],
    ])("rolls everything back if %s fails during %s, then permits a clean retry", async (table, target) => {
      await prepareRepair();
      if (target === "COMPLETED") await transition("READY");
      const beforeStatus = target === "READY" ? "IN_PROGRESS" : "READY";
      const beforeBooking = target === "READY" ? "CONFIRMED" : "READY_FOR_COLLECTION";
      const beforeNotices = target === "READY" ? 0 : 1;
      await db.exec(`
        create function pg_temp.reject_status_write() returns trigger language plpgsql as $$
        begin raise exception 'INJECTED_STATUS_FAILURE'; end $$;
        create trigger reject_status_write before ${table === "bookings" ? "update" : "insert"} on ${table}
        for each row execute function pg_temp.reject_status_write();
      `);
      await fails("select transition_repair_job($1,$2,$3)", [id(1), id(50), target], "INJECTED_STATUS_FAILURE");
      expect(await scalar("select status from jobs where id=$1", [id(50)])).toBe(beforeStatus);
      expect(await scalar("select completed_at from jobs where id=$1", [id(50)])).toBeNull();
      expect(await scalar("select status from bookings where id=$1", [id(40)])).toBe(beforeBooking);
      expect(await notices()).toBe(beforeNotices);
      await db.exec(`drop trigger reject_status_write on ${table}`);
      await transition(target);
      await transition(target);
      expect(await scalar("select status from bookings where id=$1", [id(40)])).toBe(
        target === "READY" ? "READY_FOR_COLLECTION" : "COMPLETED",
      );
      expect(await notices()).toBe(beforeNotices + 1);
    });

    it("repairs legacy partial READY/COMPLETED writes without duplicate notices", async () => {
      await prepareRepair();
      for (const status of ["READY", "COMPLETED"]) {
        await db.query("update jobs set status=$1 where id=$2", [status, id(50)]);
        await transition(status);
        await db.query("update bookings set status='IN_PROGRESS' where id=$1", [id(40)]);
        await transition(status);
        expect(await scalar("select status from bookings where id=$1", [id(40)])).toBe(
          status === "READY" ? "READY_FOR_COLLECTION" : "COMPLETED",
        );
      }
      expect(await notices()).toBe(2);
    });

    it("supports repairs without a linked booking", async () => {
      await prepareRepair();
      await db.query("update jobs set booking_id=null where id=$1", [id(50)]);
      await transition("READY");
      await transition("COMPLETED");
      expect(await scalar("select status from jobs where id=$1", [id(50)])).toBe("COMPLETED");
      expect(await scalar("select status from bookings where id=$1", [id(40)])).toBe("CONFIRMED");
      expect(await notices()).toBe(2);
    });

    it.each(["PENDING", "IN_PROGRESS"])("rejects a delayed %s task write after READY commits", async (status) => {
      await prepareRepair();
      await db.query("update jobs set status='APPROVED' where id=$1", [id(50)]);
      expect(await scalar("select status from jobs where id=$1", [id(50)])).toBe("APPROVED");
      await transition("IN_PROGRESS");
      await transition("READY");
      await db.exec("set local role service_role");
      await fails("update repair_tasks set status=$1 where id=$2 returning status", [status, id(90)], "JOB_READY");
      expect(await scalar("select status from repair_tasks where id=$1", [id(90)])).toBe("COMPLETED");
      expect(await scalar("select status from jobs where id=$1", [id(50)])).toBe("READY");
      expect(await scalar("select status from bookings where id=$1", [id(40)])).toBe("READY_FOR_COLLECTION");
      expect(await notices()).toBe(1);
    });

    it.each(["PENDING", "IN_PROGRESS"])("rejects a new unfinished %s task after READY", async (status) => {
      await prepareRepair();
      await transition("READY");
      await fails("insert into repair_tasks(id,job_id,title,status) values($1,$2,'Late step',$3)", [id(91), id(50), status], "JOB_READY");
      expect(await scalar("select count(*) from repair_tasks where job_id=$1", [id(50)])).toBe(1);
    });

    it.each(["approved quote", "legacy invoice"])("preserves task edits before handover and completed-task notes at READY with %s", async (approval) => {
      await prepareRepair();
      if (approval === "legacy invoice") {
        await db.query("insert into invoices(number,franchise_id,shop_id,customer_id,job_id,subtotal,tax_amount,total_amount) values('READY-GUARD-LEGACY',$1,$2,$3,$4,1000,0,1000)", [id(10), id(20), id(2), id(50)]);
        await db.query("update jobs set current_quote_id=null where id=$1", [id(50)]);
      }
      await db.query("update repair_tasks set status='PENDING' where id=$1", [id(90)]);
      await db.query("update repair_tasks set status='IN_PROGRESS' where id=$1", [id(90)]);
      await db.query("update repair_tasks set status='COMPLETED' where id=$1", [id(90)]);
      await transition("READY");
      await db.query("update repair_tasks set note='Final inspection recorded' where id=$1", [id(90)]);
      expect(await scalar("select note from repair_tasks where id=$1", [id(90)])).toBe("Final inspection recorded");
      expect(await scalar("select status from repair_tasks where id=$1", [id(90)])).toBe("COMPLETED");
    });

    it("checks every current stage against the three supported targets", async () => {
      await prepareRepair();
      const allowed: Record<string, string[]> = {
        OPEN: ["IN_PROGRESS"], DIAGNOSING: ["IN_PROGRESS"], AWAITING_APPROVAL: [],
        APPROVED: ["IN_PROGRESS"], IN_PROGRESS: ["READY"], QUALITY_CHECK: ["IN_PROGRESS", "READY"],
        READY: ["COMPLETED"], COMPLETED: [], CANCELLED: [],
      };
      for (const [current, targets] of Object.entries(allowed)) {
        for (const target of ["IN_PROGRESS", "READY", "COMPLETED"]) {
          await db.exec("savepoint stage_case");
          await db.query("update jobs set status=$1 where id=$2", [current, id(50)]);
          if (current === target || targets.includes(target)) {
            await transition(target);
            expect(await scalar("select status from jobs where id=$1", [id(50)])).toBe(target);
          } else {
            await fails("select transition_repair_job($1,$2,$3)", [id(1), id(50), target],
              ["COMPLETED", "CANCELLED"].includes(current) ? "JOB_CLOSED" : "INVALID_STAGE_TRANSITION");
          }
          await db.exec("rollback to savepoint stage_case; release savepoint stage_case");
        }
      }
    });

    it("requires completed steps and current approval, preserving legacy invoice handover", async () => {
      await approve(await quote());
      await db.query("update jobs set status='IN_PROGRESS' where id=$1", [id(50)]);
      await fails("select transition_repair_job($1,$2,'READY')", [id(1), id(50)], "TASKS_INCOMPLETE");
      await db.query("insert into repair_tasks(id,job_id,title) values($1,$2,'Repair')", [id(90), id(50)]);
      await fails("select transition_repair_job($1,$2,'READY')", [id(1), id(50)], "TASKS_INCOMPLETE");
      await db.query("update repair_tasks set status='COMPLETED' where id=$1", [id(90)]);
      await db.query("update repair_quotes set status='DECLINED' where job_id=$1", [id(50)]);
      await fails("select transition_repair_job($1,$2,'READY')", [id(1), id(50)], "APPROVAL_REQUIRED");
      await db.query("update jobs set current_quote_id=null where id=$1", [id(50)]);
      await db.query(
        "insert into invoices(number,franchise_id,shop_id,customer_id,job_id,subtotal,tax_amount,total_amount) values('STATUS-LEGACY',$1,$2,$3,$4,1000,0,1000)",
        [id(10), id(20), id(2), id(50)],
      );
      await transition("READY");
      await transition("COMPLETED");
      expect(await notices()).toBe(2);
    });

    it.each([id(2), id(4), id(6)])("denies customer, nonmember and accountant actors (%s)", async (actor) => {
      await prepareRepair();
      await fails("select transition_repair_job($1,$2,'READY')", [actor, id(50)], "FORBIDDEN");
      expect(await notices()).toBe(0);
    });

    it.each(["branch", "assignment", "membership", "profile", "SUSPENDED", "CANCELLED"])("preserves the %s access check, including retries", async (restriction) => {
      await prepareRepair();
      await transition("READY");
      if (restriction === "branch") {
        await db.query("insert into shops(id,franchise_id,name,slug,email,address,county) values($1,$2,'Other','other','other@example.com','Street','Nairobi')", [id(21), id(10)]);
        await db.query("update memberships set shop_id=$1 where id=$2", [id(21), id(71)]);
      }
      if (restriction === "assignment") await db.query("update jobs set assigned_mechanic_id=null where id=$1", [id(50)]);
      if (restriction === "membership") await db.query("update memberships set is_active=false where id=$1", [id(71)]);
      if (restriction === "profile") await db.query("update profiles set is_active=false where id=$1", [id(3)]);
      if (["SUSPENDED", "CANCELLED"].includes(restriction)) await db.query("update franchises set status=$1 where id=$2", [restriction, id(10)]);
      for (const status of ["READY", "COMPLETED"]) {
        await fails("select transition_repair_job($1,$2,$3)", [id(3), id(50), status], "FORBIDDEN");
      }
      expect(await notices()).toBe(1);
    });

    it("rejects unsupported targets and missing jobs and remains server-only", async () => {
      for (const status of ["CANCELLED", "QUALITY_CHECK", null]) {
        await fails("select transition_repair_job($1,$2,$3)", [id(1), id(50), status], "INVALID_STAGE_TRANSITION");
      }
      await fails("select transition_repair_job($1,$2,'READY')", [id(1), id(999)], "NOT_FOUND");
      for (const role of ["anon", "authenticated"]) {
        expect(await scalar("select has_function_privilege($1,'public.transition_repair_job(uuid,uuid,text)','execute')", [role])).toBe(false);
      }
      expect(await scalar("select has_function_privilege('service_role','public.transition_repair_job(uuid,uuid,text)','execute')")).toBe(true);
    });
  });
  it("preserves handover for legacy invoices without retroactive approval", async () => {
    await db.query(
      "insert into invoices(number,franchise_id,shop_id,customer_id,job_id,subtotal,tax_amount,total_amount) values('LEGACY',$1,$2,$3,$4,1000,0,1000)",
      [id(10), id(20), id(2), id(50)],
    );
    await db.query("update jobs set status='READY' where id=$1", [id(50)]);
    expect(await scalar("select status from jobs where id=$1", [id(50)])).toBe(
      "READY",
    );
  });
  it("releases a failed Paystack reservation for another provider without crediting the invoice", async () => {
    await db.query(
      "insert into invoices(id,number,franchise_id,shop_id,customer_id,status,subtotal,tax_amount,total_amount) values($1,'PAYSTACK-FAILURE',$2,$3,$4,'ISSUED',1000,0,1000)",
      [id(900), id(10), id(20), id(2)],
    );
    const reference = `PAY-${"f".repeat(32)}`;
    await db.query(
      "insert into payments(id,reference,franchise_id,shop_id,customer_id,invoice_id,provider,amount,currency,status) values($1,$2,$3,$4,$5,$6,'PAYSTACK',1000,'KES','PROCESSING')",
      [id(901), reference, id(10), id(20), id(2), id(900)],
    );
    await fails(
      "select reserve_sandbox_payment($1,$2,'STRIPE')",
      [id(900), id(2)],
      "CHECKOUT_OPEN",
    );
    await db.query("update payments set status='FAILED' where id=$1", [id(901)]);
    expect(
      await scalar("select reserve_sandbox_payment($1,$2,'STRIPE')", [id(900), id(2)]),
    ).toMatchObject({ provider: "STRIPE", status: "PENDING" });
    await fails(
      "select settle_paystack_invoice_payment($1,100000,'KES')",
      [reference],
      "PAYMENT_NOT_PAYABLE",
    );
    expect(
      await scalar("select amount_paid from invoices where id=$1", [id(900)]),
    ).toBe("0.00");
    expect(
      await scalar("select count(*) from notifications where type='PAYMENT_SUCCEEDED'"),
    ).toBe(0);
    await fails(
      "insert into payments(reference,franchise_id,shop_id,customer_id,invoice_id,provider,amount,currency) values('PAY-new',$1,$2,$3,$4,'PAYSTACK',1000,'KES')",
      [id(10), id(20), id(2), id(900)],
      "payments_one_open_online_invoice",
    );
  });
  it("settles Paystack success exactly once and validates the amount and currency", async () => {
    await db.query(
      "insert into invoices(id,number,franchise_id,shop_id,customer_id,status,subtotal,tax_amount,total_amount) values($1,'PAYSTACK-SUCCESS',$2,$3,$4,'ISSUED',1000,0,1000)",
      [id(900), id(10), id(20), id(2)],
    );
    await db.query(
      "insert into payments(id,reference,franchise_id,shop_id,customer_id,invoice_id,provider,amount,currency,status) values($1,'PAY-success',$2,$3,$4,$5,'PAYSTACK',1000,'KES','PROCESSING')",
      [id(901), id(10), id(20), id(2), id(900)],
    );
    for (const [amount, currency] of [[1, "KES"], [100000, "USD"]]) {
      await fails(
        "select settle_paystack_invoice_payment('PAY-success',$1,$2)",
        [amount, currency],
        "PAYMENT_AMOUNT_MISMATCH",
      );
    }
    expect(await scalar("select settle_paystack_invoice_payment('PAY-success',100000,'KES')")).toBe(true);
    expect(await scalar("select settle_paystack_invoice_payment('PAY-success',100000,'KES')")).toBe(false);
    expect(
      await scalar("select amount_paid from invoices where id=$1", [id(900)]),
    ).toBe("1000.00");
    expect(
      await scalar("select count(*) from notifications where data->>'paymentId'=$1", [id(901)]),
    ).toBe(1);
  });
  it.each(["STRIPE", "MPESA"])("reserves one %s checkout and settles verified payments exactly once", async (provider) => {
    await db.query(
      "insert into invoices(id,number,franchise_id,shop_id,customer_id,status,subtotal,tax_amount,total_amount) values($1,'PAY-TEST',$2,$3,$4,'ISSUED',1000,0,1000)",
      [id(900), id(10), id(20), id(2)],
    );
    await fails(
      `select reserve_sandbox_payment($1,$2,'${provider}')`,
      [id(900), id(4)],
      "INVOICE_NOT_PAYABLE",
    );
    const payment = (await scalar(
      `select reserve_sandbox_payment($1,$2,'${provider}')`,
      [id(900), id(2)],
    )) as { id: string; reference: string };
    const retry = (await scalar(
      `select reserve_sandbox_payment($1,$2,'${provider}')`,
      [id(900), id(2)],
    )) as { id: string };
    expect(retry.id).toBe(payment.id);
    await fails(
      `select reserve_sandbox_payment($1,$2,'${provider === "STRIPE" ? "MPESA" : "STRIPE"}')`,
      [id(900), id(2)],
      "CHECKOUT_OPEN",
    );
    await db.query(
      "update payments set provider_reference='cs_test_verified',status='PROCESSING' where id=$1",
      [payment.id],
    );
    const sql =
      `select settle_verified_invoice_payment($1,'${provider}',$2,$3,$4,$5)`;
    for (const args of [
      [payment.reference, "wrong", 100000, "KES", true],
      [payment.reference, "cs_test_verified", 1, "KES", true],
      [payment.reference, "cs_test_verified", 100000, "USD", true],
      [payment.reference, "cs_test_verified", 100000, "KES", false],
    ])
      await fails(sql, args, "PAYMENT_MISMATCH");
    const args = [payment.reference, "cs_test_verified", 100000, "KES", true];
    expect(await scalar(sql, args)).toBe(true);
    expect(await scalar(sql, args)).toBe(false);
    expect(
      await scalar("select amount_paid from invoices where id=$1", [id(900)]),
    ).toBe("1000.00");
    expect(
      await scalar(
        "select count(*)::int from notifications where data->>'paymentId'=$1",
        [payment.id],
      ),
    ).toBe(1);
    expect(
      await scalar(
        "select has_function_privilege('authenticated','public.settle_verified_invoice_payment(text,text,text,bigint,text,boolean)','execute')",
      ),
    ).toBe(false);
  });
});
