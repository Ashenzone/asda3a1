const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '20mb' }));

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const localFile = path.join(__dirname, 'data.json');
const DEFAULT_CATEGORY_ID = 'cat-vendas-entregar';

/* =========================================================
   CLOUDFLARE R2 — armazenamento de arquivos pesados
   (fotos, foto do cliente, vídeo/foto de montagem do loading)
   O PostgreSQL continua guardando só texto/números/URLs.
   Se as variáveis do R2 não estiverem configuradas, o sistema
   continua funcionando como antes (guarda a imagem/vídeo direto
   no banco) — nada quebra enquanto o R2 não é configurado.
   ========================================================= */
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME;
const R2_PUBLIC_URL = (process.env.R2_PUBLIC_URL || '').replace(/\/+$/, ''); // sem barra no final

const R2_ENABLED = !!(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET_NAME && R2_PUBLIC_URL);

let s3Client = null;
if(R2_ENABLED){
  const { S3Client } = require('@aws-sdk/client-s3');
  s3Client = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY }
  });
  console.log('Cloudflare R2 configurado — novos uploads de mídia vão para o bucket', R2_BUCKET_NAME);
} else {
  console.log('Aviso: variáveis do R2 não configuradas. Uploads de mídia continuam sendo salvos direto no banco (modo antigo) até o R2 ser configurado.');
}

// Tipos aceitos e seus "números mágicos" (assinatura real dos bytes), para não
// confiar só na extensão/Content-Type que o navegador informou.
const MAGIC_SIGNATURES = [
  { mime: 'image/jpeg', bytes: [0xFF, 0xD8, 0xFF] },
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] },
  { mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46], offsetCheck: (buf) => buf.slice(8, 12).toString('ascii') === 'WEBP' },
  { mime: 'video/mp4', bytes: [], offsetCheck: (buf) => buf.slice(4, 8).toString('ascii') === 'ftyp' },
  { mime: 'video/webm', bytes: [0x1A, 0x45, 0xDF, 0xA3] },
];
function sniffMime(buffer){
  for(const sig of MAGIC_SIGNATURES){
    const matchesBytes = sig.bytes.length === 0 || sig.bytes.every((b, i) => buffer[i] === b);
    const matchesOffset = !sig.offsetCheck || sig.offsetCheck(buffer);
    if(matchesBytes && matchesOffset) return sig.mime;
  }
  return null;
}

function parseDataUri(dataUri){
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUri || '');
  if(!m) return null;
  return { declaredMime: m[1], buffer: Buffer.from(m[2], 'base64') };
}

const MAX_UPLOAD_BYTES = { image: 6 * 1024 * 1024, video: 9 * 1024 * 1024 };
const EXT_BY_MIME = { 'image/jpeg':'jpg', 'image/png':'png', 'image/gif':'gif', 'image/webp':'webp', 'video/mp4':'mp4', 'video/webm':'webm' };
const ALLOWED_FOLDERS = { products:'products', 'client-photos':'products', 'site-intro':'site/intro', videos:'videos' };

async function uploadToR2(buffer, mime, folderKey){
  const folder = ALLOWED_FOLDERS[folderKey] || 'misc';
  const ext = EXT_BY_MIME[mime] || 'bin';
  // nome de arquivo único e sem qualquer dado vindo do cliente, evitando path traversal ou nomes maliciosos
  const key = `${folder}/${Date.now().toString(36)}-${crypto.randomBytes(10).toString('hex')}.${ext}`;
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  await s3Client.send(new PutObjectCommand({
    Bucket: R2_BUCKET_NAME, Key: key, Body: buffer, ContentType: mime, CacheControl: 'public, max-age=31536000, immutable'
  }));
  return `${R2_PUBLIC_URL}/${key}`;
}

function r2KeyFromUrl(url){
  if(!R2_ENABLED || typeof url !== 'string' || !url.startsWith(R2_PUBLIC_URL + '/')) return null;
  return url.slice(R2_PUBLIC_URL.length + 1);
}

