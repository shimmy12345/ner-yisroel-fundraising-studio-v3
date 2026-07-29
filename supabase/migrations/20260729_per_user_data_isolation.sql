begin;

alter table public.crm_donors
  add column if not exists owner_user_id uuid;

alter table public.donor_activities
  add column if not exists owner_user_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.crm_donors'::regclass
      and conname = 'crm_donors_owner_user_id_fkey'
  ) then
    alter table public.crm_donors
      add constraint crm_donors_owner_user_id_fkey
      foreign key (owner_user_id) references auth.users(id) on delete restrict;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.donor_activities'::regclass
      and conname = 'donor_activities_owner_user_id_fkey'
  ) then
    alter table public.donor_activities
      add constraint donor_activities_owner_user_id_fkey
      foreign key (owner_user_id) references auth.users(id) on delete restrict;
  end if;
end;
$$;

-- REQUIRED OPERATOR ACTION:
-- Replace the production owner placeholder below with the UUID copied from
-- Supabase Authentication > Users. It is the only placeholder occurrence in
-- this file. The guard deliberately aborts the transaction while it remains.
do $$
declare
  production_owner_text constant text := 'YOUR_EXISTING_AUTH_USER_UUID';
  production_owner uuid;
begin
  if production_owner_text = ('YOUR_EXISTING_AUTH_USER_' || 'UUID') then
    raise exception
      'Replace the production owner placeholder with the existing Auth user UUID before running this migration.';
  end if;

  begin
    production_owner := production_owner_text::uuid;
  exception
    when invalid_text_representation then
      raise exception 'The production owner value must be a valid Auth user UUID.';
  end;

  if not exists (select 1 from auth.users where id = production_owner) then
    raise exception 'The selected production owner UUID does not exist in auth.users.';
  end if;

  -- Preserve existing updated_at and last_contact_date values during ownership
  -- backfill. Constraint triggers remain enabled.
  alter table public.crm_donors disable trigger user;
  alter table public.donor_activities disable trigger user;

  update public.crm_donors
  set owner_user_id = production_owner
  where owner_user_id is null;

  update public.donor_activities as activity
  set owner_user_id = donor.owner_user_id
  from public.crm_donors as donor
  where activity.donor_id = donor.id
    and activity.owner_user_id is null;

  if exists (
    select 1
    from public.crm_donors
    where owner_user_id is null
  ) then
    raise exception 'Ownership backfill failed: one or more donors have no owner.';
  end if;

  if exists (
    select 1
    from public.donor_activities
    where owner_user_id is null
  ) then
    raise exception 'Ownership backfill failed: one or more activities have no owner.';
  end if;

  if exists (
    select 1
    from public.donor_activities as activity
    join public.crm_donors as donor on donor.id = activity.donor_id
    where activity.owner_user_id <> donor.owner_user_id
  ) then
    raise exception 'Ownership backfill failed: an activity owner differs from its donor owner.';
  end if;

  alter table public.donor_activities enable trigger user;
  alter table public.crm_donors enable trigger user;
end;
$$;

alter table public.crm_donors
  alter column owner_user_id set default auth.uid(),
  alter column owner_user_id set not null;

alter table public.donor_activities
  alter column owner_user_id set default auth.uid(),
  alter column owner_user_id set not null;

create index if not exists crm_donors_owner_user_id_idx
  on public.crm_donors (owner_user_id);
create index if not exists crm_donors_owner_archive_idx
  on public.crm_donors (owner_user_id, is_archived);
create index if not exists donor_activities_owner_user_id_idx
  on public.donor_activities (owner_user_id);
create index if not exists donor_activities_owner_donor_occurred_idx
  on public.donor_activities (owner_user_id, donor_id, occurred_at desc);

-- Replace a global donor_code uniqueness rule with per-owner uniqueness.
-- This lets two isolated users use the same external donor code.
do $$
declare
  constraint_record record;
  index_record record;
begin
  for constraint_record in
    select constraint_name.conname
    from pg_constraint as constraint_name
    where constraint_name.conrelid = 'public.crm_donors'::regclass
      and constraint_name.contype = 'u'
      and array_length(constraint_name.conkey, 1) = 1
      and constraint_name.conkey[1] = (
        select donor_code_column.attnum
        from pg_attribute as donor_code_column
        where donor_code_column.attrelid = 'public.crm_donors'::regclass
          and donor_code_column.attname = 'donor_code'
      )
  loop
    execute format(
      'alter table public.crm_donors drop constraint %I',
      constraint_record.conname
    );
  end loop;

  for index_record in
    select index_namespace.nspname as schema_name, index_name.relname as index_name
    from pg_index as index_definition
    join pg_class as index_name on index_name.oid = index_definition.indexrelid
    join pg_namespace as index_namespace on index_namespace.oid = index_name.relnamespace
    where index_definition.indrelid = 'public.crm_donors'::regclass
      and index_definition.indisunique
      and not index_definition.indisprimary
      and index_definition.indnkeyatts = 1
      and (
        select column_name.attname
        from pg_attribute as column_name
        where column_name.attrelid = index_definition.indrelid
          and column_name.attnum = index_definition.indkey[0]
      ) = 'donor_code'
      and not exists (
        select 1
        from pg_constraint as linked_constraint
        where linked_constraint.conindid = index_definition.indexrelid
      )
  loop
    execute format(
      'drop index %I.%I',
      index_record.schema_name,
      index_record.index_name
    );
  end loop;
