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
  using (true);

drop policy if exists "Users can insert their own profile" on public.profiles;
create policy "Users can insert their own profile"
  on public.profiles for insert
  with check (auth.uid() = id);

drop policy if exists "Users can update their own profile" on public.profiles;
create policy "Users can update their own profile"
  on public.profiles for update
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
  using (status = 'published');

drop policy if exists "Artisans can read their own products" on public.products;
create policy "Artisans can read their own products"
  on public.products for select
  using (auth.uid() = artisan_id);

drop policy if exists "Artisans can insert their own products" on public.products;
create policy "Artisans can insert their own products"
  on public.products for insert
  with check (auth.uid() = artisan_id);

drop policy if exists "Artisans can update their own products" on public.products;
create policy "Artisans can update their own products"
  on public.products for update
  using (auth.uid() = artisan_id);

drop policy if exists "Artisans can delete their own products" on public.products;
create policy "Artisans can delete their own products"
  on public.products for delete
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
insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do update set public = true;

drop policy if exists "Product images are publicly readable" on storage.objects;
create policy "Product images are publicly readable"
  on storage.objects for select
  using (bucket_id = 'product-images');

drop policy if exists "Authenticated users can upload product images" on storage.objects;
create policy "Authenticated users can upload product images"
  on storage.objects for insert
  with check (bucket_id = 'product-images' and auth.role() = 'authenticated');

drop policy if exists "Artisans can update their own uploaded images" on storage.objects;
create policy "Artisans can update their own uploaded images"
  on storage.objects for update
  using (bucket_id = 'product-images' and owner = auth.uid());

drop policy if exists "Artisans can delete their own uploaded images" on storage.objects;
create policy "Artisans can delete their own uploaded images"
  on storage.objects for delete
  using (bucket_id = 'product-images' and owner = auth.uid());
