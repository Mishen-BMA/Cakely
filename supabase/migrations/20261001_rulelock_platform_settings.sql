alter table users add column if not exists rate_limited_until timestamptz;

create table if not exists platform_settings (
  id integer primary key check (id = 1),
  rulelock_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);

insert into platform_settings (id, rulelock_enabled)
values (1, false)
on conflict (id) do nothing;

alter table platform_settings enable row level security;
grant all privileges on platform_settings to service_role;
