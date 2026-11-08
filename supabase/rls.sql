-- Políticas de RLS do Controle de Assinaturas
--
-- Quem é quem:
--   anon (visitante da página de vendas): vê planos ativos e textos públicos,
--        e pode se cadastrar como 'aguardando'. Não lê assinantes nem pagamentos.
--   admin: usuário do Supabase Auth com app_metadata.role = 'admin'. Acesso total.
--        (app_metadata só pode ser alterado com a service_role, nunca pelo próprio usuário.)
--   service_role (servidor): ignora RLS, como sempre no Supabase.
--
-- Para tornar alguém admin (no SQL Editor):
--   update auth.users
--   set raw_app_meta_data = raw_app_meta_data || '{"role":"admin"}'
--   where email = 'voce@exemplo.com';

-- ------------------------------------------------------------------ função de admin

create or replace function public.is_admin()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false);
$$;

-- ------------------------------------------------------------------ plans

drop policy if exists "plans: público vê planos ativos" on public.plans;
create policy "plans: público vê planos ativos"
  on public.plans for select
  to anon, authenticated
  using (active);

drop policy if exists "plans: admin gerencia" on public.plans;
create policy "plans: admin gerencia"
  on public.plans for all
  to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

-- ------------------------------------------------------------------ settings
-- A chave Pix NÃO é pública: o visitante só vê marca, textos e WhatsApp.

drop policy if exists "settings: público vê textos da página" on public.settings;
create policy "settings: público vê textos da página"
  on public.settings for select
  to anon, authenticated
  using (key in ('brand_name', 'headline', 'subheadline', 'whatsapp'));

drop policy if exists "settings: admin gerencia" on public.settings;
create policy "settings: admin gerencia"
  on public.settings for all
  to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

-- ------------------------------------------------------------------ subscribers

-- Visitante pode se cadastrar, mas só como 'aguardando', num plano ativo e com dados de tamanho razoável.
drop policy if exists "subscribers: cadastro pela página de vendas" on public.subscribers;
create policy "subscribers: cadastro pela página de vendas"
  on public.subscribers for insert
  to anon, authenticated
  with check (
    status = 'aguardando'
    and length(trim(name)) between 2 and 120
    and email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' and length(email) <= 160
    and length(regexp_replace(phone, '\D', '', 'g')) between 10 and 15
    and exists (select 1 from public.plans p where p.id = plan_id and p.active)
  );

drop policy if exists "subscribers: admin gerencia" on public.subscribers;
create policy "subscribers: admin gerencia"
  on public.subscribers for all
  to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

-- O visitante só pode preencher nome, e-mail, WhatsApp e plano. O resto vem do banco.
revoke insert on public.subscribers from anon;
grant insert (name, email, phone, plan_id) on public.subscribers to anon;

-- Cadastro vindo de quem não é admin: força status, datas e observação.
create or replace function public.subscribers_public_signup()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not public.is_admin() and current_user in ('anon', 'authenticated') then
    new.status     := 'aguardando';
    new.start_date := current_date;
    new.due_day    := least(extract(day from current_date)::int, 28);
    new.notes      := 'Cadastro pela página de vendas';
    new.created_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists trg_subscribers_public_signup on public.subscribers;
create trigger trg_subscribers_public_signup
  before insert on public.subscribers
  for each row execute function public.subscribers_public_signup();

-- ------------------------------------------------------------------ payments
-- Só admin. Visitante não lê nem grava pagamentos.

drop policy if exists "payments: admin gerencia" on public.payments;
create policy "payments: admin gerencia"
  on public.payments for all
  to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));
