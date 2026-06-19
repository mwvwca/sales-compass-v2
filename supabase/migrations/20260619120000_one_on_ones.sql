-- 1:1 capture: per-rep, per-week notes + action items, owned by the signed-in manager.
create table if not exists public.one_on_ones (
  user_id      uuid not null references auth.users(id) on delete cascade,
  rep_id       text not null,                          -- Rep.id (stable), NOT opp repName
  week         date not null,                          -- Monday (UTC) of the 1:1 week
  notes        text  not null default '',
  action_items jsonb not null default '[]'::jsonb,     -- [{id,text,done,owner?,due?}]
  updated_at   timestamptz not null default now(),
  primary key (user_id, rep_id, week)
);

alter table public.one_on_ones enable row level security;

-- Only the signed-in owner can touch their own rows. The anon/publishable
-- key that ships in the client bundle gets nothing.
-- (drop-then-create so this migration is idempotent and safe to re-run.)
drop policy if exists "owner read"   on public.one_on_ones;
drop policy if exists "owner insert" on public.one_on_ones;
drop policy if exists "owner update" on public.one_on_ones;
drop policy if exists "owner delete" on public.one_on_ones;
create policy "owner read"   on public.one_on_ones for select using (auth.uid() = user_id);
create policy "owner insert" on public.one_on_ones for insert with check (auth.uid() = user_id);
create policy "owner update" on public.one_on_ones for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "owner delete" on public.one_on_ones for delete using (auth.uid() = user_id);

-- Keep updated_at current on every write.
create or replace function public.touch_updated_at() returns trigger
  language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
drop trigger if exists one_on_ones_touch on public.one_on_ones;
create trigger one_on_ones_touch before update on public.one_on_ones
  for each row execute function public.touch_updated_at();