async function deleteFromR2IfHosted(url){
  const key = r2KeyFromUrl(url);
  if(!key) return; // não é uma URL do nosso R2 (pode ser data: antiga, ou vazia) — não mexe
  try{
    const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
    await s3Client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }));
  }catch(err){
    console.warn('Aviso: não foi possível remover do R2 o arquivo', key, err.message);
  }
}

/* =========================================================
   AUTENTICAÇÃO DO ADMIN (JR IMPORTADOS)
   Login por senha única (ADMIN_PASSWORD no Railway). Gera um
   token em memória que o painel guarda e envia em cada chamada.
   ========================================================= */
const adminTokens = new Map(); // token -> timestamp de criação
const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 dias

function issueToken(){
  const token = require('crypto').randomBytes(32).toString('hex');
  adminTokens.set(token, Date.now());
  return token;
}
function isValidToken(token){
  if(!token) return false;
  const created = adminTokens.get(token);
  if(!created) return false;
  if(Date.now() - created > TOKEN_TTL_MS){ adminTokens.delete(token); return false; }
  return true;
}
function requireAdmin(req, res, next){
  const header = req.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if(!isValidToken(token)) return res.status(401).json({ error:'Sessão inválida ou expirada. Faça login novamente.' });
  next();
}

app.post('/api/admin/login', (req, res) => {
  if(!ADMIN_PASSWORD){
    return res.status(503).json({ error:'Login ainda não configurado. Defina ADMIN_PASSWORD no servidor.' });
  }
  const senha = String(req.body?.password || '');
  if(senha !== ADMIN_PASSWORD){
    return res.status(401).json({ error:'Senha incorreta.' });
  }
  res.json({ ok:true, token: issueToken() });
});

// Confirmação extra de senha para ações destrutivas (ex: "Limpar todos os dados").
// Exige uma sessão de admin já válida (requireAdmin) E a senha digitada de novo.
app.post('/api/admin/verify-password', requireAdmin, (req, res) => {
  if(!ADMIN_PASSWORD){
    return res.status(503).json({ error:'Senha não configurada no servidor.' });
  }
  const senha = String(req.body?.password || '');
  if(senha !== ADMIN_PASSWORD){
    return res.status(401).json({ error:'Senha incorreta.' });
  }
  res.json({ ok:true });
});

/* =========================================================
   UPLOAD DE MÍDIA (fotos, vídeos) — vai para o Cloudflare R2
   quando configurado; senão, devolve a própria imagem em base64
   (comportamento antigo), pra nunca travar o painel.
   Só admin autenticado pode chamar essa rota.
   ========================================================= */
app.post('/api/admin/upload', requireAdmin, async (req, res) => {
  try{
    const { dataUri, folder } = req.body || {};
    const parsed = parseDataUri(dataUri);
    if(!parsed) return res.status(400).json({ error:'Arquivo inválido.' });

    const realMime = sniffMime(parsed.buffer);
    if(!realMime) return res.status(400).json({ error:'Formato de arquivo não reconhecido ou não suportado.' });

    const isVideo = realMime.startsWith('video/');
    const maxBytes = isVideo ? MAX_UPLOAD_BYTES.video : MAX_UPLOAD_BYTES.image;
    if(parsed.buffer.length > maxBytes){
      return res.status(413).json({ error:`Arquivo muito grande (máximo ${Math.round(maxBytes/1024/1024)}MB).` });
    }

    if(!R2_ENABLED){
      // R2 ainda não configurado: mantém o comportamento antigo (base64 direto),
      // reconstruindo a data URI já validada, com o mime real detectado.
      return res.json({ url: `data:${realMime};base64,${parsed.buffer.toString('base64')}`, storedIn:'database' });
    }

    const folderKey = ALLOWED_FOLDERS[folder] ? folder : 'products';
    const url = await uploadToR2(parsed.buffer, realMime, folderKey);
    res.json({ url, storedIn:'r2' });
  }catch(e){
    console.error('Erro no upload de mídia:', e);
    res.status(500).json({ error:'Erro ao enviar o arquivo.' });
  }
});

