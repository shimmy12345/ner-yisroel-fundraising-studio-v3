begin;

-- Persistent completion belongs to the follow-up that generated the priority.
alter table public.crm_donors
  add column if not exists next_action_completed_at timestamptz,
  add column if not exists next_action_completed_by uuid references auth.users(id) on delete set null;

alter table public.donor_activities
  add column if not exists next_action_completed_at timestamptz,
  add column if not exists next_action_completed_by uuid references auth.users(id) on delete set null;

create or replace function public.reset_changed_follow_up_completion()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.next_action is distinct from old.next_action
    or new.next_action_date is distinct from old.next_action_date then
    new.next_action_completed_at := null;
    new.next_action_completed_by := null;
  end if;
  return new;
end;
$$;

drop trigger if exists crm_donors_reset_follow_up_completion on public.crm_donors;
create trigger crm_donors_reset_follow_up_completion
before update of next_action, next_action_date on public.crm_donors
for each row execute function public.reset_changed_follow_up_completion();

create or replace function public.reset_changed_activity_priority_completion()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.next_action is distinct from old.next_action
    or new.next_action_date is distinct from old.next_action_date
    or new.activity_type is distinct from old.activity_type
    or new.occurred_at is distinct from old.occurred_at
    or new.subject is distinct from old.subject then
    new.next_action_completed_at := null;
    new.next_action_completed_by := null;
  end if;
  return new;
end;
$$;

drop trigger if exists donor_activities_reset_follow_up_completion on public.donor_activities;
create trigger donor_activities_reset_follow_up_completion
before update of next_action, next_action_date, activity_type, occurred_at, subject on public.donor_activities
for each row execute function public.reset_changed_activity_priority_completion();

revoke all on function public.reset_changed_follow_up_completion() from public, anon, authenticated;
revoke all on function public.reset_changed_activity_priority_completion() from public, anon, authenticated;

create index if not exists crm_donors_owner_open_action_idx
  on public.crm_donors (owner_user_id, next_action_date)
  where is_archived = false
    and next_action is not null
    and next_action_completed_at is null;

create index if not exists donor_activities_owner_open_action_idx
  on public.donor_activities (owner_user_id, next_action_date)
  where is_archived = false
    and next_action is not null
    and next_action_completed_at is null;

create index if not exists donor_activities_owner_completed_action_idx
  on public.donor_activities (owner_user_id, next_action_completed_at desc)
  where next_action_completed_at is not null;

-- Gift ledger. Rows are soft deleted so financial history remains auditable.
create table if not exists public.donor_gifts (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null default auth.uid() references auth.users(id) on delete restrict,
  donor_id uuid not null references public.crm_donors(id) on delete restrict,
  gift_date date not null,
  amount numeric(14,2) not null check (amount > 0),
  campaign text,
  designation text,
  gift_type text not null default 'direct_gift' check (
    gift_type in (
      'direct_gift',
      'daf',
      'foundation',
      'stock',
      'matching_gift',
      'pledge_payment',
      'other'
    )
  ),
  payment_method text,
  solicitor text,
  shared_credit_amount numeric(14,2) check (shared_credit_amount is null or shared_credit_amount >= 0),
  shared_credit_information text,
  reference_number text,
  is_anonymous boolean not null default false,
  tribute_information text,
  notes text,
  receipt_status text not null default 'not_required' check (
    receipt_status in ('not_required', 'pending', 'sent')
  ),
  thank_you_status text not null default 'pending' check (
    thank_you_status in ('pending', 'sent', 'not_required')
  ),
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  is_deleted boolean not null default false,
  deleted_at timestamptz,
  deleted_by uuid references auth.users(id) on delete set null
);

create index if not exists donor_gifts_owner_date_idx
  on public.donor_gifts (owner_user_id, gift_date desc, id)
  where is_deleted = false;
create index if not exists donor_gifts_owner_donor_date_idx
  on public.donor_gifts (owner_user_id, donor_id, gift_date desc, id)
  where is_deleted = false;
