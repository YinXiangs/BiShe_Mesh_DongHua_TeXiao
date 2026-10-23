-- 栖息邮局：先执行 schema.sql，再在同一项目的 SQL Editor 执行本文件。
-- 每次重跑 schema.sql 后也要重跑本文件；本迁移可重复执行，不删除作品或文件。
-- 启用前须在 Authentication 建立账户，再由管理员在 review_members 指定
-- 学生 owner / 老师 reviewer。网页访问口令不是 Supabase 登录凭证。
-- 此文件只准备共享工作流；配置、实际部署和跨设备验证仍须在真实项目完成。
begin;

alter table public.assets add column if not exists teacher_read_version_id uuid;
alter table public.assets add column if not exists teacher_read_at timestamptz;
alter table public.assets add column if not exists deleted_at timestamptz;
alter table public.assets drop constraint if exists teacher_read_version_asset_fk;
alter table public.assets add constraint teacher_read_version_asset_fk
  foreign key (teacher_read_version_id, id) references public.versions(id, asset_id);
alter table public.assets drop constraint if exists teacher_read_stamp_pair;
alter table public.assets add constraint teacher_read_stamp_pair
  check ((teacher_read_version_id is null) = (teacher_read_at is null));
create index if not exists assets_active_created_index on public.assets(created_at) where deleted_at is null;

-- Revoke both table and column privileges. Revoking table privileges alone does
-- not remove the older schema's column-level permission to change status.
revoke all on table public.assets from authenticated;
revoke all (id, title, category, description, status, created_at, teacher_read_version_id, teacher_read_at, deleted_at)
  on table public.assets from authenticated;
grant select on public.assets to authenticated;
grant insert (id, title, category, description) on public.assets to authenticated;
grant update (title, category, description) on public.assets to authenticated;

drop policy if exists owner_create_assets on public.assets;
create policy owner_create_assets on public.assets for insert to authenticated with check (
  (select private.review_role()) = 'owner' and status = 'pending'
  and teacher_read_version_id is null and teacher_read_at is null and deleted_at is null
);
drop policy if exists owner_update_assets on public.assets;
create policy owner_update_assets on public.assets for update to authenticated
  using ((select private.review_role()) = 'owner' and deleted_at is null)
  with check ((select private.review_role()) = 'owner' and deleted_at is null);
drop policy if exists owner_create_versions on public.versions;
create policy owner_create_versions on public.versions for insert to authenticated with check (
  (select private.review_role()) = 'owner'
  and exists (select 1 from public.assets a where a.id = asset_id and a.deleted_at is null)
);
drop policy if exists qixi_owner_upload_files on storage.objects;
create policy qixi_owner_upload_files on storage.objects for insert to authenticated with check (
  bucket_id = 'review-files' and (select private.review_role()) = 'owner'
  and array_length(storage.foldername(name), 1) = 2
  and (storage.foldername(name))[2] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  and exists (select 1 from public.assets a where a.id::text = (storage.foldername(name))[1] and a.deleted_at is null)
);

create or replace function private.mark_asset_read(p_asset_id uuid, p_version_id uuid) returns public.assets
language plpgsql security definer set search_path = '' as $$
declare changed public.assets; latest_id uuid;
begin
  if auth.uid() is null or private.review_role() is distinct from 'reviewer' then
    raise exception 'Authenticated reviewer required' using errcode = '42501'; end if;
  -- NO KEY UPDATE serializes workflow writes while allowing the FK's KEY SHARE
  -- lock during version inserts; FOR UPDATE here could cause an upgrade deadlock.
  select * into changed from public.assets where id = p_asset_id and deleted_at is null for no key update;
  if not found then raise exception 'Active asset not found' using errcode = 'P0002'; end if;
  select id into latest_id from public.versions where asset_id = p_asset_id order by number desc limit 1;
  if latest_id is null or p_version_id is distinct from latest_id then
    raise exception 'Only the latest submitted version can be marked read' using errcode = '22023'; end if;
  update public.assets set teacher_read_version_id = latest_id, teacher_read_at = clock_timestamp()
    where id = p_asset_id returning * into changed;
  return changed;