let pgPool = null;
const DEFAULT_ANIMATIONS = {
  preset: 'padrao',
  enabled: true,
  loadingScreen: false,
  assemblyIntro: false,
  assemblyImage: null,
  assemblyVideo: null,
  cardStagger: true,
  hoverTilt: false,
  parallax: false,
  shine: false,
  neon: false,
  speed: 1,
  intensity: 1
};
function sanitizeAnimations(input){
  const a = (input && typeof input === 'object') ? input : {};
  const bool = (v, fallback) => typeof v === 'boolean' ? v : fallback;
  const clamp = (v, min, max, fallback) => {
    const n = Number(v);
    if(!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  };
  const presets = ['padrao','elegante','premium','cinematico','ultra','minimalista','personalizado'];
  // aceita a imagem/vídeo de montagem só se forem mesmo uma data URI do tipo certo e dentro de um tamanho razoável
  const img = typeof a.assemblyImage === 'string' && a.assemblyImage.startsWith('data:image/') && a.assemblyImage.length < 4_500_000
    ? a.assemblyImage
    : null;
  const vid = typeof a.assemblyVideo === 'string' && a.assemblyVideo.startsWith('data:video/') && a.assemblyVideo.length < 9_000_000
    ? a.assemblyVideo
    : null;
  return {
    preset: presets.includes(a.preset) ? a.preset : DEFAULT_ANIMATIONS.preset,
    enabled: bool(a.enabled, DEFAULT_ANIMATIONS.enabled),
    loadingScreen: bool(a.loadingScreen, DEFAULT_ANIMATIONS.loadingScreen),
    assemblyIntro: bool(a.assemblyIntro, DEFAULT_ANIMATIONS.assemblyIntro),
    assemblyImage: img,
    assemblyVideo: vid,
    cardStagger: bool(a.cardStagger, DEFAULT_ANIMATIONS.cardStagger),
    hoverTilt: bool(a.hoverTilt, DEFAULT_ANIMATIONS.hoverTilt),
    parallax: bool(a.parallax, DEFAULT_ANIMATIONS.parallax),
    shine: bool(a.shine, DEFAULT_ANIMATIONS.shine),
    neon: bool(a.neon, DEFAULT_ANIMATIONS.neon),
    speed: clamp(a.speed, 0.4, 2, DEFAULT_ANIMATIONS.speed),
    intensity: clamp(a.intensity, 0.4, 2, DEFAULT_ANIMATIONS.intensity)
  };
}
const DEFAULT_SETTINGS = { theme:'padrao', customColor:'#B08D57', storeMode:'animado', animations: DEFAULT_ANIMATIONS };

let localState = { categories: [], items: [], history: [], blockedEmails: [], settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) };

/* Gera uma imagem de exemplo (gradiente + marca "JR") em SVG, sem depender
   de internet — usada só nas peças de demonstração criadas no primeiro
   uso do sistema, para o admin ver como as animações da loja ficam. */
