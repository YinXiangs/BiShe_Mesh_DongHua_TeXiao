import './style.css';
import './dark.css';
import './access.css';
import { ReviewViewer } from './viewer.js';
import { PREVIEW_REVISION } from './material-preview.js';
import { buildReviewRecord, formatReviewRecordText } from './review-records.js';
import { db } from './local-db.js';
import { validateFiles } from './validation.js';
import { createSharedApi, planLegacyVersions } from './shared-api.js';
import { generateMediaThumbnail } from './thumbnails.js';
import { readPreview, writePreview, validPreview } from './preview-cache.js';
import { readEntrySession, saveEntrySession, clearEntrySession, submissionAllowed, reviewAllowed } from './access.js';
import { zipSync } from 'fflate';

const CATS={all:'全部作品',scene:'场景建模',character:'角色建模',product:'产品建模',animation:'游戏动画',vfx:'游戏特效'};
const STATUS={pending:'制作中',review:'待检查',changes:'待修改',approved:'已通过'};
const DIM={general:'整体建议',topology:'面数与拓扑',material:'材质贴图',structure:'模型结构',normals:'法向检查',animation:'动画表现',vfx:'特效表现'};
const icons={grid:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',scene:'M3 21V7l8-4v18 M11 10l10-4v15 M6 9v2 M6 14v2 M15 11v2 M18 10v2 M15 16v2 M18 15v2',character:'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M4 21v-2a8 8 0 0 1 16 0v2',product:'M12 3l9 5-9 5-9-5z M3 8v9l9 5 9-5V8 M12 13v9',animation:'M4 4h16v16H4z M4 9h16 M8 4v5 M16 4v5 M10 12l5 3-5 3z',vfx:'M12 3l2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z',plus:'M12 5v14 M5 12h14',search:'M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',mail:'M3 5h18v14H3z M3 5l9 8 9-8',check:'M5 12l4 4L19 6',clock:'M12 8v5l3 2 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',chat:'M21 11a8 8 0 0 1-8 8H7l-5 3V11a9 9 0 0 1 19 0',upload:'M12 16V3 M7 8l5-5 5 5 M4 15v6h16v-6',arrow:'M5 12h14 M14 7l5 5-5 5',settings:'M4 6h16 M4 12h16 M4 18h16 M8 3v6 M16 9v6 M10 15v6',close:'M6 6l12 12 M18 6L6 18',link:'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2 M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2'};
const ico=(n)=>'<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="'+(icons[n]||icons.grid)+'"/></svg>';
const esc=(v)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid=()=>crypto.randomUUID();
const fmt=n=>Number(n||0).toLocaleString('zh-CN');
const date=s=>new Date(s).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
const size=n=>n>=1048576?(n/1048576).toFixed(1)+' MB':Math.ceil(n/1024)+' KB';
const demoSpecs=[['scene','邮局主建筑','木屋、门廊与信件投递区','review'],['character','森林邮差','角色比例与服装层次','pending'],['product','林间邮筒','投信口、门板与金属细节','approved'],['animation','信使飞行循环','动作节奏与循环衔接','changes'],['scene','山谷投递站','环境空间与场景搭建','pending'],['vfx','邮戳光效','MP4 特效视频提交入口','review']];
const DEMOS=demoSpecs.map(([category,title,description,status],i)=>({id:'demo-'+i,category,title,description,status,demo:true,created_at:new Date().toISOString()}));
const state={assets:[],category:'all',status:'all',query:'',mode:'cloud',demo:false,cloud:null,role:null,config:{githubRepo:'YinXiangs/BiShe_Mesh_DongHua_TeXiao'},deployedConfig:null,accessError:null,shared:null,token:null,selected:null,versions:[],comments:[],files:[],viewer:null,video:null,version:null,serviceReady:false,booting:true,assetsReady:false,legacyAssets:[],migrationBusy:false};
const app=document.querySelector('#app');
state.entryRole=null;
let toastTimer, loadSerial=0, feedbackMutationSerial=0, feedbackWrites=0;
let previewObserver,previewQueue=Promise.resolve();
const assetPreviews=new Map();
function toast(message){const el=document.querySelector('#toast');el.textContent=message;el.classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('visible'),5500);}
const run=fn=>async(...args)=>{try{return await fn(...args);}catch(e){console.error(e);toast(e.message||'操作失败，请稍后重试。');}};
function postalArt(kind='scene'){
  const colors={scene:'#243a30',character:'#39352c',product:'#223b34',animation:'#30392d',vfx:'#342d40'},bg=colors[kind]||colors.scene;
  let shape='';
  if(kind==='product')shape='<path d="M111 143h94v67h-94z" fill="#28483c"/><path d="M119 79a39 39 0 0 1 78 0v104h-78z" fill="#507761"/><path d="M130 104h56v7h-56z" fill="#1f3d34"/><path d="M132 135h52v39h-52z" fill="#e4cc9e"/><path d="M140 146h36l-18 14z" fill="#c8784e"/><circle cx="180" cy="164" r="3" fill="#28483c"/>';
  else if(kind==='character')shape='<ellipse cx="158" cy="76" rx="24" ry="28" fill="#e6cba4"/><path d="M124 63h70l-12-19h-46z" fill="#365c49"/><path d="M137 100l-18 77 39 11 39-11-18-77z" fill="#426853"/><path d="M139 178v34h15v-32 M164 180v32h15v-34" fill="#344c40"/><path d="M179 123l24 7-6 37-28-7z" fill="#ac794e"/><path d="M143 105l38 54" stroke="#d5ae74" stroke-width="6"/>';
  else if(kind==='animation')shape='<path d="M57 138q68-101 106-23 56-46 111-5-68 6-111 42-63 53-106-14z" fill="#52775f"/><ellipse cx="161" cy="140" rx="32" ry="23" fill="#f2e4c6"/><path d="M188 134l26 9-28 7" fill="#c98050"/><path d="M45 189q86-60 167-8" fill="none" stroke="#a0b09a" stroke-dasharray="6 8" stroke-width="2"/>';
  else if(kind==='vfx')shape='<g fill="none" stroke="#ac8bba"><circle cx="158" cy="128" r="62" stroke-width="2"/><circle cx="158" cy="128" r="48" stroke-dasharray="3 6" stroke-width="6"/><path d="M99 128h118 M158 69v118"/></g><path d="M158 84l13 31 33 13-33 13-13 31-13-31-33-13 33-13z" fill="#b897c9"/><circle cx="158" cy="128" r="17" fill="#ede2f1"/>';
  else shape='<path d="M67 170l87-44 97 43-88 46z" fill="#b6c5a7"/><path d="M99 119l62-33 67 33v59l-67 32-62-31z" fill="#d9bb86"/><path d="M161 86v124l67-32v-59z" fill="#bc9b6b"/><path d="M83 120l79-69 81 64-82 42z" fill="#a76349"/><path d="M83 120l78 37v12l-78-36z" fill="#854833"/><path d="M179 139l25-11v58l-25 12z" fill="#365a47"/><path d="M114 143l23 11v24l-23-12z" fill="#58715b"/><path d="M210 78v-25l18 9v30" fill="#52634d"/><path d="M63 178v-47 M48 143l15-29 15 29z" fill="#41644d"/>';
  return '<svg viewBox="0 0 320 250" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect width="320" height="250" fill="'+bg+'"/><circle cx="257" cy="53" r="24" fill="#fff" opacity=".28"/><ellipse cx="162" cy="213" rx="100" ry="13" fill="#25483e" opacity=".08"/>'+shape+'</svg>';
}
async function refresh(){
  if(!state.entryRole){renderAccess();return;}
  assetPreviews.clear();previewObserver?.disconnect();
  state.accessError=null;
  try{
    if(!state.serviceReady||!state.cloud)throw Error('共享服务尚未连接，不能读取作品；请稍后重试。');
    state.role=await state.cloud.role();
    if(!state.role){leaveSession();return;}
    const assets=await state.cloud.listAssets();
    if(!Array.isArray(assets))throw Error('作品列表响应异常，请稍后重试。');
    if(!state.entryRole)return;
    state.assets=assets;state.assetsReady=true;state.demo=false;state.mode='cloud';
    if(state.entryRole==='student'){try{state.legacyAssets=await findLegacyAssets();}catch{state.legacyAssets=[];}}
  }catch(error){if(!state.entryRole)return;state.accessError=error.message||'共享作品暂时无法读取。';}
  render();
}
function currentAssets(){return state.assets;}
function canEdit(){return submissionAllowed(state.entryRole,{token:state.token,mode:state.mode,cloudRole:state.role});}
function canReview(){return reviewAllowed(state.entryRole,{token:state.token,mode:state.mode,cloudRole:state.role});}
function requireStudent(){if(readEntrySession()!=='student'||!canEdit())throw Error('学生身份才能提交、修改或删除作品。');}
function requireTeacher(){if(readEntrySession()!=='teacher'||!canReview())throw Error('老师身份才能检查作品和提交意见。');}
function renderAccess(){
 previewObserver?.disconnect();
 app.innerHTML='<main class="access-screen"><section class="access-card"><div class="access-brand">'+ico('mail')+'<span>栖息邮局</span></div><div class="access-eyebrow">QIXI POST OFFICE</div><h1>欢迎来到栖息邮局</h1><p class="access-subtitle">毕业设计作品与指导记录</p><form class="access-form"><label class="field">访问密码<input name="password" type="password" inputmode="numeric" autocomplete="off" required maxlength="64" placeholder="请输入访问密码" aria-label="访问密码"></label><p class="access-error" role="alert" aria-live="polite"></p><button class="button primary" type="submit">进入网站 '+ico('arrow')+'</button></form><p class="access-footer">让每一次反馈，成为下一步的方向。</p></section></main>';
 const form=app.querySelector('form');
 form.querySelector('button').disabled=state.booting;
 form.querySelector('.access-error').textContent=state.booting?'正在连接共享评审服务…':state.accessError||'';
 form.onsubmit=async event=>{
  event.preventDefault();const button=form.querySelector('button'),input=form.elements.password,error=form.querySelector('.access-error');button.disabled=true;error.textContent='';
  const readiness=new AbortController(),watcher=new MutationObserver(()=>{if(!form.isConnected)readiness.abort();});watcher.observe(app,{childList:true,subtree:true});
  try{
   if(!state.serviceReady||!state.cloud)throw Error(state.accessError||'共享服务尚未连接，请刷新后重试。');
   await state.cloud.ensureReady({signal:readiness.signal,onWait:()=>{if(form.isConnected){error.textContent='共享服务正在启动，请稍候…';button.textContent='正在连接共享服务…';}}});
   if(!form.isConnected)return;
   error.textContent='';button.textContent='正在登录…';
   const grant=await state.cloud.loginWithCode(input.value);input.value='';const role=grant.role;
   if(!saveEntrySession(role))throw Error('浏览器禁止保存当前会话，请允许此网站使用会话存储后重试。');
   state.entryRole=role;state.role=role==='student'?'owner':'reviewer';state.assetsReady=false;try{sessionStorage.removeItem(migrationPromptKey());}catch{}await refresh();
   if(role==='teacher'&&!state.accessError)dialog('欢迎黄静妮教授登陆网站！','<div class="welcome-panel"><div class="welcome-symbol">'+ico('mail')+'</div><h2 class="welcome-cn">欢迎黄静妮教授登陆网站！</h2><p class="welcome-en" lang="en">Welcome, Professor Huang Jingni!</p><p>期待您的指导，让每一份作品继续成长。</p><p class="help-text">作品、检查状态与意见在手机和电脑间共享。</p><button class="button primary" id="welcome-start">开始检查作品</button></div>').querySelector('#welcome-start').onclick=event=>event.target.closest('dialog').close();
   else if(role==='student')await maybePromptLegacyMigration();
  }catch(e){if(e.name!=='AbortError'){if(form.isConnected)error.textContent=e.message||'暂时无法进入，请稍后重试。';else toast(e.message);}}
  finally{watcher.disconnect();readiness.abort();button.disabled=false;if(form.isConnected)button.innerHTML='进入网站 '+ico('arrow');}
 };
}
function leaveSession({revoke=true}={}){
 if(revoke)void state.cloud?.logout().catch(()=>{});
 try{sessionStorage.removeItem(migrationPromptKey());}catch{}
 clearEntrySession();state.entryRole=null;loadSerial++;
 for(const d of document.querySelectorAll('dialog'))d.close();
 state.viewer?.destroy();state.viewer=null;if(state.video){state.video.pause();URL.revokeObjectURL(state.video.src);state.video=null;}
 state.selected=null;state.files=[];state.versions=[];state.comments=[];state.version=null;state.assets=[];state.role=null;state.assetsReady=false;state.legacyAssets=[];assetPreviews.clear();renderAccess();
}
function readMarkup(asset){
 if(asset.demo)return '';
 const preview=assetPreviews.get(previewKey(asset)),latest=asset.latest_version_id||preview?.versionId;
 const read=Boolean(latest&&asset.teacher_read_version_id===latest);
 return '<span class="read-badge '+(read?'read':'unread')+'">'+(read?'老师已读':'老师未读')+'</span>';
}
function updateReadBadges(asset){
 for(const card of app.querySelectorAll('.asset-card'))if(card.querySelector('[data-open]')?.dataset.open===asset.id){const host=card.querySelector('[data-read]');if(host)host.innerHTML=readMarkup(asset);}
}
async function markTeacherRead(asset,version){
 if(!canReview()||!version||asset.demo||version.id!==state.versions[0]?.id)return;
 requireTeacher();
 if(asset.teacher_read_version_id===version.id)return;
 try{
  const saved=await state.cloud.markRead(asset.id,version.id);
  if(!saved)return;
  Object.assign(asset,saved);updateReadBadges(asset);
 }catch(error){toast('作品已打开，但已读状态未能保存：'+error.message);}
}
async function changeReviewStatus(asset,status){
 requireTeacher();if(!['review','changes','approved'].includes(status))throw Error('请选择有效的检查状态。');
 if(state.token)throw Error('此链接暂只支持预览与评语。同步检查状态需要老师的共享账户。');
 const version=state.selected?.id===asset.id?state.version:null;
 if(!version||version.id!==state.versions[0]?.id)throw Error('请打开最新版本后设置检查状态。');
 const saved=await state.cloud.reviewAsset(asset.id,status,version.id);
 Object.assign(asset,saved);render();
 for(const dialog of document.querySelectorAll('.detail-dialog'))if(state.selected?.id===asset.id){const badge=dialog.querySelector('.viewer-toolbar > .badge');if(badge){badge.className='badge '+asset.status;badge.textContent=STATUS[asset.status];}}
}
function deleteAsset(asset,detail){
 requireStudent();
 const d=dialog('删除作品','<p>“'+esc(asset.title)+'”将移入回收站，原始文件和版本仍会保留，可以恢复。</p><div class="form-actions"><button class="button ghost" id="cancel-delete">取消</button><button class="button danger" id="confirm-delete">移入回收站</button></div>');
 d.querySelector('#cancel-delete').onclick=()=>d.close();
 d.querySelector('#confirm-delete').onclick=run(async event=>{requireStudent();event.target.disabled=true;try{await state.cloud.softDeleteAsset(asset.id);d.close();detail.close();state.mode=state.mode==='local'?'empty':state.mode;await refresh();toast('作品已移入回收站。');}finally{event.target.disabled=false;}});
}
async function recycleBin(){
 requireStudent();
 const rows=await state.cloud.listDeletedAssets();
 const d=dialog('回收站','<p class="help-text">删除的作品与原始版本保留在这里。</p>'+(rows.length?rows.map(asset=>'<div class="material-row"><div><strong>'+esc(asset.title)+'</strong><small>'+CATS[asset.category]+' · '+date(asset.deleted_at)+'</small></div><button class="button ghost small" data-restore="'+esc(asset.id)+'">恢复作品</button></div>').join(''):'<div class="empty-state"><p>回收站是空的。</p></div>'));
 d.querySelectorAll('[data-restore]').forEach(button=>button.onclick=run(async()=>{requireStudent();button.disabled=true;try{await state.cloud.restoreAsset(button.dataset.restore);d.close();await refresh();toast('作品已恢复。');}finally{button.disabled=false;}}));
}
function previewSource(){return {local:false,cloud:state.cloud,versions:null,scope:'cloud:'+(state.config.apiUrl||state.config.supabaseUrl)};}
function previewKey(asset,source=previewSource()){return source.scope+'|'+asset.id+'|'+(asset.updated_at||asset.created_at||'');}
function previewMarkup(asset){
 if(asset.demo)return postalArt(asset.category);
 const preview=assetPreviews.get(previewKey(asset));
 if(preview?.thumbnail)return '<img alt="'+esc(asset.title)+' · 最新提交预览" src="'+esc(preview.thumbnail)+'" loading="lazy">';
 if(preview?.empty)return postalArt(asset.category);
 if(preview?.error)return '<span class="preview-message">'+ico('grid')+'<span>文件已提交<br>预览暂不可用</span></span>';
 return '<span class="preview-message loading">正在生成预览…</span>';
}
function updatePreviewCard(asset,key){
 if(previewKey(asset)!==key)return;
 for(const button of app.querySelectorAll('.asset-thumb[data-open]'))if(button.dataset.open===asset.id){const host=button.querySelector('.asset-preview');if(host)host.innerHTML=previewMarkup(asset);}
 updateReadBadges(asset);
}
async function ensureAssetPreview(asset){
 const source=previewSource(),key=previewKey(asset,source);
 if(asset.demo||assetPreviews.has(key))return;
 const pending={};assetPreviews.set(key,pending);
 const job=async()=>{
 if(assetPreviews.get(key)!==pending)return;
 if(previewKey(asset)!==key){assetPreviews.delete(key);return;}
 try{
  const versions=await source.cloud.listVersions(asset.id);
  const version=[...versions].sort((a,b)=>b.number-a.number)[0];
  if(!version){pending.empty=true;return;}
  pending.versionId=version.id;
  let thumbnail=validPreview(version.stats?.thumbnail)&&(asset.category==='vfx'||version.stats?.previewRevision===PREVIEW_REVISION)?version.stats.thumbnail:await readPreview(source.scope,version.id);
  if(!thumbnail){
   const files=await source.cloud.downloadVersion(version);
   if(!files.length||files.every(file=>!file.size)){pending.empty=true;return;}
   thumbnail=(await generateMediaThumbnail(files,asset.category)).thumbnail;
   await writePreview(source.scope,version.id,thumbnail);
  }
  pending.thumbnail=thumbnail;
 }catch(error){pending.error=error.message||'无法生成预览';}
 finally{if(assetPreviews.get(key)===pending)updatePreviewCard(asset,key);}
 };
 previewQueue=previewQueue.then(job,job);
 await previewQueue;
}
function observeAssetPreviews(){
 previewObserver?.disconnect();
 const buttons=[...app.querySelectorAll('.asset-thumb[data-open]')];
 const load=button=>{const asset=currentAssets().find(a=>a.id===button.dataset.open);if(asset)void ensureAssetPreview(asset);};
 if(!globalThis.IntersectionObserver){buttons.forEach(load);return;}
 previewObserver=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){previewObserver.unobserve(entry.target);load(entry.target);}},{rootMargin:'250px'});
 buttons.forEach(button=>previewObserver.observe(button));
}
function render(){
 if(!state.entryRole){renderAccess();return;}
 if(readEntrySession()!==state.entryRole){leaveSession();return;}
 const rows=currentAssets(),filtered=rows.filter(a=>(state.category==='all'||a.category===state.category)&&(state.status==='all'||a.status===state.status)&&(a.title+' '+a.description).toLowerCase().includes(state.query.toLowerCase()));
 const mode='共享评审';
 app.innerHTML='<div class="app-shell"><aside class="sidebar"><a class="brand" href="./"><span class="brand-icon">'+ico('mail')+'</span><span>栖息邮局<small>毕业设计 · 评审工作台</small></span></a><div class="sidebar-note">作品目录 <span>WORKSPACE</span></div><nav class="nav-list" aria-label="作品分类">'+Object.entries(CATS).map(([k,v])=>'<button class="nav-item '+(state.category===k?'active':'')+'" data-category="'+k+'">'+ico(k==='all'?'grid':k)+'<span class="nav-label">'+v+'</span><span class="nav-count">'+rows.filter(a=>k==='all'||a.category===k).length+'</span></button>').join('')+'</nav><div class="sidebar-bottom"><div class="sidebar-note">让每一次反馈<br>成为下一步的方向。</div><button class="nav-item" id="help">'+ico('chat')+'<span>使用与检查说明</span></button><button class="nav-item" id="settings">'+ico('settings')+'<span>连接与账户</span></button><a class="nav-item" href="https://github.com/YinXiangs/BiShe_Mesh_DongHua_TeXiao" target="_blank" rel="noreferrer">'+ico('link')+'<span>项目 GitHub 仓库</span></a></div></aside><main class="main"><header class="topbar"><div class="breadcrumb">毕业设计 <span>/</span> '+esc(CATS[state.category])+'</div><div class="top-actions session-actions"><span class="identity-chip">'+(state.entryRole==='teacher'?'教师端':'学生端')+'</span><span class="mode-pill">'+mode+'</span><button class="button ghost small" id="leave-session">退出登录</button>'+'</div></header><section class="hero"><div class="hero-copy"><div class="eyebrow">QIXI POST OFFICE · GRADUATION PROJECT</div><h1>把每一份用心，<br>寄往下一次进步。</h1><p>《栖息邮局》作品提交与指导记录<br>模型、动画与特效，在这里有序生长。</p><div class="hero-actions">'+(!canEdit()?'<span class="help-text">打开作品即可查看版本、检查模型并留下意见。</span>':'<button class="button primary" id="new-asset">'+ico('plus')+' 新增作品</button><button class="button ghost" id="share-project">'+ico('link')+' 邀请老师评审</button>')+'</div></div><div class="hero-art">'+postalArt('scene')+'<span class="hero-stamp">用心制作 · 持续生长</span></div></section><section class="stats-grid" aria-label="项目概览">'+[['grid','作品总数',rows.length],['clock','待老师检查',rows.filter(a=>a.status==='review').length],['chat','需要修改',rows.filter(a=>a.status==='changes').length],['check','检查已通过',rows.filter(a=>a.status==='approved').length]].map(([i,t,n])=>'<div class="stat-card"><span class="stat-icon">'+ico(i)+'</span><div><div class="stat-value">'+n+'<small> 件</small></div><div class="stat-label">'+t+'</div></div></div>').join('')+'</section>'+
 (state.accessError?'<div class="notice" role="alert">'+ico('link')+'<span><strong>共享服务暂时无法连接</strong><br>'+esc(state.accessError)+'</span><button class="button ghost small" id="retry-access">重试</button></div>':'')+
 '<section><div class="section-head"><div><h2>'+esc(CATS[state.category])+' <span class="help-text">/ '+filtered.length+' 件</span></h2><p>每一项作品，都有独立的版本与反馈记录。</p></div><label class="search-field">'+ico('search')+'<input id="search" type="search" aria-label="搜索作品" placeholder="搜索作品名称…" value="'+esc(state.query)+'"></label></div><div class="filters">'+[['all','全部状态'],...Object.entries(STATUS)].map(([k,v])=>'<button class="filter-chip '+(state.status===k?'active':'')+'" data-status="'+k+'">'+v+'</button>').join('')+'</div><div class="asset-grid">'+filtered.map(a=>'<article class="asset-card"><button class="asset-thumb" data-open="'+esc(a.id)+'" aria-label="检查'+esc(a.title)+'">'+'<span class="asset-preview">'+previewMarkup(a)+'</span>'+'<span class="asset-category">'+CATS[a.category]+'</span>'+(a.demo?'<span class="badge demo">演示</span>':'')+'</button><div class="asset-body"><div class="asset-meta"><span>'+((a.category==='vfx')?'MP4 · 特效视频':'FBX · '+(a.category==='animation'?'动画文件':'三维模型'))+'</span><span class="badge '+a.status+'">'+STATUS[a.status]+'</span></div><div class="asset-read" data-read>'+readMarkup(a)+'</div><h3 class="asset-title">'+esc(a.title)+'</h3><p class="asset-description">'+esc(a.description||'等待补充制作说明')+'</p><div class="asset-footer"><span>'+ (a.demo?'示例预览':'更新于 '+date(a.updated_at||a.created_at))+'</span><button class="button ghost small" data-open="'+esc(a.id)+'">进入检查 '+ico('arrow')+'</button></div></div></article>').join('')+'</div>'+(!filtered.length?'<div class="empty-state">'+ico('mail')+'<h3>这里还没有作品</h3><p>学生提交作品后，即可在这里预览与检查。</p>'+(canEdit()?'<button class="button primary" id="empty-add">新增第一件作品</button>':'')+'</div>':'')+'</section><footer class="page-footer">栖息邮局 · 毕业设计评审工作台 <span>每次提交，离完成更近一步。</span></footer></main></div>';
 app.querySelectorAll('[data-category]').forEach(b=>b.onclick=()=>{state.category=b.dataset.category;render();});
 app.querySelectorAll('[data-status]').forEach(b=>b.onclick=()=>{state.status=b.dataset.status;render();});
 app.querySelector('#search').oninput=e=>{const pos=e.target.selectionStart;state.query=e.target.value;render();const q=app.querySelector('#search');q.focus();q.setSelectionRange(pos,pos);};
 app.querySelectorAll('[data-open]').forEach(b=>b.onclick=run(()=>openAsset(b.dataset.open)));
 for(const id of['new-asset','empty-add'])app.querySelector('#'+id)?.addEventListener('click',()=>newAsset());
 app.querySelector('#settings').onclick=settings;app.querySelector('#settings').hidden=Boolean(state.token);
 if(canEdit()){const trash=document.createElement('button');trash.className='nav-item';trash.id='recycle-bin';trash.innerHTML=ico('grid')+'<span>回收站</span>';app.querySelector('.sidebar-bottom').prepend(trash);}
 if(state.token)app.querySelector('#settings').hidden=true;
 app.querySelector('#help').onclick=help;
 app.querySelector('#share-project')?.addEventListener('click',run(()=>share()));
 app.querySelector('#retry-access')?.addEventListener('click',run(refresh));
 app.querySelector('#leave-session')?.addEventListener('click',leaveSession);
 app.querySelector('#recycle-bin')?.addEventListener('click',run(recycleBin));
 // Shared mode is the only submission destination. Old browser data is read solely by migration.
 app.querySelector('#settings')?.remove();
 const refreshButton=document.createElement('button');refreshButton.className='button ghost small';refreshButton.id='refresh-project';refreshButton.textContent='刷新作品';
 refreshButton.onclick=run(async()=>{refreshButton.disabled=true;try{await refresh();}finally{refreshButton.disabled=false;}});
 app.querySelector('#leave-session').before(refreshButton);
 if(state.accessError){
   const notice=app.querySelector('.notice');if(notice?.querySelector('strong'))notice.querySelector('strong').textContent='共享服务暂时无法连接';
   if(!state.assetsReady){app.querySelector('.stats-grid')?.remove();app.querySelector('.asset-grid')?.remove();app.querySelector('.empty-state')?.remove();app.querySelectorAll('.nav-count').forEach(node=>node.textContent='—');const count=app.querySelector('.section-head h2 .help-text');if(count)count.textContent='/ 暂时无法读取';}
 }
 if(canEdit()&&state.legacyAssets.length){
   const notice=document.createElement('div');notice.className='notice migration-notice';notice.innerHTML=ico('upload')+'<span><strong>发现这台设备上的 '+state.legacyAssets.length+' 件旧作品</strong><br>迁移到共享评审后，老师的手机和你的电脑都能查看。原记录会继续保留。</span><button class="button primary small" id="migrate-legacy">迁移这台设备上的旧作品</button>';
   app.querySelector('.hero').after(notice);notice.querySelector('button').onclick=run(migrateLegacy);
 }
 observeAssetPreviews();
}
function dialog(title,body,wide=false){
 const d=document.createElement('dialog');d.className='dialog '+(wide?'detail-dialog':'');d.innerHTML='<div class="dialog-header"><div><h2>'+esc(title)+'</h2></div><button class="close-button" aria-label="关闭">'+ico('close')+'</button></div><div class="dialog-body">'+body+'</div>';document.body.append(d);
 d.querySelector('.close-button').onclick=()=>d.close();d.addEventListener('click',e=>{if(e.target===d)d.close();});d.addEventListener('close',()=>{if(wide){state.viewer?.destroy();state.viewer=null;if(state.video){state.video.pause();URL.revokeObjectURL(state.video.src);state.video=null;}}d.remove();},{once:true});d.showModal();return d;
}
function newAsset(){
 requireStudent();
 if(state.mode==='cloud'&&state.role!=='owner'){settings();return;}if(state.token)return;
 const d=dialog('新增作品','<form id="asset-form" class="form-grid"><label class="field">作品名称<input name="title" required maxlength="80" placeholder="例如：邮局主建筑"></label><label class="field">作品分类<select name="category">'+Object.entries(CATS).filter(([k])=>k!=='all').map(([k,v])=>'<option value="'+k+'" '+(state.category===k?'selected':'')+'>'+v+'</option>').join('')+'</select></label><label class="field">制作说明<textarea name="description" maxlength="3000" placeholder="写下本次想请老师重点检查的内容。"></textarea></label><p class="help-text">新增后可提交 FBX 模型／动画，或 MP4 特效视频。每类作品数量不限。</p><div class="form-actions"><button class="button primary">创建作品</button></div></form>');
 d.querySelector('form').onsubmit=run(async e=>{e.preventDefault();requireStudent();const f=new FormData(e.target),title=f.get('title').trim();if(!title)throw Error('请填写作品名称。');const a={id:uid(),title,category:f.get('category'),description:f.get('description').trim(),status:'pending',created_at:new Date().toISOString(),updated_at:new Date().toISOString()};await state.cloud.createAsset(a);state.demo=false;state.category=a.category;state.status='all';state.query='';d.close();await refresh();await openAsset(a.id);toast('作品已创建，可以提交第一个版本。');});
}
async function openAsset(id){
 if(!state.entryRole){renderAccess();return;}
 if(state.token){await refresh();if(state.accessError)return;}
 state.selected=currentAssets().find(a=>a.id===id);const a=state.selected;if(!a)return;
 state.versions=await state.cloud.listVersions(id);
 state.comments=await state.cloud.listComments(id);
 const d=dialog(a.title,'<div class="detail-layout"><section class="viewer-column"><div class="viewer-toolbar"><span class="badge '+a.status+'">'+STATUS[a.status]+'</span><div class="viewer-tools">'+(canEdit()&&!a.demo?'<button class="button primary small" id="upload-version">'+ico('upload')+' 提交新版本</button>':'')+'<button class="button ghost small" id="download-version">下载版本</button><button class="button ghost small" id="asset-share">评审链接</button></div></div><div class="viewer-shell"><div id="model-host" style="width:100%;height:100%;min-height:360px"></div><div class="viewer-overlay" id="view-label">'+(a.demo?'演示预览 · 非提交文件':'')+'</div></div><div id="view-controls"></div><div class="viewer-stats" id="model-stats"></div><div class="inspector-tabs" role="tablist"><button class="filter-chip active" data-tab="summary">检查说明</button><button class="filter-chip" data-tab="materials">材质</button><button class="filter-chip" data-tab="structure">结构</button></div><div class="inspector-panel" id="inspector"></div></section><aside class="review-column"><div class="review-header"><h3>版本与反馈</h3><p>'+esc(a.description||'从整体到细节，记录每一次进步。')+'</p><label class="field">当前检查版本<select id="versions">'+(state.versions.length?state.versions.map(v=>'<option value="'+esc(v.id)+'">V'+v.number+' · '+esc(v.filename)+'</option>').join(''):'<option>尚未提交</option>')+'</select></label>'+(canReview()&&!state.token&&!a.demo?'<label class="field">检查状态<select id="asset-status" class="review-status-select">'+Object.entries(STATUS).filter(([k])=>k!=='pending').map(([k,v])=>'<option value="'+k+'" '+(a.status===k?'selected':'')+'>'+v+'</option>').join('')+'</select></label>':'')+'</div><div class="comment-list" id="comments"></div><form class="comment-form" id="comment-form"><h4>留下检查意见</h4><label class="field">你的称呼<input name="author" required maxlength="40" placeholder="例如：张老师" autocomplete="name" value="'+esc(state.entryRole==='teacher'?'黄静妮教授':localStorage.getItem('qixi-author')||'')+'"></label><div class="form-grid" style="grid-template-columns:1fr 1fr"><label class="field">检查维度<select name="dimension">'+Object.entries(DIM).map(([k,v])=>'<option value="'+k+'">'+v+'</option>').join('')+'</select></label><label class="field">建议<select name="verdict"><option value="note">一般建议</option><option value="changes">建议修改</option><option value="approved">建议通过</option></select></label></div><label class="field">意见内容<textarea name="body" required maxlength="3000" placeholder="可以描述具体位置、问题与修改方向…"></textarea></label><p class="help-text">'+(state.token?'评语会保存到共享评审中。':state.mode==='cloud'?'意见将保存到共享评审。':'本机意见只保存在这台设备，不会自动发送到其他手机或电脑。')+' 记录当前版本及查看位置。</p><button class="button primary" '+(a.demo||!state.versions.length?'disabled':'')+'>提交意见 '+ico('arrow')+'</button></form></aside></div>',true);
 const feedbackTools=document.createElement('div');feedbackTools.className='feedback-actions';feedbackTools.innerHTML='<button class="button ghost small" type="button" id="refresh-feedback">刷新反馈</button><button class="button ghost small" type="button" id="export-feedback">导出评审记录</button>';
 const storageNote=document.createElement('p');storageNote.className='feedback-storage';storageNote.textContent='共享评审：作品、已读、检查状态与意见在手机和电脑间共享。';
 if(!a.demo){d.querySelector('.review-header').append(storageNote,feedbackTools);feedbackTools.querySelector('#export-feedback').onclick=run(()=>exportReviewRecords(a));feedbackTools.querySelector('#refresh-feedback').onclick=run(event=>refreshFeedback(d,a,event.target));}
 d.querySelector('#versions').onchange=run(()=>loadVersion(d,d.querySelector('#versions').value));
 d.querySelector('#upload-version')?.addEventListener('click',()=>upload(d));
 if(state.token)d.querySelector('#asset-share').remove();
 else d.querySelector('#asset-share').onclick=run(()=>share(a.id));
 d.querySelector('#comment-form').hidden=!canReview();
 if(canEdit()&&!a.demo){const remove=document.createElement('button');remove.className='button danger small';remove.textContent='删除作品';remove.onclick=()=>deleteAsset(a,d);d.querySelector('.viewer-tools').prepend(remove);const edit=document.createElement('button');edit.className='button ghost small';edit.textContent='编辑说明';edit.onclick=()=>editAsset(a,d);d.querySelector('.viewer-tools').prepend(edit);}
 d.querySelector('#download-version').onclick=run(downloadVersion);
 d.querySelector('#asset-status')?.addEventListener('change',run(async e=>{const select=e.target,previous=a.status;select.disabled=true;feedbackWrites++;feedbackMutationSerial++;try{await changeReviewStatus(a,select.value);toast('检查状态已保存到共享评审。');}catch(error){select.value=previous;throw error;}finally{feedbackWrites--;feedbackMutationSerial++;select.disabled=Boolean(!canReview()||!state.version||state.version.id!==state.versions[0]?.id);}}));
 d.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{d.querySelectorAll('[data-tab]').forEach(x=>x.classList.toggle('active',x===b));inspector(d,b.dataset.tab);});
 d.querySelector('#comment-form').onsubmit=run(async e=>{e.preventDefault();requireTeacher();if(!state.version||a.demo)return;const button=e.target.querySelector('button');button.disabled=true;feedbackWrites++;feedbackMutationSerial++;try{const f=new FormData(e.target),rawBody=f.get('body'),author=f.get('author').trim(),body=rawBody.trim();if(!author||!body)throw Error('请填写称呼与意见内容。');const c={id:uid(),asset_id:a.id,version_id:state.version.id,author_name:author,body,dimension:f.get('dimension'),verdict:f.get('verdict'),context:state.video?{time:state.video.currentTime}:state.viewer?.context()||{},created_at:new Date().toISOString()};const saved=await state.cloud.addComment(c);if(state.selected?.id===a.id&&!state.comments.some(row=>row.id===saved.id))state.comments.push(saved);try{localStorage.setItem('qixi-author',author);}catch{}if(state.version?.id===c.version_id&&e.target.elements.body.value===rawBody)e.target.elements.body.value='';if(d.isConnected)comments(d);toast('意见已保存到共享评审。');}finally{feedbackWrites--;feedbackMutationSerial++;button.disabled=Boolean(!canReview()||state.selected?.demo||!state.version);}});
 await loadVersion(d,state.versions[0]?.id);comments(d);
}
async function loadVersion(d,id){
 const request=++loadSerial,readingAsset=state.selected;
 state.viewer?.destroy();state.viewer=null;if(state.video){state.video.pause();URL.revokeObjectURL(state.video.src);state.video=null;}
 state.version=state.versions.find(v=>v.id===id);state.files=[];const host=d.querySelector('#model-host'),controls=d.querySelector('#view-controls');host.innerHTML='';controls.innerHTML='';d.querySelector('#model-stats').innerHTML='';state.stats=null;
 d.querySelector('#comment-form button').disabled=Boolean(!canReview()||state.selected.demo||!state.version);
 d.querySelector('#download-version').disabled=Boolean(state.selected.demo||!state.version);
 const reviewSelect=d.querySelector('#asset-status');if(reviewSelect)reviewSelect.disabled=true;
 const finishReading=async()=>{if(!d.isConnected||request!==loadSerial)return;await markTeacherRead(readingAsset,state.version);if(d.isConnected&&request===loadSerial&&reviewSelect)reviewSelect.disabled=Boolean(!state.version||state.version.id!==state.versions[0]?.id);};
 const progress=d.querySelector('.viewer-toolbar > .badge');if(progress){progress.className='badge '+state.selected.status;progress.textContent=STATUS[state.selected.status];}
 if(state.versions.length)d.querySelectorAll('#versions option').forEach(o=>{if(!state.versions.some(v=>v.id===o.value))o.remove();});
 if(!state.version){host.innerHTML='<div class="viewer-empty">'+ico('upload')+'<h3>提交第一版作品</h3><p>模型与动画使用 FBX，特效使用 MP4。贴图请与 FBX 一起选择。</p></div>';inspector(d);comments(d);return;}
 host.innerHTML='<div class="viewer-empty">正在读取文件…</div>';
 const files=await state.cloud.downloadVersion(state.version);
 if(!d.isConnected||request!==loadSerial)return;state.files=files;host.innerHTML='';
 if(state.selected.category==='vfx'){
   if(state.selected.demo){host.innerHTML='<div class="viewer-empty">'+ico('vfx')+'<h3>MP4 特效检查区</h3><p>提交视频后，可播放、拖动进度并按时间点记录意见。</p></div>';}
   else{const file=state.files.find(f=>/\.mp4$/i.test(f.name));if(!file)throw Error('此版本缺少 MP4 文件。');const video=document.createElement('video');video.controls=true;video.playsInline=true;video.preload='metadata';video.className='video-preview';video.src=URL.createObjectURL(file);host.append(video);state.video=video;video.onloadedmetadata=()=>{d.querySelector('#model-stats').innerHTML='<span>时长 <strong>'+video.duration.toFixed(1)+' 秒</strong></span><span>分辨率 <strong>'+video.videoWidth+' × '+video.videoHeight+'</strong></span><span>文件 <strong>'+size(file.size)+'</strong></span>';};video.onloadeddata=()=>{if(d.isConnected&&request===loadSerial)void finishReading();};video.onerror=()=>toast('视频无法解码，请导出为兼容浏览器的 H.264 / AAC MP4。');}
 }else{
   try{state.viewer=new ReviewViewer(host,stats=>{if(d.isConnected&&request===loadSerial){state.stats=stats;renderStats(d);inspector(d);}});if(state.selected.demo)state.viewer.loadDemo(state.selected.category);else await state.viewer.loadFiles(state.files);
   if(!d.isConnected||request!==loadSerial)return;
   if(!readingAsset.demo)await finishReading();
   controls.innerHTML='<div class="viewer-toolbar"><div class="viewer-tools"><button class="filter-chip active" data-view="material">中性材质</button><button class="filter-chip" data-view="albedo">贴图原色</button><button class="filter-chip" data-view="clay">白模</button><button class="filter-chip" data-view="fbx">FBX 原材质</button><button class="filter-chip" data-view="wireframe">线框</button><button class="filter-chip" data-view="normal">法向着色</button></div><div class="viewer-tools"><button class="button ghost small" id="normal-arrows">法向箭头</button><button class="button ghost small" id="skeleton">骨架</button><button class="button ghost small" id="reset-camera">重置视角</button></div></div><div class="preview-adjustments"><label>预览亮度 <input id="preview-exposure" aria-label="预览亮度" type="range" min="0.4" max="1.8" step="0.05" value="1"><output id="exposure-value">1.00×</output></label><label><input id="flip-normal-y" type="checkbox">法线贴图 Y 反向</label></div><p class="preview-note">中性白光 · 贴图原色不受灯光影响 · 白模检查真实几何。UE 三渲二与后期效果以引擎画面为准。</p>';
   for(const key of['normal-arrows','skeleton'])controls.querySelector('#'+key).setAttribute('aria-pressed','false');
   controls.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>{state.viewer.setMode(b.dataset.view);for(const key of['normal-arrows','skeleton'])controls.querySelector('#'+key).setAttribute('aria-pressed','false');controls.querySelectorAll('[data-view]').forEach(x=>x.classList.toggle('active',x===b));});
   controls.querySelector('#normal-arrows').onclick=run(e=>{const on=e.target.getAttribute('aria-pressed')!=='true';for(const key of['normal-arrows','skeleton'])controls.querySelector('#'+key).setAttribute('aria-pressed','false');state.viewer.showNormals(on);e.target.setAttribute('aria-pressed',String(on));});
   controls.querySelector('#skeleton').onclick=e=>{const on=e.target.getAttribute('aria-pressed')!=='true';state.viewer.showSkeleton(on);e.target.setAttribute('aria-pressed',String(on));};
   controls.querySelector('#reset-camera').onclick=()=>state.viewer.resetCamera();
   controls.querySelector('#preview-exposure').oninput=event=>{state.viewer.setExposure(event.target.value);controls.querySelector('#exposure-value').textContent=state.viewer.exposure.toFixed(2)+'×';};
   controls.querySelector('#flip-normal-y').disabled=!state.stats?.materials.some(m=>m.maps.some(t=>t.slot==='normalMap'&&!t.missing));
   controls.querySelector('#flip-normal-y').onchange=event=>{state.viewer.flipNormalY(event.target.checked);for(const key of['normal-arrows','skeleton'])controls.querySelector('#'+key).setAttribute('aria-pressed','false');};
   if(state.viewer.clips.length){const line=document.createElement('div');line.className='animation-controls';line.innerHTML='<button class="button small" id="play">暂停</button><select id="clips" aria-label="动画片段">'+state.viewer.clips.map((c,i)=>'<option value="'+i+'">'+esc(c.name||'动作 '+(i+1))+'</option>').join('')+'</select><input id="timeline" aria-label="动画时间" type="range" min="0" max="'+state.viewer.clips[0].duration+'" step="0.01" value="0"><select id="speed" aria-label="播放速度"><option value="0.5">0.5×</option><option selected value="1">1×</option><option value="2">2×</option></select>';controls.append(line);line.querySelector('#play').onclick=e=>{state.viewer.playing=!state.viewer.playing;e.target.textContent=state.viewer.playing?'暂停':'播放';};line.querySelector('#clips').onchange=e=>{state.viewer.selectClip(Number(e.target.value));line.querySelector('#timeline').max=state.viewer.clip.duration;line.querySelector('#play').textContent='暂停';};line.querySelector('#timeline').oninput=e=>{state.viewer.setTime(e.target.value);line.querySelector('#play').textContent='播放';};line.querySelector('#speed').onchange=e=>state.viewer.speed=Number(e.target.value);}
   const timeline=controls.querySelector('#timeline');
   if(timeline){const viewer=state.viewer;const ticker=setInterval(()=>{if(!timeline.isConnected||state.viewer!==viewer){clearInterval(ticker);return;}timeline.value=viewer.action?.time||0;},250);}
   }catch(e){if(!d.isConnected||request!==loadSerial)return;host.innerHTML='<div class="viewer-empty"><h3>暂时无法预览此文件</h3><p>'+esc(e.message)+'</p><p>可使用“下载版本”在建模软件中检查，或重新导出 FBX。</p></div>';toast(e.message);}
 }
 comments(d);inspector(d);
}
function renderStats(d){const s=state.stats;if(!s)return;d.querySelector('#model-stats').innerHTML=[['三角面',fmt(s.triangles)],['缓冲顶点',fmt(s.vertices)],['网格',s.meshes],['材质',s.materialCount],['骨骼',s.bones]].map(([k,v])=>'<span>'+k+' <strong>'+v+'</strong></span>').join('');}
function inspector(d,tab){const panel=d.querySelector('#inspector');if(!panel)return;tab=tab||d.querySelector('[data-tab].active')?.dataset.tab||'summary';const s=state.stats;
 if(tab==='materials')panel.innerHTML=s?'<p class="help-text">FBX 原始材质与实际贴图如下。中性材质使用网页 PBR 近似；“FBX 原材质”可对照导入结果。Y 反向仅用于法线贴图凹凸方向不一致时。</p>'+s.materials.map(m=>'<div class="material-row"><span class="material-swatch" style="background:'+esc(m.color)+'"></span><div><strong>'+esc(m.name)+(m.pbrRestored?' · 已读取 PBR 贴图':'')+'</strong><small>'+esc(m.type)+' · '+(m.maps.map(x=>esc(x.slot+': '+x.name+(x.missing?'（缺失）':''))).join('；')||'无已加载贴图')+'</small></div></div>').join('')+(s.pbrRecovery?.warnings?.length?'<div class="notice">'+s.pbrRecovery.warnings.map(esc).join('；')+'</div>':''):'加载模型后显示实际材质。';
 else if(tab==='structure'){panel.innerHTML=s?s.nodes.map(n=>'<label class="structure-node" style="padding-left:'+Math.min(n.depth*14,100)+'px"><input type="checkbox" data-node="'+esc(n.id)+'" '+(n.visible?'checked':'')+'><span>'+esc(n.name)+'</span><small>'+esc(n.type)+'</small></label>').join(''):'加载模型后显示真实层级。';panel.querySelectorAll('[data-node]').forEach(n=>n.onchange=()=>state.viewer?.nodeVisible(n.dataset.node,n.checked));}
 else panel.innerHTML='<p class="help-text">'+esc(state.selected.description||'尚未填写检查说明。')+'</p>'+(s?'<p class="help-text">面数按导入后的三角面统计；缓冲顶点可能因 UV、法向等重复。中性材质支持已识别的粗糙度与金属度贴图，不能还原 UE 材质节点、描边和后期三渲二。'+(s.skinned?' 当前包含蒙皮网格：法向着色可随动画查看，箭头仅适用于静态网格。':'')+'</p>'+(s.pbrRecovery?.restoredMaterials?.length?'<p class="help-text">已恢复 PBR 贴图：'+s.pbrRecovery.restoredMaterials.map(m=>esc(m.name+'（'+m.slots.join('、')+'）')).join('；')+'。</p>':'')+(s.missingTextures?.length?'<div class="notice">未找到贴图：'+s.missingTextures.map(esc).join('、')+'。请重新提交 FBX 与对应贴图。</div>':'')+(s.pbrRecovery?.warnings?.length?'<div class="notice">'+s.pbrRecovery.warnings.map(esc).join('；')+'</div>':''):'')+'<p class="help-text">检查操作：左键旋转 · 右键平移 · 滚轮缩放。意见绑定当前版本，并记录视角或视频时间点。</p>';
}
function comments(d){const list=d.querySelector('#comments');if(!list)return;const rows=state.comments.filter(c=>c.version_id===state.version?.id);list.innerHTML='<h4>本版意见 <span>'+rows.length+'</span></h4>'+(!rows.length?'<div class="empty-state"><p>还没有意见，等待一次新的交流。</p></div>':rows.map(c=>'<article class="comment-card"><div class="comment-meta"><strong>'+esc(c.author_name)+((c.is_guest||c.guest_link_id)?' <small>· 访客</small>':'')+'</strong><time>'+date(c.created_at)+'</time></div><div class="asset-meta"><span>'+esc(DIM[c.dimension]||'整体建议')+'</span><span class="badge '+(c.verdict==='changes'?'changes':c.verdict==='approved'?'approved':'pending')+'">'+({note:'一般建议',changes:'建议修改',approved:'建议通过'}[c.verdict]||'意见')+'</span></div><p class="comment-text">'+esc(c.body)+'</p>'+(c.context&&Object.keys(c.context).length?'<button class="button ghost small" data-context="'+esc(c.id)+'">定位检查位置'+(Number.isFinite(c.context.time)?' · '+c.context.time.toFixed(1)+'s':'')+'</button>':'')+'</article>').join(''));
 list.querySelectorAll('[data-context]').forEach(b=>b.onclick=()=>{const c=rows.find(x=>x.id===b.dataset.context);if(state.video&&Number.isFinite(c.context.time)){state.video.currentTime=c.context.time;state.video.pause();}else state.viewer?.restore(c.context);});
}
function upload(detail){
 requireStudent();
 let pendingVersion=null;
 const a=state.selected,d=dialog('提交新版本 · '+a.title,'<form class="form-grid"><label class="upload-zone">'+ico('upload')+'<strong>选择 '+(a.category==='vfx'?'MP4 视频':'FBX 与全部贴图')+'</strong><span>支持多选；每个版本保留原始文件</span><input name="files" type="file" multiple required accept="'+(a.category==='vfx'?'.mp4':'.fbx,.png,.jpg,.jpeg,.webp,.tga,.bmp,.gif')+'"></label><div class="file-list"></div><p class="help-text">单文件上限 200 MB，每次总计 300 MB。'+(state.mode==='cloud'?'云存储还受服务端配额与存储桶限制。':'当前提交仅保存在本机浏览器；请及时下载备份。')+'</p><div class="form-actions"><button class="button primary">保存并预览</button></div></form>');
 d.querySelector('input').onchange=e=>{pendingVersion=null;d.querySelector('.file-list').textContent=[...e.target.files].map(f=>f.name+' · '+size(f.size)).join('\n');};
 d.querySelector('form').onsubmit=run(async e=>{
  e.preventDefault();const button=e.target.querySelector('button');button.disabled=true;button.textContent='正在保存…';
  try{
    requireStudent();const files=[...e.target.elements.files.files],v=validateFiles(a.category,files);
    const cloudMode=state.mode==='cloud',source=previewSource();
    let preview,previewError;
    button.textContent='正在生成预览…';
    try{preview=await generateMediaThumbnail(files,a.category);}catch(error){previewError=error.message;}
    button.textContent='正在保存…';
    pendingVersion ||= {id:uid(),asset_id:a.id,number:Math.max(0,...state.versions.map(x=>x.number))+1,filename:v.mainFile.name,stats:preview?{...preview.stats,thumbnail:preview.thumbnail,thumbnail_revision:2}:{},created_at:new Date().toISOString()};
    let version=pendingVersion;
    requireStudent();version=await state.cloud.uploadVersion(a.id,version,files,({sent,total})=>{button.textContent='正在上传 '+Math.round(sent/total*100)+'%…';});
    // The version is committed. Later status/preview errors must not invite a duplicate upload.
    if(state.selected?.id===a.id)state.versions.unshift(version);
    let warning=previewError?'版本已保存，文件暂时无法生成预览；可打开作品查看详情。':'';
    const changed={...a,status:'review',teacher_read_version_id:null,teacher_read_at:null,updated_at:new Date().toISOString()};
    try{const saved=await state.cloud.saveAsset(changed);Object.assign(a,saved||changed);}
    catch{warning='版本已保存，作品进度未能更新，请稍后重新设置进度。';}
    assetPreviews.set(previewKey(a,source),preview?{versionId:version.id,thumbnail:preview.thumbnail}:{versionId:version.id,error:previewError});
    if(preview)void writePreview(source.scope,version.id,preview.thumbnail);
    d.close();render();
    if(detail.isConnected&&state.selected?.id===a.id){
      detail.querySelector('#versions').insertAdjacentHTML('afterbegin','<option value="'+esc(version.id)+'">V'+version.number+' · '+esc(version.filename)+'</option>');
      detail.querySelector('#versions').value=version.id;
      const statusSelect=detail.querySelector('#asset-status');if(statusSelect)statusSelect.value=a.status;
      try{await loadVersion(detail,version.id);}catch{warning=warning||'版本已保存，预览暂时无法读取；请重新打开此作品。';}
    }
    toast(warning||'版本已提交到共享评审。');
  }finally{if(d.isConnected){button.disabled=false;button.textContent='保存并预览';}}
 });
}
function editAsset(a,detail){
 requireStudent();
 const d=dialog('编辑作品说明','<form class="form-grid"><label class="field">作品名称<input name="title" required maxlength="80" value="'+esc(a.title)+'"></label><label class="field">制作说明<textarea name="description" maxlength="3000">'+esc(a.description)+'</textarea></label><div class="form-actions"><button class="button primary">保存说明</button></div></form>');
 d.querySelector('form').onsubmit=run(async e=>{e.preventDefault();requireStudent();const f=new FormData(e.target);const title=f.get('title').trim();if(!title)throw Error('请填写名称。');const metadata={title,description:f.get('description').trim()};const saved=await state.cloud.saveAsset({...a,...metadata});Object.assign(a,saved);d.close();detail.close();await refresh();await openAsset(a.id);toast('作品说明已保存。');});
}