create index if not exists donor_gifts_owner_campaign_idx
  on public.donor_gifts (owner_user_id, campaign)
  where is_deleted = false and campaign is not null;

create or replace function public.enforce_donor_gift_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  request_user uuid := auth.uid();
  donor_owner uuid;
begin
  if tg_op = 'INSERT' then
    if request_user is not null then
      new.owner_user_id := request_user;
    elsif new.owner_user_id is null then
      raise exception 'A gift owner is required.';
    end if;
    new.created_by := coalesce(request_user, new.created_by);
  elsif new.owner_user_id is distinct from old.owner_user_id
    or new.donor_id is distinct from old.donor_id then
    raise exception 'Gift ownership and donor cannot be changed.';
  end if;

  select donor.owner_user_id
  into donor_owner
  from public.crm_donors as donor
  where donor.id = new.donor_id;

  if donor_owner is null or donor_owner <> new.owner_user_id then
    raise exception 'The donor is unavailable for this gift.';
  end if;

  new.updated_by := coalesce(request_user, new.updated_by);
  new.updated_at := now();
  if new.is_deleted and (tg_op = 'INSERT' or not old.is_deleted) then
    new.deleted_at := now();
    new.deleted_by := coalesce(request_user, new.deleted_by);
  elsif not new.is_deleted then
    new.deleted_at := null;
    new.deleted_by := null;
  end if;
  return new;
end;
$$;

drop trigger if exists donor_gifts_owner_audit on public.donor_gifts;
create trigger donor_gifts_owner_audit
before insert or update on public.donor_gifts
for each row execute function public.enforce_donor_gift_owner();

