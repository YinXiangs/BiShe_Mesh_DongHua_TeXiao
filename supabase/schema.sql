-- 栖息邮局：run in the SQL Editor of a NEW Supabase project as postgres.
-- Re-running recreates this application's policies/functions; it does not delete data.
begin;
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated, service_role;

create table if not exists public.review_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'reviewer'))
);
create table if not exists public.assets (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(btrim(title)) between 1 and 120),
  category text not null check (category in ('scene', 'character', 'product', 'animation', 'vfx')),
  description text not null default '' check (char_length(description) <= 10000),
  status text not null default 'pending' check (status in ('pending', 'review', 'changes', 'approved')),
  created_at timestamptz not null default now()
);
create table if not exists public.versions (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.assets(id) on delete cascade,
  number integer not null check (number > 0),
  filename text not null check (char_length(filename) between 1 and 255),
  storage_path text not null,
  files jsonb not null default '[]'::jsonb,
  stats jsonb not null default '{}'::jsonb check (jsonb_typeof(stats) = 'object' and octet_length(stats::text) <= 262144),
  created_at timestamptz not null default now(),
  unique(asset_id, number),
  unique(id, asset_id)
);
create table if not exists public.review_links (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid references public.assets(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  comment_window timestamptz not null default now(),
  comment_count integer not null default 0,
  read_window timestamptz not null default now(),
  read_count integer not null default 0,
  check (expires_at > created_at and expires_at <= created_at + interval '91 days')
);
create table if not exists public.comments (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.assets(id) on delete cascade,
  version_id uuid,
  author_id uuid references auth.users(id) on delete restrict,
  guest_link_id uuid references public.review_links(id) on delete restrict,
  author_name text not null check (char_length(btrim(author_name)) between 1 and 80),
  body text not null check (char_length(btrim(body)) between 1 and 5000),
  dimension text not null default 'general' check (dimension in ('general', 'topology', 'material', 'structure', 'normals', 'animation', 'vfx')),
  verdict text not null default 'note' check (verdict in ('note', 'changes', 'approved')),
  context jsonb not null default '{}'::jsonb check (jsonb_typeof(context) = 'object' and octet_length(context::text) <= 16384),
  created_at timestamptz not null default now(),
  foreign key (version_id, asset_id) references public.versions(id, asset_id) on delete restrict,
  check ((author_id is not null and guest_link_id is null) or (author_id is null and guest_link_id is not null))
);
create index if not exists versions_asset_index on public.versions(asset_id, number desc);
create index if not exists comments_asset_index on public.comments(asset_id, created_at);
create index if not exists comments_version_index on public.comments(version_id);
create index if not exists review_links_asset_index on public.review_links(asset_id);

-- Avoid membership-policy recursion. Not an exposed Data API schema.
create or replace function private.review_role() returns text
language sql stable security definer set search_path = '' as $$
  select role from public.review_members where user_id = (select auth.uid());
$$;
revoke all on function private.review_role() from public, anon, authenticated;
grant execute on function private.review_role() to authenticated;

-- File metadata is owner-supplied but paths must stay inside this exact version.
create or replace function private.valid_version_files(p_files jsonb, p_asset uuid, p_id uuid, p_primary text)
returns boolean language plpgsql immutable set search_path = '' as $$
declare item jsonb; prefix text := p_asset::text || '/' || p_id::text || '/'; found_primary boolean := false;
begin
  if jsonb_typeof(p_files) is distinct from 'array' or jsonb_array_length(p_files) not between 1 and 100
    or octet_length(p_files::text) > 131072 then return false; end if;
  for item in select value from jsonb_array_elements(p_files) loop
    if jsonb_typeof(item) is distinct from 'object'
      or coalesce(char_length(item->>'name'), 0) not between 1 and 255
      or coalesce(char_length(item->>'path'), 0) not between char_length(prefix) + 1 and 500
      or left(item->>'path', char_length(prefix)) is distinct from prefix
      or substring(item->>'path' from char_length(prefix) + 1) ~ '[/\\]'
      or item->>'path' ~ '[[:cntrl:]]'
      then return false; end if;
    if item->>'path' = p_primary then found_primary := true; end if;
  end loop;
  return found_primary;
end;
$$;
revoke all on function private.valid_version_files(jsonb, uuid, uuid, text) from public, anon;
grant execute on function private.valid_version_files(jsonb, uuid, uuid, text) to authenticated, service_role;
alter table public.versions drop constraint if exists valid_files;
alter table public.versions add constraint valid_files check (private.valid_version_files(files, asset_id, id, storage_path));

alter table public.review_members enable row level security;
alter table public.assets enable row level security;
alter table public.versions enable row level security;
alter table public.comments enable row level security;
alter table public.review_links enable row level security;

-- Remove default API table grants. RLS and column grants both apply.
revoke all on public.review_members, public.assets, public.versions, public.comments, public.review_links from anon, authenticated;
grant select on public.review_members, public.assets, public.versions, public.comments, public.review_links to authenticated;
grant insert (id, title, category, description, status) on public.assets to authenticated;
grant update (title, category, description, status) on public.assets to authenticated;
grant insert (id, asset_id, number, filename, storage_path, files, stats) on public.versions to authenticated;
grant insert (asset_id, version_id, author_id, author_name, body, dimension, verdict, context) on public.comments to authenticated;
grant insert (asset_id, token_hash, expires_at) on public.review_links to authenticated;
grant update (revoked_at) on public.review_links to authenticated;
grant all on public.review_members, public.assets, public.versions, public.comments, public.review_links to service_role;

drop policy if exists member_own_role on public.review_members;
create policy member_own_role on public.review_members for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists members_read_assets on public.assets;
create policy members_read_assets on public.assets for select to authenticated using ((select private.review_role()) in ('owner', 'reviewer'));
drop policy if exists owner_create_assets on public.assets;
create policy owner_create_assets on public.assets for insert to authenticated with check ((select private.review_role()) = 'owner');
drop policy if exists owner_update_assets on public.assets;
create policy owner_update_assets on public.assets for update to authenticated using ((select private.review_role()) = 'owner') with check ((select private.review_role()) = 'owner');
drop policy if exists members_read_versions on public.versions;
create policy members_read_versions on public.versions for select to authenticated using ((select private.review_role()) in ('owner', 'reviewer'));
drop policy if exists owner_create_versions on public.versions;
create policy owner_create_versions on public.versions for insert to authenticated with check ((select private.review_role()) = 'owner');
drop policy if exists members_read_comments on public.comments;
create policy members_read_comments on public.comments for select to authenticated using ((select private.review_role()) in ('owner', 'reviewer'));
drop policy if exists members_write_own_comments on public.comments;
create policy members_write_own_comments on public.comments for insert to authenticated
  with check ((select private.review_role()) in ('owner', 'reviewer') and author_id = (select auth.uid()) and guest_link_id is null);
drop policy if exists owner_read_links on public.review_links;
create policy owner_read_links on public.review_links for select to authenticated using ((select private.review_role()) = 'owner');
drop policy if exists owner_create_links on public.review_links;
create policy owner_create_links on public.review_links for insert to authenticated with check ((select private.review_role()) = 'owner' and revoked_at is null);
drop policy if exists owner_revoke_links on public.review_links;
create policy owner_revoke_links on public.review_links for update to authenticated using ((select private.review_role()) = 'owner') with check ((select private.review_role()) = 'owner');

create or replace function private.review_asset(p_asset_id uuid, p_status text) returns public.assets
language plpgsql security definer set search_path = '' as $$
declare changed public.assets;
begin
  if private.review_role() is null or private.review_role() not in ('owner', 'reviewer') then
    raise exception 'Not permitted' using errcode = '42501'; end if;
  if p_status is null or p_status not in ('review', 'changes', 'approved') then
    raise exception 'Invalid review status' using errcode = '22023'; end if;
  update public.assets set status = p_status where id = p_asset_id returning * into changed;
  if not found then raise exception 'Asset not found' using errcode = 'P0002'; end if;
  return changed;
end;
$$;
revoke all on function private.review_asset(uuid, text) from public, anon;
grant execute on function private.review_asset(uuid, text) to authenticated;
create or replace function public.review_asset(p_asset_id uuid, p_status text) returns public.assets
language sql security invoker set search_path = '' as $$ select private.review_asset(p_asset_id, p_status); $$;
revoke all on function public.review_asset(uuid, text) from public, anon;
grant execute on function public.review_asset(uuid, text) to authenticated;

-- Private bucket. No anonymous storage policy and no public object URL.
insert into storage.buckets(id, name, public, file_size_limit)
values ('review-files', 'review-files', false, 262144000)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;
drop policy if exists qixi_members_read_files on storage.objects;
create policy qixi_members_read_files on storage.objects for select to authenticated
  using (bucket_id = 'review-files' and (select private.review_role()) in ('owner', 'reviewer'));
drop policy if exists qixi_owner_upload_files on storage.objects;
create policy qixi_owner_upload_files on storage.objects for insert to authenticated with check (
  bucket_id = 'review-files' and (select private.review_role()) = 'owner'
  and array_length(storage.foldername(name), 1) = 2
  and (storage.foldername(name))[2] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  and exists (select 1 from public.assets a where a.id::text = (storage.foldername(name))[1])
);
drop policy if exists qixi_owner_cleanup_files on storage.objects;
create policy qixi_owner_cleanup_files on storage.objects for delete to authenticated
  using (bucket_id = 'review-files' and (select private.review_role()) = 'owner');

-- Only the Edge Function's service_role can invoke these wrappers. No anon RPC grant.
-- The Edge Function hashes the random link token; neither DB nor SQL logs receive plaintext.
create or replace function private.get_shared_data(p_token_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare link public.review_links; result jsonb; now_at timestamptz := clock_timestamp();
begin
  select * into link from public.review_links where token_hash = p_token_hash for update;
  if not found or link.revoked_at is not null or link.expires_at <= now_at then
    raise exception 'Invalid or expired review link' using errcode = '42501'; end if;
  if link.read_window <= now_at - interval '1 minute' then
    update public.review_links set read_window = now_at, read_count = 1 where id = link.id;
  elsif link.read_count >= 60 then
    raise exception 'Rate limit exceeded; retry in one minute' using errcode = 'P0001';
  else update public.review_links set read_count = read_count + 1 where id = link.id; end if;
  select jsonb_build_object(
    'expires_at', link.expires_at,
    'assets', coalesce((select jsonb_agg(to_jsonb(a) order by a.created_at) from public.assets a where link.asset_id is null or a.id = link.asset_id), '[]'::jsonb),
    'versions', coalesce((select jsonb_agg(to_jsonb(v) order by v.number desc) from public.versions v where link.asset_id is null or v.asset_id = link.asset_id), '[]'::jsonb),
    'comments', coalesce((select jsonb_agg(jsonb_build_object(
      'id', c.id, 'asset_id', c.asset_id, 'version_id', c.version_id, 'author_name', c.author_name,
      'body', c.body, 'dimension', c.dimension, 'verdict', c.verdict, 'context', c.context,
      'created_at', c.created_at, 'is_guest', c.guest_link_id is not null
    ) order by c.created_at) from public.comments c where link.asset_id is null or c.asset_id = link.asset_id), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;
revoke all on function private.get_shared_data(text) from public, anon, authenticated;
grant execute on function private.get_shared_data(text) to service_role;
create or replace function public.get_shared_data(p_token_hash text) returns jsonb
language sql security invoker set search_path = '' as $$ select private.get_shared_data(p_token_hash); $$;
revoke all on function public.get_shared_data(text) from public, anon, authenticated;
grant execute on function public.get_shared_data(text) to service_role;

-- Locking the link row serializes submissions: the 10/minute quota is atomic.
create or replace function private.submit_shared_comment(
  p_token_hash text, p_asset_id uuid, p_version_id uuid, p_author_name text, p_body text,
  p_dimension text default 'general', p_verdict text default 'note', p_context jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare link public.review_links; added public.comments; now_at timestamptz := clock_timestamp();
begin
  select * into link from public.review_links where token_hash = p_token_hash for update;
  if not found or link.revoked_at is not null or link.expires_at <= now_at then
    raise exception 'Invalid or expired review link' using errcode = '42501'; end if;
  if p_asset_id is null or (link.asset_id is not null and link.asset_id <> p_asset_id)
    or not exists (select 1 from public.assets where id = p_asset_id) then
    raise exception 'Asset outside share scope' using errcode = '42501'; end if;
  if p_version_id is not null and not exists (select 1 from public.versions where id = p_version_id and asset_id = p_asset_id) then
    raise exception 'Version outside asset' using errcode = '22023'; end if;
  if coalesce(char_length(btrim(p_author_name)), 0) not between 1 and 80
    or coalesce(char_length(btrim(p_body)), 0) not between 1 and 5000
    or p_dimension is null or p_dimension not in ('general', 'topology', 'material', 'structure', 'normals', 'animation', 'vfx')
    or p_verdict is null or p_verdict not in ('note', 'changes', 'approved')
    or jsonb_typeof(p_context) is distinct from 'object' or octet_length(p_context::text) > 16384 then
    raise exception 'Invalid comment fields' using errcode = '22023'; end if;
  if link.comment_window <= now_at - interval '1 minute' then
    update public.review_links set comment_window = now_at, comment_count = 1 where id = link.id;
  elsif link.comment_count >= 10 then
    raise exception 'Rate limit exceeded; retry in one minute' using errcode = 'P0001';
  else update public.review_links set comment_count = comment_count + 1 where id = link.id; end if;
  insert into public.comments(asset_id, version_id, guest_link_id, author_name, body, dimension, verdict, context)
    values(p_asset_id, p_version_id, link.id, btrim(p_author_name), btrim(p_body), p_dimension, p_verdict, p_context)
    returning * into added;
  -- Guest verdicts are suggestions only: never update assets.status here.
  return jsonb_build_object('id', added.id, 'asset_id', added.asset_id, 'version_id', added.version_id,
    'author_name', added.author_name, 'body', added.body, 'dimension', added.dimension,
    'verdict', added.verdict, 'context', added.context, 'created_at', added.created_at, 'is_guest', true);
end;
$$;
revoke all on function private.submit_shared_comment(text, uuid, uuid, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function private.submit_shared_comment(text, uuid, uuid, text, text, text, text, jsonb) to service_role;
create or replace function public.submit_shared_comment(
  p_token_hash text, p_asset_id uuid, p_version_id uuid, p_author_name text, p_body text,
  p_dimension text default 'general', p_verdict text default 'note', p_context jsonb default '{}'::jsonb
) returns jsonb language sql security invoker set search_path = '' as $$
  select private.submit_shared_comment(p_token_hash, p_asset_id, p_version_id, p_author_name, p_body, p_dimension, p_verdict, p_context);
$$;
revoke all on function public.submit_shared_comment(text, uuid, uuid, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.submit_shared_comment(text, uuid, uuid, text, text, text, text, jsonb) to service_role;
commit;

-- After creating/inviting the owner in Authentication > Users, run with the REAL ID:
-- insert into public.review_members(user_id, role) values ('YOUR_AUTH_USER_UUID', 'owner');
-- Optional authenticated reviewer: insert another pre-created user's UUID with role 'reviewer'.
-- Membership is administered ONLY via SQL Editor; users cannot promote themselves.
