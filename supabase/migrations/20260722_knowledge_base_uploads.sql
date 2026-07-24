-- Idempotent migration for an existing Ner Yisroel Fundraising Studio database.

alter table public.knowledge_documents
  add column if not exists file_name text,
  add column if not exists mime_type text,
  add column if not exists file_size bigint,
  add column if not exists storage_path text,
  add column if not exists checksum text,
  add column if not exists tags text[] not null default '{}'::text[],
  add column if not exists favorite boolean not null default false,
  add column if not exists extraction_status text not null default 'ready';

create index if not exists knowledge_documents_user_updated_idx
  on public.knowledge_documents(user_id, updated_at desc);

create unique index if not exists knowledge_documents_user_checksum_idx
  on public.knowledge_documents(user_id, checksum)
  where checksum is not null;

alter table public.knowledge_documents enable row level security;
drop policy if exists "knowledge own rows" on public.knowledge_documents;
create policy "knowledge own rows" on public.knowledge_documents for all to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);
grant select, insert, update, delete on public.knowledge_documents to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'knowledge-files',
  'knowledge-files',
  false,
  26214400,
  array['text/plain','text/csv','application/csv','application/vnd.ms-excel','application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/octet-stream']
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "knowledge files insert own folder" on storage.objects;
create policy "knowledge files insert own folder" on storage.objects for insert to authenticated
with check (bucket_id = 'knowledge-files' and split_part(name, '/', 1) = (select auth.uid())::text);

drop policy if exists "knowledge files select own folder" on storage.objects;
create policy "knowledge files select own folder" on storage.objects for select to authenticated
using (bucket_id = 'knowledge-files' and split_part(name, '/', 1) = (select auth.uid())::text);

drop policy if exists "knowledge files delete own folder" on storage.objects;
create policy "knowledge files delete own folder" on storage.objects for delete to authenticated
using (bucket_id = 'knowledge-files' and split_part(name, '/', 1) = (select auth.uid())::text);
