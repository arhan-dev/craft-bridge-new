-- ============================================================================
-- CraftBridge — Supabase schema
-- Run this once in your Supabase project's SQL Editor (Project → SQL Editor).
-- Safe to re-run: uses IF NOT EXISTS / CREATE OR REPLACE where possible.
-- ============================================================================

-- ---------- PROFILES ----------
-- One row per artisan, keyed to their auth.users id. Public-readable because
-- buyers need to see the artisan's business name / region / WhatsApp number.
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  business_name text not null default 'New Artisan',
  region text not null default '',
  craft_category text not null default '',
  whatsapp_number text not null default '',
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "Profiles are publicly readable" on public.profiles;
create policy "Profiles are publicly readable"
  on public.profiles for select
  to anon, authenticated
  using (true);

drop policy if exists "Users can insert their own profile" on public.profiles;
create policy "Users can insert their own profile"
  on public.profiles for insert
  to authenticated
  with check (auth.uid() = id);

drop policy if exists "Users can update their own profile" on public.profiles;
create policy "Users can update their own profile"
  on public.profiles for update
  to authenticated
  using (auth.uid() = id);

-- Auto-create a blank profile row whenever a new artisan signs up.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, business_name, region, craft_category, whatsapp_number)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'business_name', 'New Artisan'),
    coalesce(new.raw_user_meta_data->>'region', ''),
    coalesce(new.raw_user_meta_data->>'craft_category', ''),
    coalesce(new.raw_user_meta_data->>'whatsapp_number', '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ---------- PRODUCTS ----------
create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  artisan_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  category text not null,
  description text not null default '',
  price numeric not null default 0,
  region text not null default '',
  image_url text,
  tags text[] not null default '{}',
  artisan_name text not null default '',
  artisan_whatsapp text not null default '',
  status text not null default 'published' check (status in ('published', 'draft')),
  created_at timestamptz not null default now()
);

create index if not exists products_artisan_id_idx on public.products(artisan_id);
create index if not exists products_status_idx on public.products(status);

alter table public.products enable row level security;

drop policy if exists "Published products are publicly readable" on public.products;
create policy "Published products are publicly readable"
  on public.products for select
  to anon, authenticated
  using (status = 'published');

drop policy if exists "Artisans can read their own products" on public.products;
create policy "Artisans can read their own products"
  on public.products for select
  to authenticated
  using (auth.uid() = artisan_id);

drop policy if exists "Artisans can insert their own products" on public.products;
create policy "Artisans can insert their own products"
  on public.products for insert
  to authenticated
  with check (auth.uid() = artisan_id);

drop policy if exists "Artisans can update their own products" on public.products;
create policy "Artisans can update their own products"
  on public.products for update
  to authenticated
  using (auth.uid() = artisan_id);

drop policy if exists "Artisans can delete their own products" on public.products;
create policy "Artisans can delete their own products"
  on public.products for delete
  to authenticated
  using (auth.uid() = artisan_id);

-- ---------- BASE TABLE GRANTS ----------
-- Row Level Security policies above only take effect once these base grants
-- exist — without them, Postgres blocks access before RLS is even evaluated,
-- producing "permission denied for table X" errors.
grant usage on schema public to anon, authenticated;

grant select on public.profiles to anon, authenticated;
grant insert, update on public.profiles to authenticated;

grant select on public.products to anon, authenticated;
grant insert, update, delete on public.products to authenticated;

-- ---------- STORAGE ----------
-- Create the "product-images" bucket if it doesn't already exist, and make it public-read.
-- file_size_limit and allowed_mime_types are enforced by Supabase itself at
-- upload time — a request exceeding either is rejected before it ever
-- reaches your policies below, regardless of what the client claims.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-images', 'product-images', true, 8388608, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set
  public = true,
  file_size_limit = 8388608,
  allowed_mime_types = array['image/jpeg','image/png','image/webp'];

drop policy if exists "Product images are publicly readable" on storage.objects;
create policy "Product images are publicly readable"
  on storage.objects for select
  to anon, authenticated
  using (bucket_id = 'product-images');

-- Path-scoped: an artisan can only write into a folder named after their own
-- user id (the app already uploads to `${currentUser.id}/filename`). Without
-- the foldername check, any authenticated user could upload into — or
-- overwrite files in — any other artisan's folder.
drop policy if exists "Authenticated users can upload product images" on storage.objects;
create policy "Artisans can upload into their own folder"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'product-images'
    and auth.role() = 'authenticated'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "Artisans can update their own uploaded images" on storage.objects;
create policy "Artisans can update their own uploaded images"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'product-images' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "Artisans can delete their own uploaded images" on storage.objects;
create policy "Artisans can delete their own uploaded images"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'product-images' and (storage.foldername(name))[1] = auth.uid()::text);

-- ---------- AI USAGE (rate limiting for /api/caption) ----------
-- One row per Gemini call. api/caption.js checks how many rows a user has
-- created in the last hour before allowing another call, and inserts a new
-- row when it proceeds. Using a real table (rather than in-memory counters)
-- is required here because serverless functions don't persist state between
-- invocations — a variable in the function file resets on every cold start.
create table if not exists public.ai_usage (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists ai_usage_user_id_created_at_idx
  on public.ai_usage(user_id, created_at);

alter table public.ai_usage enable row level security;

drop policy if exists "Users can insert their own usage records" on public.ai_usage;
create policy "Users can insert their own usage records"
  on public.ai_usage for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "Users can read their own usage records" on public.ai_usage;
create policy "Users can read their own usage records"
  on public.ai_usage for select
  to authenticated
  using (auth.uid() = user_id);

grant select, insert on public.ai_usage to authenticated;

-- Atomically check-and-record one AI usage call for the current user.
-- api/caption.js previously did a separate "count rows" REST call followed
-- by a separate "insert row" REST call. Two requests arriving at nearly the
-- same instant could both read a count under the limit before either had
-- inserted, letting both through. Doing the count + insert inside one
-- SECURITY DEFINER function call is a single statement from Postgres's
-- point of view, and pg_advisory_xact_lock below additionally serializes
-- concurrent calls for the same user for the lifetime of the transaction,
-- so a burst of simultaneous requests from one artisan can no longer all
-- slip in under the same stale count.
-- Returns true if this call is allowed (and has been recorded), false if
-- the user is already at their limit for the window.
create or replace function public.check_and_record_ai_usage(
  p_limit integer,
  p_window_seconds integer
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_window_start timestamptz := now() - (p_window_seconds || ' seconds')::interval;
  v_count integer;
begin
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  perform pg_advisory_xact_lock(hashtext(v_user_id::text));

  select count(*) into v_count
  from public.ai_usage
  where user_id = v_user_id
    and created_at >= v_window_start;

  if v_count >= p_limit then
    return false;
  end if;

  insert into public.ai_usage (user_id) values (v_user_id);
  return true;
end;
$$;

-- Postgres grants EXECUTE on new functions to PUBLIC by default (unlike
-- tables). Revoke that first so anon has no path to this function at all;
-- only the explicit grant below applies.
revoke execute on function public.check_and_record_ai_usage(integer, integer) from public;
grant execute on function public.check_and_record_ai_usage(integer, integer) to authenticated;
