-- Append-only dated transcript log per opportunity, owned by the signed-in user.
create table if not exists public.transcripts (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  opp_id     text not null,                       -- Opportunity.id (= salesforceId when present)
  created_at timestamptz not null default now(),
  raw_text   text not null,
  signals    jsonb not null default '{}'::jsonb
);

alter table public.transcripts enable row level security;

-- Owner-only access. The anon/publishable key in the client bundle gets nothing.
-- (drop-then-create so this migration is idempotent and safe to re-run.)
drop policy if exists "owner read"   on public.transcripts;
drop policy if exists "owner insert" on public.transcripts;
drop policy if exists "owner update" on public.transcripts;
drop policy if exists "owner delete" on public.transcripts;
create policy "owner read"   on public.transcripts for select using (auth.uid() = user_id);
create policy "owner insert" on public.transcripts for insert with check (auth.uid() = user_id);
create policy "owner update" on public.transcripts for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "owner delete" on public.transcripts for delete using (auth.uid() = user_id);

create index if not exists transcripts_user_opp on public.transcripts(user_id, opp_id, created_at desc);

-- Append-only dated log — no updated_at / touch trigger needed.