const migrationKey=()=> 'qixi-migration-complete-v1:'+(state.config.apiUrl||'');
const migrationPromptKey=()=> 'qixi-migration-prompt-v1:'+(state.config.apiUrl||'');
async function maybePromptLegacyMigration(){
 if(state.entryRole!=='student'||!state.assetsReady||state.accessError||state.assets.length||!state.legacyAssets.length||document.querySelector('dialog'))return;
 try{if(sessionStorage.getItem(migrationPromptKey())==='1')return;}catch{}
 // Empty legacy placeholders do not need a migration prompt.
 let hasVersions=false;for(const asset of state.legacyAssets){if((await db.getVersions(asset.id)).length){hasVersions=true;break;}}
 if(!hasVersions||state.entryRole!=='student'||state.assets.length)return;
 try{sessionStorage.setItem(migrationPromptKey(),'1');}catch{}
 await migrateLegacy();
}
function migrationFingerprint(asset,versions,comments){return JSON.stringify([asset.id,versions.map(v=>v.id).sort(),comments.map(c=>c.id).sort(),asset.status,asset.teacher_read_version_id||null]);}
function migrationMarks(){try{return JSON.parse(localStorage.getItem(migrationKey())||'{}')||{};}catch{return {};}}
async function findLegacyAssets(){
 const assets=await db.getAssets(),marks=migrationMarks(),result=[];
 for(const asset of assets){const [versions,comments]=await Promise.all([db.getVersions(asset.id),db.getComments(asset.id)]);if(marks[asset.id]!==migrationFingerprint(asset,versions,comments))result.push(asset);}
 return result;
}
async function migrateLegacy(){
 requireStudent();if(state.migrationBusy)throw Error('旧作品正在迁移，请等待当前任务完成。');
 const assets=await findLegacyAssets();
 if(!assets.length){await refresh();toast('这台设备没有待迁移的旧作品。');return;}
 const snapshots=[];
 for(const asset of assets){const [versions,comments]=await Promise.all([db.getVersions(asset.id),db.getComments(asset.id)]);snapshots.push({asset,versions:[...versions].sort((a,b)=>a.number-b.number),comments});}
 const hasFeedback=snapshot=>Boolean(snapshot.comments.length||['approved','changes'].includes(snapshot.asset.status)||snapshot.asset.teacher_read_version_id);
 const feedbackCount=snapshots.filter(hasFeedback).length;
 const body='<p>将下面的旧作品和全部历史版本保存到共享评审。完成后，老师与学生在其他手机和电脑登录相同网址即可查看。原文件与记录会保留在这台设备。</p><div class="migration-list">'+snapshots.map((snapshot,index)=>'<label class="migration-row"><input type="checkbox" name="migration-asset" value="'+index+'" checked><span><strong>'+esc(snapshot.asset.title)+'</strong><small>'+snapshot.versions.length+' 个版本 · '+snapshot.comments.length+' 条留言 · '+STATUS[snapshot.asset.status]+'</small></span></label>').join('')+'</div>'+(feedbackCount?'<label class="migration-option"><input type="checkbox" id="migrate-review">同时迁移老师反馈（'+feedbackCount+' 件作品有检查记录）</label><label class="field" id="migration-teacher-field" hidden>教师访问密码<input id="migration-teacher-code" type="password" autocomplete="off" maxlength="64" placeholder="由老师确认后输入"></label><p class="help-text">老师反馈需要教师身份确认。未勾选时仅迁移作品文件，原有留言与检查结果仍保留在这台设备；已有云端检查结果不会被旧记录覆盖。</p>':'')+'<p class="help-text">支持中断后重试，已完成的版本会跳过。上传期间请保持此页面打开。</p><div class="migration-progress" role="status" aria-live="polite"></div><div class="migration-results" aria-live="polite"></div><div class="form-actions"><button class="button ghost" id="migration-close">稍后处理</button><button class="button primary" id="migration-start">开始迁移到共享评审</button></div>';
 const d=dialog('迁移这台设备上的旧作品',body),progress=d.querySelector('.migration-progress'),results=d.querySelector('.migration-results'),start=d.querySelector('#migration-start'),close=d.querySelector('#migration-close');
 close.onclick=()=>d.close();
 const reviewOption=d.querySelector('#migrate-review');if(reviewOption)reviewOption.onchange=()=>{const field=d.querySelector('#migration-teacher-field');field.hidden=!reviewOption.checked;if(!reviewOption.checked)field.querySelector('input').value='';};
 let busy=false;
 d.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
 d.addEventListener('click',event=>{if(busy&&event.target===d){event.preventDefault();event.stopImmediatePropagation();}},true);
 start.onclick=async()=>{
  if(busy)return;
  const selected=[...d.querySelectorAll('input[name="migration-asset"]:checked')].map(input=>snapshots[Number(input.value)]);
  if(!selected.length){progress.textContent='请先勾选要迁移的作品。';return;}
  let teacherGrant=null,completed=0,failed=0,retained=0;
  busy=true;state.migrationBusy=true;start.disabled=true;close.disabled=true;d.querySelector('.close-button').disabled=true;
  d.querySelectorAll('input').forEach(input=>input.disabled=true);results.replaceChildren();
  try{
   requireStudent();
   if(reviewOption?.checked){
    const input=d.querySelector('#migration-teacher-code'),password=input.value;input.value='';
    if(!password)throw Error('迁移老师反馈前，请输入教师访问密码确认。');
    teacherGrant=await state.cloud.loginWithCode(password,{persist:false});
    if(teacherGrant.role!=='teacher')throw Error('迁移检查意见需要教师访问密码，请由老师确认。');
   }
   const remoteAssets=await state.cloud.listAssets(),remoteIds=new Set(remoteAssets.map(asset=>asset.id)),marks=migrationMarks();
   for(const [index,snapshot] of selected.entries()){
    const {asset,versions,comments}=snapshot;
    try{
     requireStudent();progress.textContent='正在迁移 '+(index+1)+' / '+selected.length+'：'+asset.title;
     if(!remoteIds.has(asset.id)){
      try{await state.cloud.createAsset(asset);remoteIds.add(asset.id);}
      catch(error){if(error.status!==409||!(await state.cloud.listAssets()).some(row=>row.id===asset.id))throw error;remoteIds.add(asset.id);}
     }
     const cloudVersions=await state.cloud.listVersions(asset.id),missingVersions=planLegacyVersions(versions,cloudVersions);
     for(const version of missingVersions){
      const files=await db.getFiles(version.id);
      if(!files.length)throw Error('V'+version.number+' 的原始文件无法读取，请保留本机记录并重新提交该版本。');
      await state.cloud.uploadVersion(asset.id,version,files,({sent,total})=>{progress.textContent='正在迁移 '+asset.title+' · V'+version.number+' · '+Math.round(sent/total*100)+'%';});
     }
     // Feedback can only be imported using an independently authenticated teacher session.
     let preservedCloudReview=false;if(teacherGrant&&hasFeedback(snapshot)){progress.textContent='正在迁移 '+asset.title+' 的老师反馈…';const imported=await state.cloud.importReview(asset.id,{asset,versions:versions.map(({id,number})=>({id,number})),comments},teacherGrant.token);preservedCloudReview=imported.migrationResult?.statusTransferred===false;}
     const keptFeedback=hasFeedback(snapshot)&&!teacherGrant;
     if(keptFeedback)retained++;
     else{marks[asset.id]=migrationFingerprint(asset,versions,comments);try{localStorage.setItem(migrationKey(),JSON.stringify(marks));}catch{/* A lost completion marker only causes a safe idempotent retry. */}}
     completed++;
     const row=document.createElement('p');row.className='migration-success';row.textContent=asset.title+'：作品已共享'+(keptFeedback?'；老师反馈仍保留在原设备':preservedCloudReview?'，留言已迁移；云端较新的检查结果已保留':'，记录已迁移');results.append(row);
    }catch(error){
     failed++;const row=document.createElement('p');row.className='migration-failure';row.textContent=asset.title+'：'+(error.message||'迁移未完成')+'。原始记录仍保留，可稍后重试。';results.append(row);
    }
   }
   progress.textContent='迁移完成：'+completed+' 件成功'+(failed?'，'+failed+' 件需要重试':'')+(retained?'。其中 '+retained+' 件的老师反馈尚未迁移，可再次勾选“同时迁移老师反馈”处理。':'。');
   await refresh();
  }catch(error){progress.textContent=error.message||'迁移未完成，请稍后重试。';}
  finally{
   if(teacherGrant)await state.cloud.logoutToken(teacherGrant.token).catch(()=>{});
   busy=false;state.migrationBusy=false;start.disabled=false;start.textContent='再次迁移 / 重试未完成项';close.disabled=false;close.textContent='关闭';d.querySelector('.close-button').disabled=false;d.querySelectorAll('input').forEach(input=>input.disabled=false);
  }
 };
}