create or replace function public.recalculate_crm_donor_giving(target_donor_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  totals record;
begin
  select
    coalesce(sum(gift.amount), 0) as lifetime_giving,
    (array_agg(gift.amount order by gift.gift_date desc, gift.created_at desc))[1] as last_gift_amount,
    max(gift.gift_date) as last_gift_date
  into totals
  from public.donor_gifts as gift
  where gift.donor_id = target_donor_id
    and gift.is_deleted = false;

  update public.crm_donors
  set
    lifetime_giving = totals.lifetime_giving,
    last_gift_amount = totals.last_gift_amount,
    last_gift_date = totals.last_gift_date
  where id = target_donor_id;
end;
$$;

create or replace function public.recalculate_crm_donor_giving_from_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.recalculate_crm_donor_giving(coalesce(new.donor_id, old.donor_id));
  return coalesce(new, old);
end;
$$;

drop trigger if exists donor_gifts_recalculate_donor on public.donor_gifts;
create trigger donor_gifts_recalculate_donor
after insert or update of amount, gift_date, is_deleted on public.donor_gifts
for each row execute function public.recalculate_crm_donor_giving_from_trigger();

create or replace function public.log_donor_gift_activity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  action_subject text;
begin
  if tg_op = 'INSERT' then
    action_subject := 'Gift recorded';
  elsif new.is_deleted and not old.is_deleted then
    action_subject := 'Gift deleted';
  elsif new.amount is distinct from old.amount
    or new.gift_date is distinct from old.gift_date
    or new.campaign is distinct from old.campaign
    or new.designation is distinct from old.designation
    or new.gift_type is distinct from old.gift_type
    or new.receipt_status is distinct from old.receipt_status
    or new.thank_you_status is distinct from old.thank_you_status then
    action_subject := 'Gift updated';
  else
    return new;
  end if;

  insert into public.donor_activities (
    donor_id,
    owner_user_id,
    activity_type,
    occurred_at,
    subject,
    notes,
    created_by
  )
  values (
    new.donor_id,
    new.owner_user_id,
    'note',
    now(),
    action_subject,
    format('%s: %s on %s.', action_subject, new.amount, new.gift_date),
    auth.uid()
  );
  return new;
end;
$$;

drop trigger if exists donor_gifts_activity_log on public.donor_gifts;
create trigger donor_gifts_activity_log
after insert or update on public.donor_gifts
for each row execute function public.log_donor_gift_activity();

alter table public.donor_gifts enable row level security;

drop policy if exists "donor gifts select own" on public.donor_gifts;
create policy "donor gifts select own"
on public.donor_gifts for select to authenticated
using (
  owner_user_id = (select auth.uid())
  and exists (
    select 1 from public.crm_donors as donor
    where donor.id = donor_gifts.donor_id
      and donor.owner_user_id = (select auth.uid())
  )
);

drop policy if exists "donor gifts insert own" on public.donor_gifts;
create policy "donor gifts insert own"
on public.donor_gifts for insert to authenticated
with check (
  owner_user_id = (select auth.uid())
  and exists (
    select 1 from public.crm_donors as donor
    where donor.id = donor_gifts.donor_id
      and donor.owner_user_id = (select auth.uid())
  )
);

drop policy if exists "donor gifts update own" on public.donor_gifts;
create policy "donor gifts update own"
on public.donor_gifts for update to authenticated
using (owner_user_id = (select auth.uid()))
with check (owner_user_id = (select auth.uid()));

grant select, insert, update on public.donor_gifts to authenticated;
revoke all on public.donor_gifts from anon;
revoke delete on public.donor_gifts from authenticated, public;
revoke all on function public.enforce_donor_gift_owner() from public, anon, authenticated;
revoke all on function public.recalculate_crm_donor_giving_from_trigger() from public, anon, authenticated;
revoke all on function public.recalculate_crm_donor_giving(uuid) from public, anon, authenticated;
revoke all on function public.log_donor_gift_activity() from public, anon, authenticated;

create or replace function public.fundraising_dashboard_totals()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'active_donors', (
      select count(*) from public.crm_donors
      where owner_user_id = auth.uid() and is_archived = false
    ),
    'total_raised_ytd', (
      select coalesce(sum(amount), 0) from public.donor_gifts
      where owner_user_id = auth.uid()
        and is_deleted = false
        and gift_date >= date_trunc('year', current_date)::date
    ),
    'ytd_gift_count', (
      select count(*) from public.donor_gifts
      where owner_user_id = auth.uid()
        and is_deleted = false
        and gift_date >= date_trunc('year', current_date)::date
    ),
    'recent_gifts', (
      select count(*) from public.donor_gifts
      where owner_user_id = auth.uid()
        and is_deleted = false
        and gift_date >= current_date - 90
    ),
    'open_actions', (
      (select count(*) from public.crm_donors
       where owner_user_id = auth.uid()
         and is_archived = false
         and next_action is not null
         and next_action_completed_at is null)
      +
      (select count(*) from public.donor_activities
       where owner_user_id = auth.uid()
         and is_archived = false
         and next_action is not null
         and next_action_completed_at is null)
    ),
    'due_today', (
      (select count(*) from public.crm_donors
       where owner_user_id = auth.uid()
         and is_archived = false
         and next_action_completed_at is null
         and next_action_date = current_date)
      +
      (select count(*) from public.donor_activities
       where owner_user_id = auth.uid()
         and is_archived = false
         and next_action_completed_at is null
         and next_action_date = current_date)
    ),
    'overdue', (
      (select count(*) from public.crm_donors
       where owner_user_id = auth.uid()
         and is_archived = false
         and next_action_completed_at is null
         and next_action_date < current_date)
      +
      (select count(*) from public.donor_activities
       where owner_user_id = auth.uid()
         and is_archived = false
         and next_action_completed_at is null
         and next_action_date < current_date)
    ),
    'stale_relationships', (
      select count(*) from public.crm_donors
      where owner_user_id = auth.uid()
        and is_archived = false
        and last_contact_date < current_date - 90
    ),
    'recently_active', (
      select count(*) from public.crm_donors
      where owner_user_id = auth.uid()
        and is_archived = false
        and last_contact_date between current_date - 30 and current_date
    ),
    'missing_notes', (
      select count(*) from public.crm_donors
      where owner_user_id = auth.uid()
        and is_archived = false
        and nullif(btrim(notes), '') is null
    ),
    'meetings_next_seven_days', (
      select count(*) from public.donor_activities
      where owner_user_id = auth.uid()
        and is_archived = false
        and activity_type = 'meeting'
        and occurred_at >= current_date
        and occurred_at < current_date + interval '7 days'
    )
  );
