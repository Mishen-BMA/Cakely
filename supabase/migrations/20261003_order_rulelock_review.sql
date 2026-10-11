alter table public.orders
  add column if not exists cancelled_by text,
  add column if not exists rulelock_review jsonb;

alter table public.orders
  drop constraint if exists orders_cancelled_by_check;

alter table public.orders
  add constraint orders_cancelled_by_check
  check (cancelled_by is null or cancelled_by in ('CUSTOMER', 'ADMIN'));

-- The existing orders.status column has no CHECK constraint. The application
-- uses PENDING, PENDING_REVIEW, PREPARING, COMPLETED, CANCELLED, REJECTED,
-- and REFUSED.
