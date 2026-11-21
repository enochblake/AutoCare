create or replace function public.create_booking(
  p_customer_id uuid, p_shop_id uuid, p_vehicle_id uuid, p_service_id uuid, p_scheduled_at timestamptz, p_customer_notes text, p_reference text
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_shop shops%rowtype; v_booking_id uuid; v_count integer; v_local timestamp; v_day text; v_hours jsonb;
begin
  if p_scheduled_at < now() + interval '1 hour' then raise exception 'INVALID_SCHEDULE'; end if;
  -- Keep the shop settings stable while waiting for the capacity lock.
  select s.* into v_shop from shops s join franchises f on f.id=s.franchise_id where s.id=p_shop_id and s.is_active and s.accepts_bookings and f.status in ('TRIAL','ACTIVE')
    for share of s;
  if not found then raise exception 'SHOP_NOT_FOUND'; end if;
  v_local := p_scheduled_at at time zone v_shop.timezone;
  perform pg_advisory_xact_lock(hashtextextended(p_shop_id::text || to_char(v_local, 'YYYY-MM-DD'), 0));
  perform public.assert_tenant_writable(v_shop.franchise_id);
  v_day := (array['sun','mon','tue','wed','thu','fri','sat'])[extract(dow from v_local)::integer + 1];
  v_hours := v_shop.opening_hours -> v_day;
  if v_hours is null or v_hours = 'null'::jsonb or (v_local::time < (v_hours->>'open')::time) or (v_local::time >= (v_hours->>'close')::time) then raise exception 'OUTSIDE_OPENING_HOURS'; end if;
  if not exists(select 1 from vehicles where id=p_vehicle_id and owner_id=p_customer_id) then raise exception 'VEHICLE_NOT_FOUND'; end if;
  if p_service_id is not null and not exists(select 1 from service_catalog where id=p_service_id and franchise_id=v_shop.franchise_id and is_active and (shop_id=p_shop_id or shop_id is null)) then raise exception 'INVALID_SERVICE'; end if;
  select count(*) into v_count from bookings where shop_id=p_shop_id and (scheduled_at at time zone v_shop.timezone)::date=v_local::date and status not in ('CANCELLED','DECLINED');
  if v_count >= v_shop.booking_capacity then raise exception 'CAPACITY_REACHED'; end if;
  insert into bookings(reference,franchise_id,shop_id,customer_id,vehicle_id,service_id,scheduled_at,customer_notes)
  values(p_reference,v_shop.franchise_id,p_shop_id,p_customer_id,p_vehicle_id,p_service_id,p_scheduled_at,p_customer_notes) returning id into v_booking_id;
  insert into notifications(user_id,title,body,type,data) values(p_customer_id,'Booking request sent',v_shop.name || ' will review booking ' || p_reference || '.','BOOKING_CREATED',jsonb_build_object('bookingId',v_booking_id));
  return v_booking_id;
end $$;
