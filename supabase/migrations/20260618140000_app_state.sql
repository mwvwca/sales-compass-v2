-- Cloud persistence for Sales Compass: one key-value table mirroring the
-- app's existing localStorage keys (one JSON row per key, per user).
create table if not exists public.app_state (
  user_id    uuid not null references auth.users(id) on delete cascade,
  key        text not null,
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

alter table public.app_state enable row level security;

-- Only the signed-in owner can touch their own rows. The anon/publishable
-- key that ships in the client bundle gets nothing.
-- (drop-then-create so this migration is idempotent and safe to re-run.)
drop policy if exists "owner read"   on public.app_state;
drop policy if exists "owner insert" on public.app_state;
drop policy if exists "owner update" on public.app_state;
drop policy if exists "owner delete" on public.app_state;
create policy "owner read"   on public.app_state for select using (auth.uid() = user_id);
create policy "owner insert" on public.app_state for insert with check (auth.uid() = user_id);
create policy "owner update" on public.app_state for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "owner delete" on public.app_state for delete using (auth.uid() = user_id);

-- Keep updated_at current on every write.
create or replace function public.touch_updated_at() returns trigger
  language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
drop trigger if exists app_state_touch on public.app_state;
create trigger app_state_touch before update on public.app_state
  for each row execute function public.touch_updated_at();