end;
$$;
revoke all on function private.mark_asset_read(uuid, uuid) from public, anon, authenticated;
grant execute on function private.mark_asset_read(uuid, uuid) to authenticated;
create or replace function public.mark_asset_read(p_asset_id uuid, p_version_id uuid) returns public.assets
language sql security invoker set search_path = '' as $$ select private.mark_asset_read(p_asset_id, p_version_id); $$;
revoke all on function public.mark_asset_read(uuid, uuid) from public, anon, authenticated;
grant execute on function public.mark_asset_read(uuid, uuid) to authenticated;

-- The legacy two-argument RPC has no reviewed-version identity and must not be
-- callable by clients. Keep it only for baseline schema compatibility.
revoke all on function private.review_asset(uuid, text) from public, anon, authenticated;
revoke all on function public.review_asset(uuid, text) from public, anon, authenticated;
create or replace function private.review_asset(p_asset_id uuid, p_status text, p_version_id uuid) returns public.assets
language plpgsql security definer set search_path = '' as $$
declare changed public.assets; latest_id uuid;
begin
  if auth.uid() is null or private.review_role() is distinct from 'reviewer' then
    raise exception 'Authenticated reviewer required' using errcode = '42501'; end if;
  if p_status is null or p_status not in ('review', 'changes', 'approved') then
    raise exception 'Invalid review status' using errcode = '22023'; end if;
  select * into changed from public.assets where id = p_asset_id and deleted_at is null for no key update;
  if not found then raise exception 'Active asset not found' using errcode = 'P0002'; end if;
  if p_version_id is null or not exists (select 1 from public.versions where id = p_version_id and asset_id = p_asset_id) then
    raise exception 'Review version does not belong to this asset' using errcode = '22023'; end if;
  select id into latest_id from public.versions where asset_id = p_asset_id order by number desc limit 1;
  if p_version_id is distinct from latest_id then
    raise exception 'Stale review version; refresh this work and review its latest submission' using errcode = '22023'; end if;
  update public.assets set status = p_status where id = p_asset_id returning * into changed;
  return changed;
