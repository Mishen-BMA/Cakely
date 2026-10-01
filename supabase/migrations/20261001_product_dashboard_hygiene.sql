create or replace function public.admin_dashboard_metrics()
returns table (
  order_count bigint,
  pending_count bigint,
  preparing_count bigint,
  completed_count bigint,
  revenue numeric,
  customer_count bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    count(*)::bigint,
    count(*) filter (where status = 'PENDING')::bigint,
    count(*) filter (where status = 'PREPARING')::bigint,
    count(*) filter (where status = 'COMPLETED')::bigint,
    coalesce(sum(total), 0)::numeric,
    (select count(*) from users where is_admin = false)::bigint
  from orders;
$$;

create or replace function public.admin_dashboard_customer_stats(p_user_ids bigint[])
returns table (user_id bigint, orders bigint, spending numeric)
language sql
stable
security definer
set search_path = public
as $$
  select o.user_id, count(*)::bigint, coalesce(sum(o.total), 0)::numeric
  from orders o
  where o.user_id = any(coalesce(p_user_ids, array[]::bigint[]))
  group by o.user_id;
$$;

revoke all on function public.admin_dashboard_metrics() from public, anon, authenticated;
revoke all on function public.admin_dashboard_customer_stats(bigint[]) from public, anon, authenticated;
grant execute on function public.admin_dashboard_metrics() to service_role;
grant execute on function public.admin_dashboard_customer_stats(bigint[]) to service_role;