// Only read persisted feedback. A backup never changes reviewer decisions or files.
async function feedbackSnapshot(asset){
 if(!readEntrySession()||asset.demo)throw Error('请登录后打开真实作品。');
 const mode=state.mode,token=state.token,cloud=state.cloud;
 if(token){const shared=await cloud.getSharedData(token);return {asset:shared.assets.find(a=>a.id===asset.id),versions:shared.versions.filter(v=>v.asset_id===asset.id),comments:shared.comments.filter(c=>c.asset_id===asset.id),mode,shared};}
 const [assets,versions,comments]=await Promise.all([cloud.listAssets(),cloud.listVersions(asset.id),cloud.listComments(asset.id)]);
 return {asset:assets.find(a=>a.id===asset.id),versions,comments,mode};
}
async function refreshFeedback(detail,asset,button){
 if(feedbackWrites)throw Error('意见或检查状态正在保存，请保存完成后刷新。');
 const mode=state.mode,token=state.token,request=loadSerial,mutation=feedbackMutationSerial;button.disabled=true;
 try{
  const snapshot=await feedbackSnapshot(asset);
  if(!detail.isConnected||state.selected!==asset||loadSerial!==request||state.mode!==mode||state.token!==token||!readEntrySession())return;
  if(feedbackWrites||mutation!==feedbackMutationSerial){toast('有新的意见或状态正在保存，请稍后再刷新。');return;}
  if(!snapshot.asset)throw Error('作品已不可访问，请保留当前文字后重新打开。');
  const selectedId=state.version?.id,versions=[...snapshot.versions].sort((a,b)=>b.number-a.number);
  if(selectedId&&!versions.some(v=>v.id===selectedId))throw Error('当前版本已不可访问，请保留当前文字后重新打开作品。');
  Object.assign(asset,snapshot.asset);state.versions=versions;state.comments=snapshot.comments;if(snapshot.shared)state.shared=snapshot.shared;
  const select=detail.querySelector('#versions');select.innerHTML=versions.length?versions.map(v=>'<option value="'+esc(v.id)+'">V'+v.number+' · '+esc(v.filename)+'</option>').join(''):'<option>尚未提交</option>';if(selectedId)select.value=selectedId;
  const status=detail.querySelector('#asset-status');if(status){status.value=asset.status;status.disabled=!canReview()||!selectedId||selectedId!==versions[0]?.id;}
  const badge=detail.querySelector('.viewer-toolbar > .badge');badge.className='badge '+asset.status;badge.textContent=STATUS[asset.status];
  comments(detail);render();
  toast('已读取共享评审的最新反馈。');
 }finally{button.disabled=false;}
}
function downloadFeedbackFile(name,content,type){
 const url=URL.createObjectURL(new Blob([content],{type})),link=document.createElement('a');link.href=url;link.download=name;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);
}
async function exportReviewRecords(asset){
 const mode=state.mode,token=state.token,snapshot=await feedbackSnapshot(asset);
 if(!readEntrySession()||state.mode!==mode||state.token!==token)return;
 if(!snapshot.asset)throw Error('未能读取作品的已保存记录。');
 const record=buildReviewRecord(snapshot),text=formatReviewRecordText(record),stem=String(asset.title).replace(/[\\/<>:"|?*\u0000-\u001f]/g,'_').slice(0,70)+'_评审记录';
 const panel=dialog('导出评审记录','<p class="help-text">包含作品检查状态、已读信息与全部版本留言；不包含 FBX、视频或贴图。导出不会修改记录，也不会自动同步到其他设备。</p><label class="field">可复制的文字记录<textarea id="feedback-record-text" class="feedback-report" readonly rows="13" aria-label="可复制的评审记录"></textarea></label><div class="form-actions"><button type="button" class="button ghost" id="copy-feedback-record">复制文字</button><button type="button" class="button ghost" id="download-feedback-txt">下载 TXT</button><button type="button" class="button primary" id="download-feedback-json">下载 JSON</button></div><p class="help-text">手机 QQ 如无法下载，可复制文字保存，或通过 QQ 发到自己的电脑。原始模型仍请使用“下载版本”单独备份。</p>');
 const field=panel.querySelector('#feedback-record-text');field.value=text;
 panel.querySelector('#copy-feedback-record').onclick=async()=>{try{await navigator.clipboard.writeText(text);toast('评审记录文字已复制。');}catch{field.focus();field.select();toast('文字已选中，请长按复制。');}};
 panel.querySelector('#download-feedback-txt').onclick=()=>downloadFeedbackFile(stem+'.txt','\ufeff'+text,'text/plain;charset=utf-8');
 panel.querySelector('#download-feedback-json').onclick=()=>downloadFeedbackFile(stem+'.json',JSON.stringify(record,null,2),'application/json;charset=utf-8');
}

async function downloadVersion(){if(!state.files.length)throw Error('当前没有可下载的原始文件。');const data={};for(const f of state.files)data[f.relativePath||f.name]=new Uint8Array(await f.arrayBuffer());const blob=new Blob([zipSync(data,{level:0})],{type:'application/zip'});const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=state.selected.title+'_V'+state.version.number+'.zip';a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);}
async function share(){
 requireStudent();
 const url=new URL(location.href);url.hash='';url.search='';
 const d=dialog('邀请老师评审','<p>老师在自己的手机或电脑打开相同网址，输入教师访问密码，即可查看所有已提交的作品，并保存意见与检查状态。</p><label class="field">网站地址<input readonly id="review-url"></label><p class="help-text">链接不包含密码。学生提交的作品与老师反馈都会保存到共享评审。</p><div class="form-actions"><button class="button primary" id="copy-link">复制网址</button></div>');
 d.querySelector('#review-url').value=url.href;
 d.querySelector('#copy-link').onclick=async()=>{try{await navigator.clipboard.writeText(url.href);toast('网址已复制，可以发给老师。');}catch{const field=d.querySelector('#review-url');field.focus();field.select();toast('网址已选中，请长按复制。');}};
}
function settings(){dialog('共享评审','<p>作品、原始文件、历史版本与老师反馈统一保存在共享评审中。手机 QQ、微信和电脑打开同一个网址，登录后即可查看。</p>');}
function help(){dialog('提交与检查说明','<div class="help-content"><h3>1 · 添加作品与提交版本</h3><p>五类作品的数量不限。场景、角色、产品及动画提交一个 FBX，并同时选择外部贴图；游戏特效提交 MP4。新版本保留旧文件，意见按版本分别保存。</p><h3>2 · 检查模型</h3><p>旋转、平移、缩放模型，切换材质、线框与法向着色。结构面板可开关实际节点；材质面板列出实际加载的贴图。动画支持片段切换与时间拖动。FBX 无法完整携带 UE 的三渲二材质与后期效果，以引擎画面为准。</p><h3>3 · 手机与电脑共享</h3><p>学生与老师使用同一个网址，以各自的访问密码登录。作品、版本、已读信息、检查状态和留言保存在共享评审中。返回页面时会刷新，也可点击“刷新作品”或作品里的“刷新反馈”。网络中断时会提示失败，不会把提交改存到这台设备。</p><h3>4 · 迁移旧作品</h3><p>以前保存在手机 QQ 等浏览器里的旧作品，需要在原来的设备与浏览器登录学生端，点击“迁移这台设备上的旧作品”。作品与版本迁移完成后，其他设备即可查看。若还需迁移原有老师意见与检查结果，可在迁移窗口输入教师访问密码确认；原记录始终保留。</p><h3>5 · 文件备份</h3><p>可下载版本与导出评审记录另行备份。单文件上限 200 MB，每个版本总计 300 MB。MP4 推荐 H.264 / AAC 编码；贴图请与 FBX 一起选择。</p></div>');}
async function boot(){
 try{
  const response=await fetch(new URL('config.json',document.baseURI),{cache:'no-store'});
  if(!response.ok)throw Error('网站共享配置暂时无法读取，请刷新重试。');
  state.deployedConfig=await response.json();state.config={...state.config,...state.deployedConfig};
  if(!state.config.apiUrl)throw Error('共享评审服务尚未配置，当前不能提交或读取作品；请联系项目维护者。');
  // Never use a saved per-browser backend configuration or an old share token.
  state.token=null;state.mode='cloud';
  state.cloud=createSharedApi(state.config,{onUnauthorized:()=>{state.accessError='登录已过期，请重新输入访问密码。';leaveSession({revoke:false});}});
  state.serviceReady=true;
  const session=await state.cloud.getSession();
  if(session){if(!saveEntrySession(session.role))throw Error('浏览器无法保存登录，请允许网站使用会话存储。');state.entryRole=session.role;state.role=session.role==='student'?'owner':'reviewer';}
  else{clearEntrySession();state.entryRole=null;}
 }catch(error){state.accessError=error.message||'共享服务暂时无法连接，请刷新重试。';clearEntrySession();state.entryRole=null;}
 finally{state.booting=false;}
 if(state.entryRole){await refresh();await maybePromptLegacyMigration();}else renderAccess();
}
let backgroundRefresh=false;
async function refreshVisibleShared(){
 if(!state.entryRole||!state.serviceReady||document.hidden||state.migrationBusy||backgroundRefresh||feedbackWrites)return;
 const modal=document.querySelector('dialog');
 if(modal&&!modal.classList.contains('detail-dialog'))return;
 const form=modal?.querySelector('#comment-form');if(form?.elements.body?.value.trim())return;
 backgroundRefresh=true;
 try{if(modal&&state.selected){const button=modal.querySelector('#refresh-feedback');if(button&&!button.disabled)await refreshFeedback(modal,state.selected,button);}else await refresh();}
 catch{/* Keep the current view; explicit refresh displays the actionable error. */}
 finally{backgroundRefresh=false;}
}
document.addEventListener('visibilitychange',()=>{if(!document.hidden)void refreshVisibleShared();});
window.addEventListener('online',()=>void refreshVisibleShared());
setInterval(()=>void refreshVisibleShared(),30000);
renderAccess();
boot();
