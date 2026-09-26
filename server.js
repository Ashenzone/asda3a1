const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '20mb' }));

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const localFile = path.join(__dirname, 'data.json');
const DEFAULT_CATEGORY_ID = 'cat-vendas-entregar';

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

let pgPool = null;
const DEFAULT_ANIMATIONS = {
  preset: 'padrao',
  enabled: true,
  loadingScreen: false,
  assemblyIntro: false,
  assemblyImage: null,
  cardStagger: true,
  hoverTilt: false,
  parallax: false,
  shine: false,
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
  // aceita a imagem de montagem só se for mesmo uma data URI de imagem e não passar de ~4.5MB em base64
  const img = typeof a.assemblyImage === 'string' && a.assemblyImage.startsWith('data:image/') && a.assemblyImage.length < 4_500_000
    ? a.assemblyImage
    : null;
  return {
    preset: presets.includes(a.preset) ? a.preset : DEFAULT_ANIMATIONS.preset,
    enabled: bool(a.enabled, DEFAULT_ANIMATIONS.enabled),
    loadingScreen: bool(a.loadingScreen, DEFAULT_ANIMATIONS.loadingScreen),
    assemblyIntro: bool(a.assemblyIntro, DEFAULT_ANIMATIONS.assemblyIntro),
    assemblyImage: img,
    cardStagger: bool(a.cardStagger, DEFAULT_ANIMATIONS.cardStagger),
    hoverTilt: bool(a.hoverTilt, DEFAULT_ANIMATIONS.hoverTilt),
    parallax: bool(a.parallax, DEFAULT_ANIMATIONS.parallax),
    shine: bool(a.shine, DEFAULT_ANIMATIONS.shine),
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
        return res.json({ok:true,changes:events.length});
      }catch(e){ await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    }
    const events=diffAndHistory(localState.categories,categories,localState.items,items,email);
    localState.categories=categories; localState.items=items; localState.history.unshift(...events); localState.history=localState.history.slice(0,2000); saveLocal();
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
    if(pgPool) await pgPool.query('UPDATE app_settings SET data=$1, updated_at=NOW() WHERE id=1',[JSON.stringify(data)]);
    else { localState.settings = data; saveLocal(); }
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
