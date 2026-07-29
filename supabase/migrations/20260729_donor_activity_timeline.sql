begin;

create table public.donor_activities (
  id uuid primary key default gen_random_uuid(),
  donor_id uuid not null references public.crm_donors(id) on delete restrict,
  activity_type text not null,
  occurred_at timestamptz not null default now(),
  subject text not null,
  notes text not null,
  outcome text,
  next_action text,
  next_action_date date,
  is_archived boolean not null default false,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint donor_activities_type_check check (
    activity_type in (
      'phone_call',
      'meeting',
      'email',
      'text_message',
      'letter',
      'event',
      'note',
      'other'
    )
  ),
  constraint donor_activities_subject_not_blank check (length(btrim(subject)) > 0),
  constraint donor_activities_notes_not_blank check (length(btrim(notes)) > 0)
);

create index donor_activities_donor_occurred_idx
  on public.donor_activities (donor_id, occurred_at desc);
create index donor_activities_donor_archive_occurred_idx
  on public.donor_activities (donor_id, is_archived, occurred_at desc);
create index donor_activities_next_action_date_idx
  on public.donor_activities (next_action_date)
  where next_action_date is not null;
create index donor_activities_created_by_idx
  on public.donor_activities (created_by);

create or replace function public.set_donor_activity_audit_fields()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
  else
    new.created_by := old.created_by;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger donor_activities_audit_fields
before insert or update on public.donor_activities
for each row execute function public.set_donor_activity_audit_fields();

create or replace function public.advance_donor_last_contact_from_activity()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  latest_contact_date date;
begin
  if new.activity_type not in (
    'phone_call',
    'meeting',
    'email',
    'text_message',
    'letter',
    'event'
  ) then
    return new;
  end if;

  select max((activity.occurred_at at time zone 'UTC')::date)
  into latest_contact_date
  from public.donor_activities as activity
  where activity.donor_id = new.donor_id
    and activity.is_archived = false
    and activity.activity_type in (
      'phone_call',
      'meeting',
      'email',
      'text_message',
      'letter',
      'event'
    );

  if latest_contact_date is not null then
    update public.crm_donors
    set last_contact_date = latest_contact_date
    where id = new.donor_id
      and (
        last_contact_date is null
        or last_contact_date < latest_contact_date
      );
  end if;

  return new;
end;
$$;

create trigger donor_activities_advance_last_contact
after insert or update of donor_id, activity_type, occurred_at, is_archived
on public.donor_activities
for each row execute function public.advance_donor_last_contact_from_activity();

alter table public.donor_activities enable row level security;

create policy "donor activities select visible donors"
on public.donor_activities
for select
to authenticated
using (
  exists (
    select 1
    from public.crm_donors as donor
    where donor.id = donor_activities.donor_id
  )
);

create policy "donor activities insert visible donors"
on public.donor_activities
for insert
to authenticated
with check (
  exists (
    select 1
    from public.crm_donors as donor
    where donor.id = donor_activities.donor_id
  )
);

create policy "donor activities update visible donors"
on public.donor_activities
for update
to authenticated
using (
  exists (
    select 1
    from public.crm_donors as donor
    where donor.id = donor_activities.donor_id
  )
)
with check (
  exists (
    select 1
    from public.crm_donors as donor
    where donor.id = donor_activities.donor_id
  )
);

grant select, insert, update on public.donor_activities to authenticated;
revoke all on public.donor_activities from anon;
revoke delete on public.donor_activities from authenticated, public;

commit;
