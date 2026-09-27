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

> Se o `npm install` reclamar da versão do `@aws-sdk/client-s3` no `package.json` (o pacote lança versões novas com muita frequência), rode `npm install @aws-sdk/client-s3@latest` pra pegar a versão mais recente — não muda nada no funcionamento.

## Acesso do painel administrativo

O painel (`/admin`) só é acessado por quem sabe a senha de administrador. Ela é definida pela variável de ambiente:

```
ADMIN_PASSWORD=sua-senha-aqui
```

Sem essa variável configurada, o login fica bloqueado (ninguém entra, nem com senha certa). Configure-a no Railway (aba Variables do serviço) antes de usar o painel em produção.

O login gera um token temporário (válido por 7 dias) guardado no navegador do admin; ele é enviado em toda chamada à API do painel. As rotas de dados da loja (`/api/state`, `/api/history`, `/api/settings`, `/api/blocked-emails`, `/api/admin/upload`) exigem esse token. Já a rota `/api/store`, usada pela vitrine pública, é aberta — mas só devolve as peças marcadas como visíveis, nunca o catálogo completo.

A opção **"Limpar todos os dados"** (em Configurações) agora pede a senha de administrador de novo antes de apagar tudo — é uma segunda confirmação, verificada no servidor (`/api/admin/verify-password`), pra evitar apagar tudo sem querer.

## Mostrar uma peça na loja pública

Dentro de uma categoria, cada peça tem uma seta (ícone ▸) nas ações do card. Clicando nela, abre um painel com:

- **Mostrar peça para o cliente** — liga/desliga a peça na vitrine pública.
- **Foto usada na loja** — escolha entre usar a mesma foto já cadastrada da peça, ou enviar uma foto diferente só para o cliente ver (a foto original do estoque continua igual no admin).

## Fotos e vídeos: Cloudflare R2

Fotos das peças, foto do cliente e a foto/vídeo de montagem do loading podem ficar guardadas no **Cloudflare R2** em vez de dentro do PostgreSQL — isso evita que o banco fique pesado/cheio conforme o catálogo cresce.

**Sem configurar o R2, nada quebra**: o sistema continua guardando as imagens direto no banco, do jeito que já funcionava. O R2 é opcional e passa a ser usado automaticamente assim que as 5 variáveis abaixo estiverem preenchidas.

### 1. Criar o bucket no Cloudflare

1. No painel da Cloudflare, vá em **R2** → **Create bucket**. Dê um nome (ex: `jr-importados`).
2. Em **Settings** do bucket, ative **Public access** (ou configure um domínio customizado) e copie a URL pública — algo como `https://pub-xxxxxxxx.r2.dev` ou seu domínio próprio.
3. Em **R2 → Manage API Tokens**, crie um token com permissão de leitura/escrita (Object Read & Write) só para esse bucket. Isso te dá o **Access Key ID** e o **Secret Access Key**.
4. O **Account ID** aparece no painel da Cloudflare (barra lateral direita, ou na URL do dashboard).

### 2. Configurar as variáveis no Railway

Na aba **Variables** do serviço do site, adicione:

```
R2_ACCOUNT_ID=seu-account-id
R2_ACCESS_KEY_ID=sua-access-key
R2_SECRET_ACCESS_KEY=sua-secret-key
R2_BUCKET_NAME=jr-importados
R2_PUBLIC_URL=https://pub-xxxxxxxx.r2.dev
```

Depois de salvar, o Railway reinicia o serviço sozinho. Nos logs, deve aparecer:
`Cloudflare R2 configurado — novos uploads de mídia vão para o bucket ...`

### 3. Como funciona

- Toda foto ou vídeo novo enviado pelo admin (foto da peça, foto do cliente, foto/vídeo de montagem do loading) passa por `/api/admin/upload`: o servidor confere o tipo real do arquivo (não confia só na extensão), o tamanho, gera um nome único, e manda pro R2 dentro de uma pasta (`products/`, `videos/` ou `site/intro/`).
- O PostgreSQL passa a guardar só a **URL** do arquivo (ex: `image: "https://pub-xxx.r2.dev/products/abc123.jpg"`), nunca o arquivo em si.
- **Imagens antigas** que já estavam salvas em base64 direto no banco continuam funcionando normalmente — elas não são apagadas nem precisam ser migradas na força. Se quiser migrar uma peça antiga pro R2, basta reenviar a foto dela no admin (editar peça → trocar a foto) uma vez com o R2 já configurado.
- Quando uma peça é excluída, ou uma foto é trocada por outra, o servidor tenta remover a foto antiga do R2 automaticamente (só se ela não estiver sendo usada por nenhuma outra peça). Isso roda em segundo plano e nunca trava a ação do admin.

### 4. Limites de tamanho

- Fotos: até 6MB (o admin já comprime a imagem no navegador antes de enviar).
- Vídeos: até 9MB no servidor (o admin bloqueia no navegador arquivos acima de ~7MB antes mesmo de enviar).

### 5. Testando

1. **Upload de foto**: admin → categoria → adicionar peça → escolher uma foto → salvar. Confira no bucket do R2 (aba Objects na Cloudflare) se apareceu um arquivo novo em `products/`.
2. **Upload de vídeo de entrada**: Configurações → Animações da loja → escolher um vídeo. Confira em `site/intro/` no bucket.
3. **Exclusão**: apague a peça que você acabou de criar e confira se o arquivo correspondente sumiu do bucket (pode levar alguns segundos).
4. **Sem R2 configurado**: remova as variáveis `R2_*` (ou teste antes de configurá-las) e confirme que o upload de fotos continua funcionando normalmente — só que salvando em base64 no banco, como antes.
5. **PostgreSQL só com URLs**: depois de configurar o R2 e subir uma foto nova, olhe a peça salva (`GET /api/state` autenticado, ou o próprio painel) e confirme que o campo `image` é uma URL `https://...`, não um `data:image/...` gigante.



Abra `loja.html` e edite a linha `const WHATS_NUMBER = '';` perto do fim do arquivo, colocando o número completo com DDI e DDD (ex: `5599999999999`). Sem isso, o botão "WhatsApp" abre sem número pré-preenchido.

## Railway + PostgreSQL

1. Crie um projeto no Railway.
2. Adicione um serviço PostgreSQL.
3. Adicione este repositório/projeto como serviço Node.js.
4. Garanta que a variável `DATABASE_URL` do PostgreSQL e a variável `ADMIN_PASSWORD` estejam disponíveis no serviço do site. As 5 variáveis `R2_*` são opcionais (veja a seção "Fotos e vídeos: Cloudflare R2" acima).
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
