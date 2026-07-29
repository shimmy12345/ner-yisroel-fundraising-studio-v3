begin;

alter table public.crm_donors
  add column if not exists is_archived boolean;

update public.crm_donors
set is_archived = false
where is_archived is null;

alter table public.crm_donors
  alter column is_archived set default false,
  alter column is_archived set not null;

commit;