function demoImage(c1, c2){
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="500">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/>
</linearGradient></defs>
<rect width="400" height="500" fill="url(#g)"/>
<circle cx="200" cy="220" r="70" fill="#ffffff" fill-opacity="0.18"/>
<text x="200" y="460" font-family="Georgia,serif" font-size="26" fill="#ffffff" fill-opacity="0.85" text-anchor="middle">JR IMPORTADOS</text>
</svg>`;
  return 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
}

function defaultState(){
  const catRoupas = 'cat-exemplo-roupas';
  const catCalcados = 'cat-exemplo-calcados';
  const catAcessorios = 'cat-exemplo-acessorios';
  const now = Date.now();
  const categories = [
    { id: DEFAULT_CATEGORY_ID, name: 'Vendas para Entregar', createdAt: now },
    { id: catRoupas, name: 'Roupas', createdAt: now },
    { id: catCalcados, name: 'Calçados', createdAt: now },
    { id: catAcessorios, name: 'Acessórios', createdAt: now },
  ];
  const mk = (id, categoryId, name, description, value, image, tags) => ({
    id, categoryId, originCategoryId: categoryId,
    name, description, value, quantity: 1,
    image, status: 'in_category', delivery: null,
    visibleToClient: true, clientImage: null,
    tagTrending: !!tags.trending, tagFeatured: !!tags.featured, tagLowStock: !!tags.lowStock
  });
  const items = [
    mk('item-exemplo-1', catRoupas, 'Vestido Floral Premium', 'Peça de exemplo — pode excluir quando quiser.', 289.9, demoImage('#C9A24B','#E7D19C'), { trending:true, featured:true }),
    mk('item-exemplo-2', catRoupas, 'Jaqueta Jeans Classic', 'Peça de exemplo — pode excluir quando quiser.', 219.5, demoImage('#8A8578','#EDEDED'), { lowStock:true }),
    mk('item-exemplo-3', catCalcados, 'Tênis Branco Urbano', 'Peça de exemplo — pode excluir quando quiser.', 349.0, demoImage('#A9812F','#F3E6C4'), { trending:true }),
    mk('item-exemplo-4', catAcessorios, 'Bolsa Dourada Elegance', 'Peça de exemplo — pode excluir quando quiser.', 459.9, demoImage('#C6C6C6','#FFFFFF'), { featured:true }),
    mk('item-exemplo-5', catAcessorios, 'Óculos de Sol Metal', 'Peça de exemplo — pode excluir quando quiser.', 159.0, demoImage('#B08D57','#3A2F1E'), {}),
    mk('item-exemplo-6', catCalcados, 'Relógio Prata Minimal', 'Peça de exemplo — pode excluir quando quiser.', 529.0, demoImage('#D9C08B','#FFF6E5'), { lowStock:true, featured:true }),
  ];
  return { categories, items };
}

async function initDb(){
  if(DATABASE_URL){
    const { Pool } = require('pg');
    pgPool = new Pool({ connectionString:DATABASE_URL, ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized:false } });
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS store_state (
        id INTEGER PRIMARY KEY,
        categories JSONB NOT NULL,
        items JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS audit_history (
        id BIGSERIAL PRIMARY KEY,
        admin_email TEXT,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT,
        entity_name TEXT,
        old_data JSONB,
        new_data JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS blocked_emails (
        email TEXT PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    const r = await pgPool.query('SELECT id FROM store_state WHERE id=1');
    if(!r.rowCount){ const d=defaultState(); await pgPool.query('INSERT INTO store_state(id,categories,items) VALUES(1,$1,$2)',[JSON.stringify(d.categories),JSON.stringify(d.items)]); }
    // A tabela de aparência (tema) fica isolada num try/catch próprio: se por
    // qualquer motivo essa parte falhar, o salvamento de categorias/peças
    // (o mais importante) continua funcionando normalmente.
    try{
      await pgPool.query(`
        CREATE TABLE IF NOT EXISTS app_settings (
          id INTEGER PRIMARY KEY,
          data JSONB NOT NULL DEFAULT '{}'::jsonb,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      const rs = await pgPool.query('SELECT id FROM app_settings WHERE id=1');
      if(!rs.rowCount){ await pgPool.query('INSERT INTO app_settings(id,data) VALUES(1,$1)',[JSON.stringify(DEFAULT_SETTINGS)]); }
    }catch(settingsErr){
      console.error('Aviso: não foi possível preparar a tabela de aparência (app_settings). O restante do sistema continua funcionando normalmente.', settingsErr);
    }
    console.log('PostgreSQL conectado.');
  } else {
    try { localState = JSON.parse(fs.readFileSync(localFile,'utf8')); } catch { localState={...defaultState(),history:[],blockedEmails:[],settings:{theme:'padrao',customColor:'#B08D57'}}; saveLocal(); }
    if(!Array.isArray(localState.categories) || !localState.categories.length) localState.categories=defaultState().categories;
    if(!Array.isArray(localState.items)) localState.items=[];
    if(!Array.isArray(localState.history)) localState.history=[];
    if(!Array.isArray(localState.blockedEmails)) localState.blockedEmails=[];
    if(!localState.settings || typeof localState.settings !== 'object') localState.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    else if(!localState.settings.animations) localState.settings.animations = JSON.parse(JSON.stringify(DEFAULT_ANIMATIONS));
    saveLocal();
    console.log('Sem DATABASE_URL: usando data.json apenas para testes locais.');
  }
}
function saveLocal(){ fs.writeFileSync(localFile, JSON.stringify(localState,null,2)); }
function adminEmail(req){ return String(req.get('X-Admin-Email') || 'Administrador').trim().toLowerCase().slice(0,255); }
function mapById(arr){ return new Map((arr||[]).map(x=>[String(x.id),x])); }

