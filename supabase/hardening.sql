-- Reforço de segurança (segunda tranca, além do RLS).
-- O sistema NÃO usa a API pública do Supabase (chave anon): o servidor conecta direto no Postgres
-- como dono do banco. Então os papéis públicos não precisam de nenhuma permissão nas tabelas.
-- Rodar no Supabase → SQL Editor. Pode ser desfeito com GRANT, se um dia for usar a API pública.

revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from anon;

-- tabelas criadas no futuro também nascem sem permissão pública
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from anon;

-- Conferir (deve voltar vazio):
-- select table_name, grantee, privilege_type from information_schema.role_table_grants
-- where table_schema = 'public' and grantee in ('anon', 'authenticated');

-- E no painel: Authentication → Sign In / Providers → desligar "Allow new users to sign up"
-- (o sistema não usa o login do Supabase; o admin já existente continua funcionando).
