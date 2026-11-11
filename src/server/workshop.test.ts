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
describe("workshop database workflows", () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(
      "create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$; create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz); create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);",
    );
    const dir = path.resolve("supabase/migrations");
    for (const file of (await readdir(dir))
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      // PGlite includes gen_random_uuid in core but does not bundle pgcrypto.
      const sql = (await readFile(path.join(dir, file), "utf8")).replace(
        "create extension if not exists pgcrypto;",
        "",
      );
      await db.exec(sql);
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