function diffAndHistory(oldCats, newCats, oldItems, newItems, email){
  const events=[];
  for(const [id,n] of mapById(newCats)){
    const o=mapById(oldCats).get(id);
    if(!o) events.push({action:'CRIADO',type:'categoria',id,name:n.name,old:null,new:n});
    else if(JSON.stringify(o)!==JSON.stringify(n)) events.push({action:'ALTERADO',type:'categoria',id,name:n.name,old:o,new:n});
  }
  for(const [id,o] of mapById(oldCats)) if(!mapById(newCats).has(id)) events.push({action:'EXCLUÍDO',type:'categoria',id,name:o.name,old:o,new:null});
  for(const [id,n] of mapById(newItems)){
    const o=mapById(oldItems).get(id);
    if(!o) events.push({action:'CRIADO',type:'peça',id,name:n.name,old:null,new:n});
    else if(JSON.stringify(o)!==JSON.stringify(n)) events.push({action:'ALTERADO',type:'peça',id,name:n.name,old:o,new:n});
  }
  for(const [id,o] of mapById(oldItems)) if(!mapById(newItems).has(id)) events.push({action:'EXCLUÍDO',type:'peça',id,name:o.name,old:o,new:null});
  return events.map(e=>({...e,admin_email:email,created_at:new Date().toISOString()}));
}

/* Depois de salvar, apaga do R2 as fotos que ficaram órfãs (peça excluída ou
   foto trocada por outra) — só se não estiverem mais em uso por nenhuma peça.
   Roda em segundo plano (não atrasa nem arrisca a resposta ao admin). */
function cleanupOrphanedMedia(events, newItems){
  if(!R2_ENABLED) return;
  try{
    const stillInUse = new Set();
    for(const it of newItems || []){
      if(it.image) stillInUse.add(it.image);
      if(it.clientImage) stillInUse.add(it.clientImage);
    }
    const candidates = new Set();
    for(const e of events){
      if(e.type !== 'peça') continue;
      if(e.action === 'EXCLUÍDO' && e.old){
        if(e.old.image) candidates.add(e.old.image);
        if(e.old.clientImage) candidates.add(e.old.clientImage);
      } else if(e.action === 'ALTERADO' && e.old && e.new){
        if(e.old.image && e.old.image !== e.new.image) candidates.add(e.old.image);
        if(e.old.clientImage && e.old.clientImage !== e.new.clientImage) candidates.add(e.old.clientImage);
      }
    }
    for(const url of candidates){
      if(!stillInUse.has(url)) deleteFromR2IfHosted(url);
    }
  }catch(err){
    console.warn('Aviso: falha ao verificar mídias órfãs no R2', err.message);
  }
}

app.get('/api/state', requireAdmin, async (req,res)=>{
  try{
    if(pgPool){ const r=await pgPool.query('SELECT categories,items FROM store_state WHERE id=1'); return res.json(r.rows[0]); }
    return res.json({categories:localState.categories,items:localState.items});
  }catch(e){ console.error(e); res.status(500).json({error:'Erro ao carregar dados'}); }
});

