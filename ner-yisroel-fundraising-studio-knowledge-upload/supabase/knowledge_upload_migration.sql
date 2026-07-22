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
