# Controle de Assinaturas

Sistema de assinaturas com dashboard de pagamentos.

- **Front-end:** Vite + JavaScript + CSS (sem framework)
- **Back-end:** Node.js + Express + Postgres do **Supabase** (driver `pg`)

## Requisitos

Node.js **22.13 ou mais novo**. Baixe a versão LTS em https://nodejs.org.

## Desenvolvimento

```bash
npm install
npm run dev
```

Abra http://localhost:5173 e entre com seu e-mail: o servidor envia um código de 6 dígitos pelo Resend.
A página de vendas fica em http://localhost:5173/assinar.

### Login por código (arquivo `.env`)

```
RESEND_API_KEY=re_...
RESEND_FROM=Control Claude <onboarding@resend.dev>
ADMIN_EMAILS=voce@exemplo.com          # separados por vírgula
SESSION_SECRET=...                     # gere com: openssl rand -hex 32
```

Sem domínio verificado no Resend, só dá para enviar ao e-mail dono da conta Resend.
Para usar outro e-mail (ex.: Gmail), verifique um domínio em resend.com/domains e use um remetente dele em `RESEND_FROM`.

O código vale 10 minutos, é de uso único e aceita até 5 tentativas. Novo código só a cada 60 s (máx. 5 por hora).
A API roda na porta 3000, e o Vite repassa as chamadas `/api` para ela.

## Produção

```bash
npm run build
PORT=3000 npm start
```

O Express entrega o front já compilado (`dist/`) e a API no mesmo endereço.
Se for publicar na internet, use HTTPS (por exemplo atrás de Nginx ou Caddy) e defina `HOST=0.0.0.0`.

| Variável         | Padrão            |
|------------------|-------------------|
| `PORT`           | `3000`            |
| `HOST`           | `127.0.0.1`       |
| `DATABASE_URL`   | conexão do Supabase (obrigatória) |

## Estrutura

```
index.html            telas e modais
src/main.js           login, abas, inicialização
src/api.js            chamadas à API
src/utils.js          formatação (R$, datas), toast
src/style.css         estilos (tema claro e escuro)
src/views/*.js        dashboard, assinantes, pagamentos, planos
server/index.js       servidor Express
server/routes.js      rotas da API e regras de status
server/auth.js        login por código no e-mail + cookie assinado
server/mail.js        envio de e-mail (Resend)
server/public.js      rotas públicas da página de vendas
server/db.js          conexão com o Postgres do Supabase
supabase/schema.sql   tabelas (rode no SQL Editor do Supabase)
supabase/rls.sql      políticas de segurança (RLS)
```

## Planos iniciais

- **Premium Claude**: R$ 200,00 por mês
- **Standard**: R$ 50,00 por mês

Você pode editar ou criar planos na aba **Planos**.

## Status de pagamento (por mês)

- **Pago**: o valor pago no mês cobre o preço do plano
- **Parcial**: pagou só parte (ex.: uma parcela)
- **Pendente**: não pagou ainda, mas o vencimento não passou
- **Atrasado**: não pagou e o vencimento já passou

## Backup

Os dados ficam no Supabase. Faça backup em Supabase → Database → Backups.
O arquivo `assinaturas.db` é do sistema antigo (SQLite) e não é mais usado.

## Avisos no WhatsApp (Evolution API)

Configure no `.env`: `EVOLUTION_URL`, `EVOLUTION_INSTANCE`, `EVOLUTION_TOKEN` (token da instância) e
`WHATSAPP_ADMIN_NUMBERS` (um ou mais números com DDI, separados por vírgula, ex.: `559295199964,5511999990000`).

| Quando | Para quem |
|---|---|
| Alguém cria conta (ainda sem pagar) | admin |
| Escolheu o plano e não pagou: 1 hora depois | lembrete ao cliente |
| Escolheu o plano e não pagou: 24 horas depois | último lembrete ao cliente + admin |
| 1º pagamento (nova assinatura) | admin + boas-vindas ao cliente |
| Pagamentos seguintes | admin + confirmação ao cliente |
| Cliente cancela (com período pago) | admin: "acesso até dd/mm"; o plano continua ativo até lá |
| `RETENTION_DAYS_BEFORE` dias antes do fim do acesso (padrão 3) | cliente: "quer continuar? responda SIM ou NÃO" |
| Cliente responde SIM / NÃO no WhatsApp | cliente + admin (SIM desfaz o cancelamento) |
| Último dia de acesso | plano vira Cancelado + admin: "desative este cliente" |
| `REMINDER_DAYS_BEFORE` dias antes do vencimento (padrão 3) | lembrete ao cliente |
| 1 dia antes do vencimento, sem pagamento | admin |
| Dia seguinte ao vencimento sem pagamento | cliente + admin |

Pedido não pago: conferido a cada 10 min, enviado das 8h às 21h. Lembrete e atraso: o servidor confere de hora em hora, só envia das 9h às 20h (`NOTIFY_TIMEZONE`)
e cada aviso sai uma vez por mês (tabela `notifications_sent`). Mensagens ao cliente só saem se ele
informou WhatsApp; desligue todas com `WHATSAPP_CUSTOMER_MESSAGES=off`.

## Produção (Easypanel / Docker)

O projeto tem `Dockerfile`. No Easypanel: Fonte **Git** → `https://github.com/leovieirafreitas/controlclaude.git`, ramo `main`;
Construção → **Dockerfile**; porta do domínio **3000**. Variáveis de ambiente: as mesmas do `.env` (modelo em `.env.example`),
com `APP_URL=https://seu-dominio` e `NODE_ENV=production`.

Rotas em produção: `/` página de vendas · `/admin` painel · `/conta` área do assinante · `/termos` · `/privacidade`.

### Cancelamento agendado e respostas no WhatsApp

Quem cancela continua usando até o fim do período pago (`subscribers.cancel_at`) e não recebe mais cobrança.
Para ler as respostas SIM/NÃO, o servidor configura sozinho o webhook da Evolution (evento MESSAGES_UPSERT)
quando `APP_URL` começa com `https://` — por isso só funciona no servidor publicado, não no localhost.