end;
$$;
revoke all on function private.review_asset(uuid, text, uuid) from public, anon, authenticated;
grant execute on function private.review_asset(uuid, text, uuid) to authenticated;
create or replace function public.review_asset(p_asset_id uuid, p_status text, p_version_id uuid) returns public.assets
language sql security invoker set search_path = '' as $$ select private.review_asset(p_asset_id, p_status, p_version_id); $$;
revoke all on function public.review_asset(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.review_asset(uuid, text, uuid) to authenticated;

create or replace function private.soft_delete_asset(p_asset_id uuid) returns public.assets
language plpgsql security definer set search_path = '' as $$
declare changed public.assets;
begin
  if auth.uid() is null or private.review_role() is distinct from 'owner' then
    raise exception 'Authenticated owner required' using errcode = '42501'; end if;
  select * into changed from public.assets where id = p_asset_id for no key update;
  if not found then raise exception 'Asset not found' using errcode = 'P0002'; end if;
  update public.assets set deleted_at = coalesce(deleted_at, clock_timestamp())
    where id = p_asset_id returning * into changed;
  return changed;
end;
$$;
revoke all on function private.soft_delete_asset(uuid) from public, anon, authenticated;
grant execute on function private.soft_delete_asset(uuid) to authenticated;
create or replace function public.soft_delete_asset(p_asset_id uuid) returns public.assets
language sql security invoker set search_path = '' as $$ select private.soft_delete_asset(p_asset_id); $$;
revoke all on function public.soft_delete_asset(uuid) from public, anon, authenticated;
grant execute on function public.soft_delete_asset(uuid) to authenticated;

create or replace function private.restore_asset(p_asset_id uuid) returns public.assets
language plpgsql security definer set search_path = '' as $$
declare changed public.assets;
begin
  if auth.uid() is null or private.review_role() is distinct from 'owner' then
    raise exception 'Authenticated owner required' using errcode = '42501'; end if;
  select * into changed from public.assets where id = p_asset_id for no key update;
  if not found then raise exception 'Asset not found' using errcode = 'P0002'; end if;
  update public.assets set deleted_at = null where id = p_asset_id returning * into changed;
  return changed;
end;
$$;
revoke all on function private.restore_asset(uuid) from public, anon, authenticated;
grant execute on function private.restore_asset(uuid) to authenticated;
create or replace function public.restore_asset(p_asset_id uuid) returns public.assets
language sql security invoker set search_path = '' as $$ select private.restore_asset(p_asset_id); $$;
revoke all on function public.restore_asset(uuid) from public, anon, authenticated;
grant execute on function public.restore_asset(uuid) to authenticated;

create or replace function private.reset_review_after_version_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.assets where id = new.asset_id and deleted_at is null for no key update;
  if not found then raise exception 'Active asset not found' using errcode = 'P0002'; end if;
  update public.assets set teacher_read_version_id = null, teacher_read_at = null, status = 'review'
    where id = new.asset_id;
  return new;
end;
$$;
revoke all on function private.reset_review_after_version_insert() from public, anon, authenticated;
drop trigger if exists reset_asset_review_on_version on public.versions;
create trigger reset_asset_review_on_version after insert on public.versions
  for each row execute function private.reset_review_after_version_insert();

-- Keep existing guest token limits and read/comment scope. Deleted works and
-- their versions/comments are omitted; no guest read-stamp or review RPC exists.
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
    'assets', coalesce((select jsonb_agg(to_jsonb(a) order by a.created_at) from public.assets a
      where a.deleted_at is null and (link.asset_id is null or a.id = link.asset_id)), '[]'::jsonb),
    'versions', coalesce((select jsonb_agg(to_jsonb(v) order by v.number desc) from public.versions v
      join public.assets a on a.id = v.asset_id
      where a.deleted_at is null and (link.asset_id is null or v.asset_id = link.asset_id)), '[]'::jsonb),
    'comments', coalesce((select jsonb_agg(jsonb_build_object(
      'id', c.id, 'asset_id', c.asset_id, 'version_id', c.version_id, 'author_name', c.author_name,
      'body', c.body, 'dimension', c.dimension, 'verdict', c.verdict, 'context', c.context,
      'created_at', c.created_at, 'is_guest', c.guest_link_id is not null
    ) order by c.created_at) from public.comments c join public.assets a on a.id = c.asset_id
      where a.deleted_at is null and (link.asset_id is null or c.asset_id = link.asset_id)), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;
revoke all on function private.get_shared_data(text) from public, anon, authenticated;
grant execute on function private.get_shared_data(text) to service_role;

create or replace function private.submit_shared_comment(
  p_token_hash text, p_asset_id uuid, p_version_id uuid, p_author_name text, p_body text,
  p_dimension text default 'general', p_verdict text default 'note', p_context jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare link public.review_links; added public.comments; now_at timestamptz := clock_timestamp();
begin
  select * into link from public.review_links where token_hash = p_token_hash for update;
  if not found or link.revoked_at is not null or link.expires_at <= now_at then
    raise exception 'Invalid or expired review link' using errcode = '42501'; end if;
  if p_asset_id is null or (link.asset_id is not null and link.asset_id <> p_asset_id) then
    raise exception 'Asset outside share scope' using errcode = '42501'; end if;
  perform 1 from public.assets where id = p_asset_id and deleted_at is null for no key update;
  if not found then raise exception 'Active asset outside share scope' using errcode = '42501'; end if;
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
  -- Guest verdicts remain suggestions and never change assets.status or read stamps.
  return jsonb_build_object('id', added.id, 'asset_id', added.asset_id, 'version_id', added.version_id,
    'author_name', added.author_name, 'body', added.body, 'dimension', added.dimension,
    'verdict', added.verdict, 'context', added.context, 'created_at', added.created_at, 'is_guest', true);
end;
$$;
revoke all on function private.submit_shared_comment(text, uuid, uuid, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function private.submit_shared_comment(text, uuid, uuid, text, text, text, text, jsonb) to service_role;
commit;