end;
$$;

create unique index if not exists crm_donors_owner_donor_code_key
  on public.crm_donors (owner_user_id, donor_code);

create or replace function public.enforce_crm_donor_owner()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  request_user uuid := auth.uid();
begin
  if tg_op = 'INSERT' then
    if request_user is not null then
      new.owner_user_id := request_user;
    elsif new.owner_user_id is null then
      raise exception 'A donor owner is required.';
    end if;
  elsif new.owner_user_id is distinct from old.owner_user_id then
    raise exception 'Donor ownership cannot be changed.';
  end if;

  return new;
end;
$$;

drop trigger if exists crm_donors_owner_enforcement on public.crm_donors;
create trigger crm_donors_owner_enforcement
before insert or update on public.crm_donors
for each row execute function public.enforce_crm_donor_owner();

create or replace function public.enforce_donor_activity_owner()
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
      raise exception 'An activity owner is required.';
    end if;
  elsif new.owner_user_id is distinct from old.owner_user_id then
    raise exception 'Activity ownership cannot be changed.';
  end if;

  select donor.owner_user_id
  into donor_owner
  from public.crm_donors as donor
  where donor.id = new.donor_id;

  if donor_owner is null or donor_owner <> new.owner_user_id then
    raise exception 'The donor is unavailable for this activity.';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_crm_donor_owner() from public, anon, authenticated;
revoke all on function public.enforce_donor_activity_owner() from public, anon, authenticated;

drop trigger if exists donor_activities_owner_enforcement on public.donor_activities;
create trigger donor_activities_owner_enforcement
before insert or update on public.donor_activities
for each row execute function public.enforce_donor_activity_owner();

alter table public.crm_donors enable row level security;
alter table public.donor_activities enable row level security;

-- Remove only the repository-known legacy policies and the owner policies
-- created by this migration (for safe reruns). Do not delete unknown policies.
drop policy if exists "donor activities select visible donors"
  on public.donor_activities;
drop policy if exists "donor activities insert visible donors"
  on public.donor_activities;
drop policy if exists "donor activities update visible donors"
  on public.donor_activities;

drop policy if exists "Authenticated users can view CRM donors"
  on public.crm_donors;
drop policy if exists "Authenticated users can insert CRM donors"
  on public.crm_donors;
drop policy if exists "Authenticated users can update CRM donors"
  on public.crm_donors;

drop policy if exists "crm donors select own"
  on public.crm_donors;
drop policy if exists "crm donors insert own"
  on public.crm_donors;
drop policy if exists "crm donors update own"
  on public.crm_donors;
drop policy if exists "donor activities select own donor"
  on public.donor_activities;
drop policy if exists "donor activities insert own donor"
  on public.donor_activities;
drop policy if exists "donor activities update own donor"
  on public.donor_activities;

-- crm_donors was provisioned outside this repository, so an installation may
-- have additional policies with deployment-specific names. Fail closed rather
-- than silently retaining or deleting an unknown policy. Review any name in
-- this error, add a deliberate DROP POLICY IF EXISTS above, and rerun.
do $$
declare
  unexpected_policies text;
begin
  select string_agg(format('%I.%I', tablename, policyname), ', ' order by tablename, policyname)
  into unexpected_policies
  from pg_policies
  where schemaname = 'public'
    and tablename in ('crm_donors', 'donor_activities');

  if unexpected_policies is not null then
    raise exception
      'Unrecognized CRM policies remain: %. Review and explicitly drop each intended legacy policy before rerunning.',
      unexpected_policies;
  end if;
end;
$$;

create policy "crm donors select own"
on public.crm_donors
for select
to authenticated
using (owner_user_id = (select auth.uid()));

create policy "crm donors insert own"
on public.crm_donors
for insert
to authenticated
with check (owner_user_id = (select auth.uid()));

create policy "crm donors update own"
on public.crm_donors
for update
to authenticated
using (owner_user_id = (select auth.uid()))
with check (owner_user_id = (select auth.uid()));

create policy "donor activities select own donor"
on public.donor_activities
for select
to authenticated
using (
  owner_user_id = (select auth.uid())
  and exists (
    select 1
    from public.crm_donors as donor
    where donor.id = donor_activities.donor_id
      and donor.owner_user_id = (select auth.uid())
  )
);

create policy "donor activities insert own donor"
on public.donor_activities
for insert
to authenticated
with check (
  owner_user_id = (select auth.uid())
  and exists (
    select 1
    from public.crm_donors as donor
    where donor.id = donor_activities.donor_id
      and donor.owner_user_id = (select auth.uid())
  )
);

create policy "donor activities update own donor"
on public.donor_activities
for update
to authenticated
using (
  owner_user_id = (select auth.uid())
  and exists (
    select 1
    from public.crm_donors as donor
    where donor.id = donor_activities.donor_id
      and donor.owner_user_id = (select auth.uid())
  )
)
with check (
  owner_user_id = (select auth.uid())
  and exists (
    select 1
    from public.crm_donors as donor
    where donor.id = donor_activities.donor_id
      and donor.owner_user_id = (select auth.uid())
  )
);

grant select, insert, update on public.crm_donors to authenticated;
grant select, insert, update on public.donor_activities to authenticated;
revoke all on public.crm_donors from anon;
revoke all on public.donor_activities from anon;
revoke delete on public.crm_donors from authenticated, public;
revoke delete on public.donor_activities from authenticated, public;

commit;