app.put('/api/state', requireAdmin, async (req,res)=>{
  try{
    const categories=Array.isArray(req.body.categories)?req.body.categories:[];
    const items=Array.isArray(req.body.items)?req.body.items:[];
    const email=adminEmail(req);
    if(pgPool){
      const client=await pgPool.connect();
      try{
        await client.query('BEGIN');
        const r=await client.query('SELECT categories,items FROM store_state WHERE id=1 FOR UPDATE');
        const old=r.rows[0] || {categories:[],items:[]};
        const events=diffAndHistory(old.categories, categories, old.items, items, email);
        await client.query('UPDATE store_state SET categories=$1,items=$2,updated_at=NOW() WHERE id=1',[JSON.stringify(categories),JSON.stringify(items)]);
        for(const e of events) await client.query('INSERT INTO audit_history(admin_email,action,entity_type,entity_id,entity_name,old_data,new_data,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[e.admin_email,e.action,e.type,e.id,e.name,e.old?JSON.stringify(e.old):null,e.new?JSON.stringify(e.new):null,e.created_at]);
        await client.query('COMMIT');
        cleanupOrphanedMedia(events, items);
        return res.json({ok:true,changes:events.length});
      }catch(e){ await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    }
    const events=diffAndHistory(localState.categories,categories,localState.items,items,email);
    localState.categories=categories; localState.items=items; localState.history.unshift(...events); localState.history=localState.history.slice(0,2000); saveLocal();
    cleanupOrphanedMedia(events, items);
    res.json({ok:true,changes:events.length});
  }catch(e){ console.error(e); res.status(500).json({error:'Erro ao salvar no banco'}); }
});

app.get('/api/history', requireAdmin, async (req,res)=>{
  try{
    const limit=Math.min(Math.max(parseInt(req.query.limit)||100,1),500);
    if(pgPool){ const r=await pgPool.query('SELECT id,admin_email,action,entity_type,entity_id,entity_name,old_data,new_data,created_at FROM audit_history ORDER BY id DESC LIMIT $1',[limit]); return res.json({history:r.rows}); }
    return res.json({history:localState.history.slice(0,limit)});
  }catch(e){ console.error(e); res.status(500).json({error:'Erro ao carregar histórico'}); }
});

app.get('/api/blocked-emails', requireAdmin, async (req,res)=>{
  try{
    if(pgPool){ const r=await pgPool.query('SELECT email FROM blocked_emails ORDER BY email'); return res.json({emails:r.rows.map(x=>x.email)}); }
    res.json({emails:localState.blockedEmails});
  }catch(e){ res.status(500).json({error:'Erro ao carregar bloqueios'}); }
});
app.put('/api/blocked-emails', requireAdmin, async (req,res)=>{
  try{
    const emails=[...new Set((Array.isArray(req.body.emails)?req.body.emails:[]).map(e=>String(e).trim().toLowerCase()).filter(Boolean))];
    if(pgPool){ await pgPool.query('DELETE FROM blocked_emails'); for(const email of emails) await pgPool.query('INSERT INTO blocked_emails(email) VALUES($1) ON CONFLICT DO NOTHING',[email]); }
    else { localState.blockedEmails=emails; saveLocal(); }
    res.json({ok:true,emails});
  }catch(e){ res.status(500).json({error:'Erro ao salvar bloqueios'}); }
});
app.post('/api/blocked-emails', requireAdmin, async (req,res)=>{
  try{
    const email=String(req.body.email||'').trim().toLowerCase();
    if(!email || !email.includes('@')) return res.status(400).json({error:'E-mail inválido'});
    if(pgPool) await pgPool.query('INSERT INTO blocked_emails(email) VALUES($1) ON CONFLICT DO NOTHING',[email]);
    else { if(!localState.blockedEmails.includes(email)) localState.blockedEmails.push(email); saveLocal(); }
    res.json({ok:true});
  }catch(e){ res.status(500).json({error:'Erro ao bloquear e-mail'}); }
});

app.get('/api/settings', requireAdmin, async (req,res)=>{
  try{
    if(pgPool){ const r=await pgPool.query('SELECT data FROM app_settings WHERE id=1'); return res.json(r.rows[0]?.data || DEFAULT_SETTINGS); }
    res.json(localState.settings || DEFAULT_SETTINGS);
  }catch(e){ res.status(500).json({error:'Erro ao carregar configurações'}); }
});
app.put('/api/settings', requireAdmin, async (req,res)=>{
  try{
    const data = {
      theme: String(req.body.theme || 'padrao'),
      customColor: String(req.body.customColor || '#B08D57'),
      storeMode: ['padrao','animado','minimalista'].includes(req.body.storeMode) ? req.body.storeMode : 'animado',
      animations: sanitizeAnimations(req.body.animations)
    };
    let oldAnimations = null;
    if(pgPool){
      const prev = await pgPool.query('SELECT data FROM app_settings WHERE id=1');
      oldAnimations = prev.rows[0]?.data?.animations || null;
      await pgPool.query('UPDATE app_settings SET data=$1, updated_at=NOW() WHERE id=1',[JSON.stringify(data)]);
    } else {
      oldAnimations = localState.settings?.animations || null;
      localState.settings = data; saveLocal();
    }
    // se a foto/vídeo de montagem foi trocado ou removido, limpa a versão antiga do R2
    if(oldAnimations){
      if(oldAnimations.assemblyImage && oldAnimations.assemblyImage !== data.animations.assemblyImage) deleteFromR2IfHosted(oldAnimations.assemblyImage);
      if(oldAnimations.assemblyVideo && oldAnimations.assemblyVideo !== data.animations.assemblyVideo) deleteFromR2IfHosted(oldAnimations.assemblyVideo);
    }
    res.json({ok:true, ...data});
  }catch(e){ res.status(500).json({error:'Erro ao salvar configurações'}); }
});

/* =========================================================
   LOJA PÚBLICA — JR IMPORTADOS
   Só devolve as peças que o admin marcou como visíveis para o
   cliente, com a imagem escolhida (foto própria do cliente ou,
   se não houver, a imagem normal já cadastrada da peça).
   ========================================================= */
app.get('/api/store', async (req,res)=>{
  try{
    let categories, items, settings;
    if(pgPool){
      const r = await pgPool.query('SELECT categories,items FROM store_state WHERE id=1');
      categories = r.rows[0]?.categories || [];
      items = r.rows[0]?.items || [];
      try{
        const rs = await pgPool.query('SELECT data FROM app_settings WHERE id=1');
        settings = rs.rows[0]?.data || {};
      }catch{ settings = {}; }
    } else {
      categories = localState.categories;
      items = localState.items;
      settings = localState.settings || {};
    }
    const visible = (items||[])
      .filter(it => it.visibleToClient && it.status === 'in_category')
      .map(it => ({
        id: it.id,
        categoryId: it.categoryId,
        name: it.clientName || it.name,
        description: it.clientDescription || it.description || '',
        value: it.value,
        image: it.clientImage || it.image || null,
        trending: !!it.tagTrending,
        featured: !!it.tagFeatured,
        lowStock: !!it.tagLowStock
      }));
    const catsInUse = (categories||[]).filter(c => visible.some(it => it.categoryId === c.id));
    res.json({
      storeName: 'JR IMPORTADOS',
      storeMode: ['padrao','animado','minimalista'].includes(settings.storeMode) ? settings.storeMode : 'animado',
      animations: sanitizeAnimations(settings.animations),
      categories: catsInUse,
      items: visible
    });
  }catch(e){ console.error(e); res.status(500).json({error:'Erro ao carregar a loja'}); }
});

app.use(express.static(__dirname, { extensions:['html'], index:false }));

app.get('/admin', (req,res)=> res.sendFile(path.join(__dirname,'index.html')));
app.get('/', (req,res)=> res.sendFile(path.join(__dirname,'loja.html')));
app.get(/.*/,(req,res)=>{
  if(req.path.startsWith('/api/')) return res.status(404).json({error:'Rota não encontrada'});
  if(req.path.startsWith('/admin')) return res.sendFile(path.join(__dirname,'index.html'));
  res.sendFile(path.join(__dirname,'loja.html'));
});

initDb().then(()=>app.listen(PORT,()=>console.log(`Servidor JR IMPORTADOS rodando na porta ${PORT}`))).catch(err=>{console.error('Falha ao iniciar:',err);process.exit(1);});