$$;

grant execute on function public.fundraising_dashboard_totals() to authenticated;
revoke execute on function public.fundraising_dashboard_totals() from anon, public;

create or replace function public.donor_giving_dossier(target_donor_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with authorized_donor as (
    select id
    from public.crm_donors
    where id = target_donor_id
      and owner_user_id = auth.uid()
  ),
  active_gifts as (
    select gift.*
    from public.donor_gifts as gift
    join authorized_donor as donor on donor.id = gift.donor_id
    where gift.owner_user_id = auth.uid()
      and gift.is_deleted = false
  ),
  annual as (
    select
      extract(year from gift_date + interval '6 months')::integer as fiscal_year,
      sum(amount) as amount,
      count(*) as gift_count,
      avg(amount) as average_gift
    from active_gifts
    group by 1
  )
  select jsonb_build_object(
    'lifetime_giving', coalesce((select sum(amount) from active_gifts), 0),
    'current_fiscal_year_giving', coalesce((
      select sum(amount) from active_gifts
      where extract(year from gift_date + interval '6 months')::integer
        = extract(year from current_date + interval '6 months')::integer
    ), 0),
    'previous_fiscal_year_giving', coalesce((
      select sum(amount) from active_gifts
      where extract(year from gift_date + interval '6 months')::integer
        = extract(year from current_date + interval '6 months')::integer - 1
    ), 0),
    'last_gift', (
      select jsonb_build_object('id', id, 'gift_date', gift_date, 'amount', amount)
      from active_gifts order by gift_date desc, created_at desc limit 1
    ),
    'largest_gift', (select max(amount) from active_gifts),
    'average_gift', (select avg(amount) from active_gifts),
    'gift_count', (select count(*) from active_gifts),
    'first_gift_date', (select min(gift_date) from active_gifts),
    'annual_giving', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'fiscalYear', fiscal_year,
          'amount', amount,
          'giftCount', gift_count,
          'averageGift', average_gift
        )
        order by fiscal_year
      )
      from annual
    ), '[]'::jsonb),
    'preferred_campaigns', coalesce((
      select jsonb_agg(campaign order by total desc)
      from (
        select campaign, sum(amount) as total
        from active_gifts
        where nullif(btrim(campaign), '') is not null
        group by campaign
        order by total desc
        limit 3
      ) as campaigns
    ), '[]'::jsonb),
    'typical_giving_months', coalesce((
      select jsonb_agg(month_number order by gift_count desc)
      from (
        select extract(month from gift_date)::integer as month_number, count(*) as gift_count
        from active_gifts
        group by 1
        order by gift_count desc
        limit 3
      ) as months
    ), '[]'::jsonb)
  );
$$;

grant execute on function public.donor_giving_dossier(uuid) to authenticated;
revoke execute on function public.donor_giving_dossier(uuid) from anon, public;

-- Private media library metadata.
create table if not exists public.media_assets (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null default auth.uid() references auth.users(id) on delete restrict,
  original_filename text not null,
  media_kind text not null check (media_kind in ('document', 'image', 'video')),
  mime_type text not null,
  file_size bigint not null check (file_size > 0),
  storage_path text not null,
  title text,
  description text,
  tags text[] not null default '{}'::text[],
  related_donor_id uuid references public.crm_donors(id) on delete set null,
  related_campaign text,
  related_activity_id uuid references public.donor_activities(id) on delete set null,
  processing_status text not null default 'uploaded' check (
    processing_status in ('uploaded', 'processing', 'ready', 'failed')
  ),
  processing_error text,
  uploaded_by uuid references auth.users(id) on delete set null,
  uploaded_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  is_deleted boolean not null default false,
  deleted_at timestamptz,
  deleted_by uuid references auth.users(id) on delete set null,
  constraint media_assets_storage_path_key unique (storage_path)
);

