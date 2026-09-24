# JR IMPORTADOS

Projeto preparado para hospedagem em Railway com Node.js + Express + PostgreSQL.

Duas partes no mesmo servidor:
- **Loja pública** (`/`) — vitrine para os clientes, mostra só as peças que o admin marcou como "visível para o cliente".
- **Painel administrativo** (`/admin`) — onde você cadastra categorias, peças, entregas, vendas etc. Acesso restrito por senha.

## Teste local

1. Instale Node.js 20+.
2. No terminal, dentro desta pasta:

```bash
npm install
npm start
```

3. Loja pública: http://localhost:3000
4. Painel admin: http://localhost:3000/admin

Sem `DATABASE_URL`, o projeto usa `data.json` para teste local.

## Acesso do painel administrativo

O painel (`/admin`) só é acessado por quem sabe a senha de administrador. Ela é definida pela variável de ambiente:

```
ADMIN_PASSWORD=sua-senha-aqui
```

Sem essa variável configurada, o login fica bloqueado (ninguém entra, nem com senha certa). Configure-a no Railway (aba Variables do serviço) antes de usar o painel em produção.

O login gera um token temporário (válido por 7 dias) guardado no navegador do admin; ele é enviado em toda chamada à API do painel. As rotas de dados da loja (`/api/state`, `/api/history`, `/api/settings`, `/api/blocked-emails`) exigem esse token. Já a rota `/api/store`, usada pela vitrine pública, é aberta — mas só devolve as peças marcadas como visíveis, nunca o catálogo completo.

## Mostrar uma peça na loja pública

Dentro de uma categoria, cada peça tem uma seta (ícone ▸) nas ações do card. Clicando nela, abre um painel com:

- **Mostrar peça para o cliente** — liga/desliga a peça na vitrine pública.
- **Foto usada na loja** — escolha entre usar a mesma foto já cadastrada da peça, ou enviar uma foto diferente só para o cliente ver (a foto original do estoque continua igual no admin).

## Configurar o número de WhatsApp da loja

Abra `loja.html` e edite a linha `const WHATS_NUMBER = '';` perto do fim do arquivo, colocando o número completo com DDI e DDD (ex: `5599999999999`). Sem isso, o botão "WhatsApp" abre sem número pré-preenchido.

## Railway + PostgreSQL

1. Crie um projeto no Railway.
2. Adicione um serviço PostgreSQL.
3. Adicione este repositório/projeto como serviço Node.js.
4. Garanta que a variável `DATABASE_URL` do PostgreSQL e a variável `ADMIN_PASSWORD` estejam disponíveis no serviço do site.
5. O comando de inicialização é `npm start`.
6. O banco é criado automaticamente na primeira inicialização.

O painel envia categorias e peças para `/api/state`, e o servidor registra alterações em `audit_history`.

## PWA (instalar como aplicativo)

Este projeto já vem pronto para ser "instalado" (like um app) no celular ou computador, no painel admin:

- `manifest.json` e `service-worker.js` na raiz
- Pasta `icons/` com `icon-192.png` e `icon-512.png` — **é obrigatório fazer o deploy dessa pasta junto**, senão o navegador não considera o site instalável e o service worker falha ao tentar cachear os ícones.
- Botão "📲 Instalar aplicativo" já existe dentro de Configurações no painel.
- No Android/Chrome/Edge, o botão dispara o prompt nativo de instalação. No iPhone/iPad (Safari), como o iOS não permite esse prompt automático, o botão mostra o passo a passo de "Compartilhar → Adicionar à Tela de Início".

Se quiser trocar o ícone, é só substituir os dois arquivos em `icons/` mantendo os mesmos nomes e tamanhos (192x192 e 512x512).
