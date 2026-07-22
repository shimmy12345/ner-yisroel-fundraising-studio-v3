-- Ner Yisroel Fundraising Studio V2
-- Paste this entire file into Supabase > SQL Editor > New query, then click Run.

create extension if not exists pgcrypto;

create table if not exists public.knowledge_documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  content text not null default '',
  source_type text not null default 'manual' check (source_type in ('manual','google_drive','upload')),
  source_id text,
  source_url text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.donors (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  email text,
  phone text,
  city text,
  relationship_type text,
  lifetime_giving numeric,
  last_gift_amount numeric,
  last_gift_date date,
  interests text,
  notes text,
  next_action text,
  next_action_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.generations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  mode text not null,
  title text,
  prompt text,
  source_text text,
  output text not null,
  favorite boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.google_connections (
  user_id uuid primary key references auth.users(id) on delete cascade,
  access_token text,
  refresh_token text,
  token_type text,
  scope text,
  expires_at timestamptz,
  connected_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.oauth_states (
  state text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists knowledge_documents_user_id_idx on public.knowledge_documents(user_id);
create unique index if not exists knowledge_documents_user_source_idx on public.knowledge_documents(user_id, source_id);
create index if not exists donors_user_id_idx on public.donors(user_id);
create index if not exists generations_user_id_idx on public.generations(user_id);
create index if not exists generations_created_at_idx on public.generations(created_at desc);

alter table public.knowledge_documents enable row level security;
alter table public.donors enable row level security;
alter table public.generations enable row level security;
alter table public.google_connections enable row level security;
alter table public.oauth_states enable row level security;

-- Client-accessible tables. Each user can only access their own rows.
drop policy if exists "knowledge own rows" on public.knowledge_documents;
create policy "knowledge own rows" on public.knowledge_documents
for all to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "donors own rows" on public.donors;
create policy "donors own rows" on public.donors
for all to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "generations own rows" on public.generations;
create policy "generations own rows" on public.generations
for all to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

-- Google tokens and OAuth state are server-only. No browser policies are created.
revoke all on public.google_connections from anon, authenticated;
revoke all on public.oauth_states from anon, authenticated;
grant all on public.google_connections to service_role;
grant all on public.oauth_states to service_role;

grant select, insert, update, delete on public.knowledge_documents to authenticated;
grant select, insert, update, delete on public.donors to authenticated;
grant select, insert, update, delete on public.generations to authenticated;

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists knowledge_documents_updated_at on public.knowledge_documents;
create trigger knowledge_documents_updated_at before update on public.knowledge_documents
for each row execute function public.set_updated_at();

drop trigger if exists donors_updated_at on public.donors;
create trigger donors_updated_at before update on public.donors
for each row execute function public.set_updated_at();

drop trigger if exists google_connections_updated_at on public.google_connections;
create trigger google_connections_updated_at before update on public.google_connections
for each row execute function public.set_updated_at();
-- Knowledge Base direct-upload migration
-- Run this once in Supabase > SQL Editor after the original schema.sql.

alter table public.knowledge_documents
  add column if not exists file_name text,
  add column if not exists mime_type text,
  add column if not exists file_size bigint,
  add column if not exists storage_path text,
  add column if not exists checksum text,
  add column if not exists tags text[] not null default '{}'::text[],
  add column if not exists favorite boolean not null default false,
  add column if not exists extraction_status text not null default 'ready';

create unique index if not exists knowledge_documents_user_checksum_idx
  on public.knowledge_documents(user_id, checksum)
  where checksum is not null;

insert into storage.buckets (id, name, public, file_size_limit)
values ('knowledge-files', 'knowledge-files', false, 26214400)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit;

drop policy if exists "knowledge files insert own folder" on storage.objects;
create policy "knowledge files insert own folder"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'knowledge-files'
  and split_part(name, '/', 1) = (select auth.uid())::text
);

drop policy if exists "knowledge files select own folder" on storage.objects;
create policy "knowledge files select own folder"
on storage.objects for select to authenticated
using (
  bucket_id = 'knowledge-files'
  and split_part(name, '/', 1) = (select auth.uid())::text
);

drop policy if exists "knowledge files delete own folder" on storage.objects;
create policy "knowledge files delete own folder"
on storage.objects for delete to authenticated
using (
  bucket_id = 'knowledge-files'
  and split_part(name, '/', 1) = (select auth.uid())::text
);