create index if not exists media_assets_owner_uploaded_idx
  on public.media_assets (owner_user_id, uploaded_at desc, id)
  where is_deleted = false;
create index if not exists media_assets_owner_kind_idx
  on public.media_assets (owner_user_id, media_kind, uploaded_at desc)
  where is_deleted = false;
create index if not exists media_assets_owner_donor_idx
  on public.media_assets (owner_user_id, related_donor_id)
  where is_deleted = false and related_donor_id is not null;

create or replace function public.enforce_media_asset_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  request_user uuid := auth.uid();
  related_owner uuid;
begin
  if tg_op = 'INSERT' then
    if request_user is not null then
      new.owner_user_id := request_user;
    elsif new.owner_user_id is null then
      raise exception 'A media owner is required.';
    end if;
    new.uploaded_by := coalesce(request_user, new.uploaded_by);
  elsif new.owner_user_id is distinct from old.owner_user_id
    or new.storage_path is distinct from old.storage_path then
    raise exception 'Media ownership and storage path cannot be changed.';
  end if;

  if new.related_donor_id is not null then
    select donor.owner_user_id into related_owner
    from public.crm_donors as donor
    where donor.id = new.related_donor_id;
    if related_owner is null or related_owner <> new.owner_user_id then
      raise exception 'The related donor is unavailable.';
    end if;
  end if;

  if new.related_activity_id is not null and not exists (
    select 1 from public.donor_activities as activity
    where activity.id = new.related_activity_id
      and activity.owner_user_id = new.owner_user_id
  ) then
    raise exception 'The related activity is unavailable.';
  end if;

  new.updated_at := now();
  if new.is_deleted and (tg_op = 'INSERT' or not old.is_deleted) then
    new.deleted_at := now();
    new.deleted_by := coalesce(request_user, new.deleted_by);
  elsif not new.is_deleted then
    new.deleted_at := null;
    new.deleted_by := null;
  end if;
  return new;
end;
$$;

drop trigger if exists media_assets_owner_audit on public.media_assets;
create trigger media_assets_owner_audit
before insert or update on public.media_assets
for each row execute function public.enforce_media_asset_owner();

alter table public.media_assets enable row level security;
drop policy if exists "media assets select own" on public.media_assets;
create policy "media assets select own" on public.media_assets
for select to authenticated using (owner_user_id = (select auth.uid()));
drop policy if exists "media assets insert own" on public.media_assets;
create policy "media assets insert own" on public.media_assets
for insert to authenticated with check (owner_user_id = (select auth.uid()));
drop policy if exists "media assets update own" on public.media_assets;
create policy "media assets update own" on public.media_assets
for update to authenticated
using (owner_user_id = (select auth.uid()))
with check (owner_user_id = (select auth.uid()));

grant select, insert, update on public.media_assets to authenticated;
revoke all on public.media_assets from anon;
revoke delete on public.media_assets from authenticated, public;
revoke all on function public.enforce_media_asset_owner() from public, anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'media-assets',
  'media-assets',
  false,
  104857600,
  array[
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain',
    'text/csv',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'image/jpeg',
    'image/png',
    'image/heic',
    'image/heif',
    'image/webp',
    'video/mp4',
    'video/quicktime',
    'video/x-m4v',
    'video/webm'
  ]
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "media assets insert own folder" on storage.objects;
create policy "media assets insert own folder" on storage.objects
for insert to authenticated
with check (
  bucket_id = 'media-assets'
  and split_part(name, '/', 1) = (select auth.uid())::text
);

drop policy if exists "media assets select own folder" on storage.objects;
create policy "media assets select own folder" on storage.objects
for select to authenticated
using (
  bucket_id = 'media-assets'
  and split_part(name, '/', 1) = (select auth.uid())::text
);

drop policy if exists "media assets delete own folder" on storage.objects;
create policy "media assets delete own folder" on storage.objects
for delete to authenticated
using (
  bucket_id = 'media-assets'
  and split_part(name, '/', 1) = (select auth.uid())::text
);

commit;
