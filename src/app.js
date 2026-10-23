import './style.css';
import './dark.css';
import { ReviewViewer } from './viewer.js';
import { db } from './local-db.js';
import { validateFiles } from './validation.js';
import { createCloud } from './cloud.js';
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
const state={assets:[],category:'all',status:'all',query:'',mode:'local',demo:false,cloud:null,role:null,config:{githubRepo:'YinXiangs/BiShe_Mesh_DongHua_TeXiao'},deployedConfig:null,accessError:null,shared:null,token:new URLSearchParams(location.hash.slice(1)).get('review'),selected:null,versions:[],comments:[],files:[],viewer:null,video:null,version:null};
const app=document.querySelector('#app');
let toastTimer, loadSerial=0;
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
  state.accessError=null;
  if(state.token){
    state.mode='guest';state.demo=false;
    try{if(!state.cloud)throw Error('共享存储尚未配置，请联系项目所有者完成网站配置。');state.shared=await state.cloud.getSharedData(state.token);state.assets=state.shared.assets;}
    catch(error){state.shared=null;state.assets=[];state.accessError=error.message||'评审链接暂时无法打开。';}
  }
  else if(state.mode==='cloud'){state.role=await state.cloud.role();if(!state.role){state.assets=[];}else state.assets=await state.cloud.listAssets();state.demo=false;}
  else{state.assets=await db.getAssets();state.demo=state.assets.length===0&&state.mode!=='empty';if(state.mode==='empty')state.mode='local';}
  render();
}
function currentAssets(){return state.demo?DEMOS:state.assets;}
function canEdit(){return !state.token&&(state.mode!=='cloud'||state.role==='owner');}
function render(){
 const rows=currentAssets(),filtered=rows.filter(a=>(state.category==='all'||a.category===state.category)&&(state.status==='all'||a.status===state.status)&&(a.title+' '+a.description).toLowerCase().includes(state.query.toLowerCase()));
 const mode=state.token?'老师评审':state.demo?'演示预览':state.mode==='cloud'?'共享评审':'本机草稿';
 app.innerHTML='<div class="app-shell"><aside class="sidebar"><a class="brand" href="./"><span class="brand-icon">'+ico('mail')+'</span><span>栖息邮局<small>毕业设计 · 评审工作台</small></span></a><div class="sidebar-note">作品目录 <span>WORKSPACE</span></div><nav class="nav-list" aria-label="作品分类">'+Object.entries(CATS).map(([k,v])=>'<button class="nav-item '+(state.category===k?'active':'')+'" data-category="'+k+'">'+ico(k==='all'?'grid':k)+'<span class="nav-label">'+v+'</span><span class="nav-count">'+rows.filter(a=>k==='all'||a.category===k).length+'</span></button>').join('')+'</nav><div class="sidebar-bottom"><div class="sidebar-note">让每一次反馈<br>成为下一步的方向。</div><button class="nav-item" id="help">'+ico('chat')+'<span>使用与检查说明</span></button><button class="nav-item" id="settings">'+ico('settings')+'<span>连接与账户</span></button><a class="nav-item" href="https://github.com/YinXiangs/BiShe_Mesh_DongHua_TeXiao" target="_blank" rel="noreferrer">'+ico('link')+'<span>项目 GitHub 仓库</span></a></div></aside><main class="main"><header class="topbar"><div class="breadcrumb">毕业设计 <span>/</span> '+esc(CATS[state.category])+'</div><div class="top-actions"><span class="mode-pill">'+mode+'</span>'+(state.token?'':'<button class="button ghost small" id="mode-toggle">'+(state.demo?'进入我的作品':state.mode==='cloud'?'切到本机草稿':'共享评审')+'</button>')+'</div></header><section class="hero"><div class="hero-copy"><div class="eyebrow">QIXI POST OFFICE · GRADUATION PROJECT</div><h1>把每一份用心，<br>寄往下一次进步。</h1><p>《栖息邮局》作品提交与指导记录<br>模型、动画与特效，在这里有序生长。</p><div class="hero-actions">'+(state.token?'<span class="help-text">打开作品即可查看版本、检查模型并留下意见。</span>':'<button class="button primary" id="new-asset">'+ico('plus')+' 新增作品</button><button class="button ghost" id="share-project">'+ico('link')+' 邀请老师评审</button>')+'</div></div><div class="hero-art">'+postalArt('scene')+'<span class="hero-stamp">用心制作 · 持续生长</span></div></section><section class="stats-grid" aria-label="项目概览">'+[['grid','作品总数',rows.length],['clock','待老师检查',rows.filter(a=>a.status==='review').length],['chat','需要修改',rows.filter(a=>a.status==='changes').length],['check','检查已通过',rows.filter(a=>a.status==='approved').length]].map(([i,t,n])=>'<div class="stat-card"><span class="stat-icon">'+ico(i)+'</span><div><div class="stat-value">'+n+'<small> 件</small></div><div class="stat-label">'+t+'</div></div></div>').join('')+'</section>'+
 (state.accessError?'<div class="notice" role="alert">'+ico('link')+'<span><strong>暂时无法打开评审链接</strong><br>'+esc(state.accessError)+'</span><button class="button ghost small" id="retry-access">重试</button></div>':state.demo?'<div class="notice">'+ico('grid')+'<span>当前为演示作品，帮助你体验检查功能。新增作品后会显示你的真实提交。</span></div>':state.mode==='local'?'<div class="notice">'+ico('clock')+'<span>本机草稿：文件和意见保存在当前浏览器。连接共享评审并上传后，老师才能在其他设备查看。</span></div>':state.token?'<div class="notice">'+ico('link')+'<span>专属评审链接 · 有效至 '+esc(state.shared?.expires_at?date(state.shared.expires_at):'尚未读取')+'。访客姓名由填写者提供。</span></div>':'')+
 '<section><div class="section-head"><div><h2>'+esc(CATS[state.category])+' <span class="help-text">/ '+filtered.length+' 件</span></h2><p>每一项作品，都有独立的版本与反馈记录。</p></div><label class="search-field">'+ico('search')+'<input id="search" type="search" aria-label="搜索作品" placeholder="搜索作品名称…" value="'+esc(state.query)+'"></label></div><div class="filters">'+[['all','全部状态'],...Object.entries(STATUS)].map(([k,v])=>'<button class="filter-chip '+(state.status===k?'active':'')+'" data-status="'+k+'">'+v+'</button>').join('')+'</div><div class="asset-grid">'+filtered.map(a=>'<article class="asset-card"><button class="asset-thumb" data-open="'+esc(a.id)+'" aria-label="检查'+esc(a.title)+'">'+(a.thumbnail?'<img alt="" src="'+esc(a.thumbnail)+'">':postalArt(a.category))+'<span class="asset-category">'+CATS[a.category]+'</span>'+(a.demo?'<span class="badge demo">演示</span>':'')+'</button><div class="asset-body"><div class="asset-meta"><span>'+((a.category==='vfx')?'MP4 · 特效视频':'FBX · '+(a.category==='animation'?'动画文件':'三维模型'))+'</span><span class="badge '+a.status+'">'+STATUS[a.status]+'</span></div><h3 class="asset-title">'+esc(a.title)+'</h3><p class="asset-description">'+esc(a.description||'等待补充制作说明')+'</p><div class="asset-footer"><span>'+ (a.demo?'示例预览':'更新于 '+date(a.updated_at||a.created_at))+'</span><button class="button ghost small" data-open="'+esc(a.id)+'">进入检查 '+ico('arrow')+'</button></div></div></article>').join('')+'</div>'+(!filtered.length?'<div class="empty-state">'+ico('mail')+'<h3>这里还没有作品</h3><p>按需要添加项目，再提交 FBX 或 MP4。每一类的数量不限。</p>'+(canEdit()?'<button class="button primary" id="empty-add">新增第一件作品</button>':'')+'</div>':'')+'</section><footer class="page-footer">栖息邮局 · 毕业设计评审工作台 <span>每次提交，离完成更近一步。</span></footer></main></div>';
 app.querySelectorAll('[data-category]').forEach(b=>b.onclick=()=>{state.category=b.dataset.category;render();});
 app.querySelectorAll('[data-status]').forEach(b=>b.onclick=()=>{state.status=b.dataset.status;render();});
 app.querySelector('#search').oninput=e=>{const pos=e.target.selectionStart;state.query=e.target.value;render();const q=app.querySelector('#search');q.focus();q.setSelectionRange(pos,pos);};
 app.querySelectorAll('[data-open]').forEach(b=>b.onclick=run(()=>openAsset(b.dataset.open)));
 for(const id of['new-asset','empty-add'])app.querySelector('#'+id)?.addEventListener('click',()=>newAsset());
 app.querySelector('#settings').onclick=settings;
 if(state.token)app.querySelector('#settings').hidden=true;
 app.querySelector('#help').onclick=help;
 app.querySelector('#mode-toggle')?.addEventListener('click',run(async()=>{if(state.demo){state.demo=false;state.mode='empty';await refresh();}else if(state.mode==='cloud'){state.mode='local';await refresh();}else if(state.cloud){state.mode='cloud';await refresh();if(!state.role)settings();}else settings();}));
 app.querySelector('#share-project')?.addEventListener('click',run(()=>share()));
 app.querySelector('#retry-access')?.addEventListener('click',run(refresh));
}
function dialog(title,body,wide=false){
 const d=document.createElement('dialog');d.className='dialog '+(wide?'detail-dialog':'');d.innerHTML='<div class="dialog-header"><div><h2>'+esc(title)+'</h2></div><button class="close-button" aria-label="关闭">'+ico('close')+'</button></div><div class="dialog-body">'+body+'</div>';document.body.append(d);
 d.querySelector('.close-button').onclick=()=>d.close();d.addEventListener('click',e=>{if(e.target===d)d.close();});d.addEventListener('close',()=>{if(wide){state.viewer?.destroy();state.viewer=null;if(state.video){state.video.pause();URL.revokeObjectURL(state.video.src);state.video=null;}}d.remove();},{once:true});d.showModal();return d;
}
function newAsset(){
 if(state.mode==='cloud'&&state.role!=='owner'){settings();return;}if(state.token)return;
 const d=dialog('新增作品','<form id="asset-form" class="form-grid"><label class="field">作品名称<input name="title" required maxlength="80" placeholder="例如：邮局主建筑"></label><label class="field">作品分类<select name="category">'+Object.entries(CATS).filter(([k])=>k!=='all').map(([k,v])=>'<option value="'+k+'" '+(state.category===k?'selected':'')+'>'+v+'</option>').join('')+'</select></label><label class="field">制作说明<textarea name="description" maxlength="3000" placeholder="写下本次想请老师重点检查的内容。"></textarea></label><p class="help-text">新增后可提交 FBX 模型／动画，或 MP4 特效视频。每类作品数量不限。</p><div class="form-actions"><button class="button primary">创建作品</button></div></form>');
 d.querySelector('form').onsubmit=run(async e=>{e.preventDefault();const f=new FormData(e.target),title=f.get('title').trim();if(!title)throw Error('请填写作品名称。');const a={id:uid(),title,category:f.get('category'),description:f.get('description').trim(),status:'pending',created_at:new Date().toISOString(),updated_at:new Date().toISOString()};if(state.mode==='cloud')await state.cloud.createAsset(a);else await db.putAsset(a);state.demo=false;state.category=a.category;state.status='all';state.query='';d.close();await refresh();await openAsset(a.id);toast('作品已创建，可以提交第一个版本。');});
}
async function openAsset(id){
 if(state.token){await refresh();if(state.accessError)return;}
 state.selected=currentAssets().find(a=>a.id===id);const a=state.selected;if(!a)return;
 state.versions=a.demo?[{id:'demo-version',number:1,filename:a.category==='vfx'?'等待提交.mp4':'演示几何体',created_at:new Date().toISOString()}]:state.token?state.shared.versions.filter(v=>v.asset_id===id).sort((a,b)=>b.number-a.number):state.mode==='cloud'?await state.cloud.listVersions(id):await db.getVersions(id);
 state.comments=a.demo?[]:state.token?state.shared.comments.filter(c=>c.asset_id===id):state.mode==='cloud'?await state.cloud.listComments(id):await db.getComments(id);
 const d=dialog(a.title,'<div class="detail-layout"><section class="viewer-column"><div class="viewer-toolbar"><span class="badge '+a.status+'">'+STATUS[a.status]+'</span><div class="viewer-tools">'+(canEdit()&&!a.demo?'<button class="button primary small" id="upload-version">'+ico('upload')+' 提交新版本</button>':'')+'<button class="button ghost small" id="download-version">下载版本</button><button class="button ghost small" id="asset-share">评审链接</button></div></div><div class="viewer-shell"><div id="model-host" style="width:100%;height:100%;min-height:360px"></div><div class="viewer-overlay" id="view-label">'+(a.demo?'演示预览 · 非提交文件':'')+'</div></div><div id="view-controls"></div><div class="viewer-stats" id="model-stats"></div><div class="inspector-tabs" role="tablist"><button class="filter-chip active" data-tab="summary">检查说明</button><button class="filter-chip" data-tab="materials">材质</button><button class="filter-chip" data-tab="structure">结构</button></div><div class="inspector-panel" id="inspector"></div></section><aside class="review-column"><div class="review-header"><h3>版本与反馈</h3><p>'+esc(a.description||'从整体到细节，记录每一次进步。')+'</p><label class="field">当前检查版本<select id="versions">'+(state.versions.length?state.versions.map(v=>'<option value="'+esc(v.id)+'">V'+v.number+' · '+esc(v.filename)+'</option>').join(''):'<option>尚未提交</option>')+'</select></label>'+(canEdit()&&!a.demo?'<label class="field">作品进度<select id="asset-status">'+Object.entries(STATUS).map(([k,v])=>'<option value="'+k+'" '+(a.status===k?'selected':'')+'>'+v+'</option>').join('')+'</select></label>':'')+'</div><div class="comment-list" id="comments"></div><form class="comment-form" id="comment-form"><h4>留下检查意见</h4><label class="field">你的称呼<input name="author" required maxlength="40" placeholder="例如：张老师" autocomplete="name" value="'+esc(localStorage.getItem('qixi-author')||'')+'"></label><div class="form-grid" style="grid-template-columns:1fr 1fr"><label class="field">检查维度<select name="dimension">'+Object.entries(DIM).map(([k,v])=>'<option value="'+k+'">'+v+'</option>').join('')+'</select></label><label class="field">建议<select name="verdict"><option value="note">一般建议</option><option value="changes">建议修改</option><option value="approved">建议通过</option></select></label></div><label class="field">意见内容<textarea name="body" required maxlength="3000" placeholder="可以描述具体位置、问题与修改方向…"></textarea></label><p class="help-text">'+(state.token?'访客留言会保存到共享评审中；称呼未经账号核验。':state.mode==='cloud'?'意见将保存到共享评审。':'本机意见仅保存在当前浏览器。')+' 记录当前版本及查看位置。</p><button class="button primary" '+(a.demo||!state.versions.length?'disabled':'')+'>提交意见 '+ico('arrow')+'</button></form></aside></div>',true);
 d.querySelector('#versions').onchange=run(()=>loadVersion(d,d.querySelector('#versions').value));
 d.querySelector('#upload-version')?.addEventListener('click',()=>upload(d));
 if(state.token)d.querySelector('#asset-share').remove();
 else d.querySelector('#asset-share').onclick=run(()=>share(a.id));
 if(canEdit()&&!a.demo){const edit=document.createElement('button');edit.className='button ghost small';edit.textContent='编辑说明';edit.onclick=()=>editAsset(a,d);d.querySelector('.viewer-tools').prepend(edit);}
 d.querySelector('#download-version').onclick=run(downloadVersion);
 d.querySelector('#asset-status')?.addEventListener('change',run(async e=>{a.status=e.target.value;a.updated_at=new Date().toISOString();if(state.mode==='cloud')await state.cloud.saveAsset(a);else await db.putAsset(a);render();toast('作品进度已更新。');}));
 d.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{d.querySelectorAll('[data-tab]').forEach(x=>x.classList.toggle('active',x===b));inspector(d,b.dataset.tab);});
 d.querySelector('#comment-form').onsubmit=run(async e=>{e.preventDefault();if(!state.version||a.demo)return;const button=e.target.querySelector('button');button.disabled=true;try{const f=new FormData(e.target),author=f.get('author').trim(),body=f.get('body').trim();if(!author||!body)throw Error('请填写称呼与意见内容。');const c={id:uid(),asset_id:a.id,version_id:state.version.id,author_name:author,body,dimension:f.get('dimension'),verdict:f.get('verdict'),context:state.video?{time:state.video.currentTime}:state.viewer?.context()||{},created_at:new Date().toISOString()};let saved=c;if(state.token){saved=await state.cloud.addSharedComment(state.token,c);state.shared?.comments.push(saved);}else if(state.mode==='cloud'){saved=await state.cloud.addComment(c);}else await db.putComment(c);if(state.selected?.id===a.id)state.comments.push(saved);try{localStorage.setItem('qixi-author',author);}catch{}e.target.elements.body.value='';if(d.isConnected)comments(d);toast('意见已保存。');}finally{button.disabled=false;}});
 await loadVersion(d,state.versions[0]?.id);comments(d);
}
async function loadVersion(d,id){
 const request=++loadSerial;
 state.viewer?.destroy();state.viewer=null;if(state.video){state.video.pause();URL.revokeObjectURL(state.video.src);state.video=null;}
 state.version=state.versions.find(v=>v.id===id);state.files=[];const host=d.querySelector('#model-host'),controls=d.querySelector('#view-controls');host.innerHTML='';controls.innerHTML='';d.querySelector('#model-stats').innerHTML='';state.stats=null;
 d.querySelector('#comment-form button').disabled=Boolean(state.selected.demo||!state.version);
 d.querySelector('#download-version').disabled=Boolean(state.selected.demo||!state.version);
 const progress=d.querySelector('.viewer-toolbar > .badge');if(progress){progress.className='badge '+state.selected.status;progress.textContent=STATUS[state.selected.status];}
 if(state.versions.length)d.querySelectorAll('#versions option').forEach(o=>{if(!state.versions.some(v=>v.id===o.value))o.remove();});
 if(!state.version){host.innerHTML='<div class="viewer-empty">'+ico('upload')+'<h3>提交第一版作品</h3><p>模型与动画使用 FBX，特效使用 MP4。贴图请与 FBX 一起选择。</p></div>';inspector(d);comments(d);return;}
 host.innerHTML='<div class="viewer-empty">正在读取文件…</div>';
 const files=state.selected.demo?[]:state.mode==='cloud'||state.token?await state.cloud.downloadVersion(state.version):await db.getFiles(id);
 if(!d.isConnected||request!==loadSerial)return;state.files=files;host.innerHTML='';
 if(state.selected.category==='vfx'){
   if(state.selected.demo){host.innerHTML='<div class="viewer-empty">'+ico('vfx')+'<h3>MP4 特效检查区</h3><p>提交视频后，可播放、拖动进度并按时间点记录意见。</p></div>';}
   else{const file=state.files.find(f=>/\.mp4$/i.test(f.name));if(!file)throw Error('此版本缺少 MP4 文件。');const video=document.createElement('video');video.controls=true;video.playsInline=true;video.preload='metadata';video.className='video-preview';video.src=URL.createObjectURL(file);host.append(video);state.video=video;video.onloadedmetadata=()=>{d.querySelector('#model-stats').innerHTML='<span>时长 <strong>'+video.duration.toFixed(1)+' 秒</strong></span><span>分辨率 <strong>'+video.videoWidth+' × '+video.videoHeight+'</strong></span><span>文件 <strong>'+size(file.size)+'</strong></span>';};video.onerror=()=>toast('视频无法解码，请导出为兼容浏览器的 H.264 / AAC MP4。');}
 }else{
   try{state.viewer=new ReviewViewer(host,stats=>{if(d.isConnected&&request===loadSerial){state.stats=stats;renderStats(d);inspector(d);}});if(state.selected.demo)state.viewer.loadDemo(state.selected.category);else await state.viewer.loadFiles(state.files);
   if(!d.isConnected||request!==loadSerial)return;
   controls.innerHTML='<div class="viewer-toolbar"><div class="viewer-tools"><button class="filter-chip active" data-view="material">材质</button><button class="filter-chip" data-view="wireframe">线框</button><button class="filter-chip" data-view="normal">法向着色</button></div><div class="viewer-tools"><button class="button ghost small" id="normal-arrows">法向箭头</button><button class="button ghost small" id="skeleton">骨架</button><button class="button ghost small" id="reset-camera">重置视角</button></div></div>';
   for(const key of['normal-arrows','skeleton'])controls.querySelector('#'+key).setAttribute('aria-pressed','false');
   controls.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>{state.viewer.setMode(b.dataset.view);for(const key of['normal-arrows','skeleton'])controls.querySelector('#'+key).setAttribute('aria-pressed','false');controls.querySelectorAll('[data-view]').forEach(x=>x.classList.toggle('active',x===b));});
   controls.querySelector('#normal-arrows').onclick=run(e=>{const on=e.target.getAttribute('aria-pressed')!=='true';for(const key of['normal-arrows','skeleton'])controls.querySelector('#'+key).setAttribute('aria-pressed','false');state.viewer.showNormals(on);e.target.setAttribute('aria-pressed',String(on));});
   controls.querySelector('#skeleton').onclick=e=>{const on=e.target.getAttribute('aria-pressed')!=='true';state.viewer.showSkeleton(on);e.target.setAttribute('aria-pressed',String(on));};
   controls.querySelector('#reset-camera').onclick=()=>state.viewer.resetCamera();
   if(state.viewer.clips.length){const line=document.createElement('div');line.className='animation-controls';line.innerHTML='<button class="button small" id="play">暂停</button><select id="clips" aria-label="动画片段">'+state.viewer.clips.map((c,i)=>'<option value="'+i+'">'+esc(c.name||'动作 '+(i+1))+'</option>').join('')+'</select><input id="timeline" aria-label="动画时间" type="range" min="0" max="'+state.viewer.clips[0].duration+'" step="0.01" value="0"><select id="speed" aria-label="播放速度"><option value="0.5">0.5×</option><option selected value="1">1×</option><option value="2">2×</option></select>';controls.append(line);line.querySelector('#play').onclick=e=>{state.viewer.playing=!state.viewer.playing;e.target.textContent=state.viewer.playing?'暂停':'播放';};line.querySelector('#clips').onchange=e=>{state.viewer.selectClip(Number(e.target.value));line.querySelector('#timeline').max=state.viewer.clip.duration;line.querySelector('#play').textContent='暂停';};line.querySelector('#timeline').oninput=e=>{state.viewer.setTime(e.target.value);line.querySelector('#play').textContent='播放';};line.querySelector('#speed').onchange=e=>state.viewer.speed=Number(e.target.value);}
   const timeline=controls.querySelector('#timeline');
   if(timeline){const viewer=state.viewer;const ticker=setInterval(()=>{if(!timeline.isConnected||state.viewer!==viewer){clearInterval(ticker);return;}timeline.value=viewer.action?.time||0;},250);}
   }catch(e){if(!d.isConnected||request!==loadSerial)return;host.innerHTML='<div class="viewer-empty"><h3>暂时无法预览此文件</h3><p>'+esc(e.message)+'</p><p>可使用“下载版本”在建模软件中检查，或重新导出 FBX。</p></div>';toast(e.message);}
 }
 comments(d);inspector(d);
}
function renderStats(d){const s=state.stats;if(!s)return;d.querySelector('#model-stats').innerHTML=[['三角面',fmt(s.triangles)],['缓冲顶点',fmt(s.vertices)],['网格',s.meshes],['材质',s.materialCount],['骨骼',s.bones]].map(([k,v])=>'<span>'+k+' <strong>'+v+'</strong></span>').join('');}
function inspector(d,tab){const panel=d.querySelector('#inspector');if(!panel)return;tab=tab||d.querySelector('[data-tab].active')?.dataset.tab||'summary';const s=state.stats;
 if(tab==='materials')panel.innerHTML=s?s.materials.map(m=>'<div class="material-row"><span class="material-swatch" style="background:'+esc(m.color)+'"></span><div><strong>'+esc(m.name)+'</strong><small>'+esc(m.type)+' · '+(m.maps.map(x=>esc(x.slot+': '+x.name)).join('；')||'无已加载贴图')+'</small></div></div>').join(''):'加载模型后显示实际材质。';
 else if(tab==='structure'){panel.innerHTML=s?s.nodes.map(n=>'<label class="structure-node" style="padding-left:'+Math.min(n.depth*14,100)+'px"><input type="checkbox" data-node="'+esc(n.id)+'" '+(n.visible?'checked':'')+'><span>'+esc(n.name)+'</span><small>'+esc(n.type)+'</small></label>').join(''):'加载模型后显示真实层级。';panel.querySelectorAll('[data-node]').forEach(n=>n.onchange=()=>state.viewer?.nodeVisible(n.dataset.node,n.checked));}
 else panel.innerHTML='<p class="help-text">'+esc(state.selected.description||'尚未填写检查说明。')+'</p>'+(s?'<p class="help-text">面数按导入后的三角面统计；缓冲顶点可能因 UV、法向等重复。FBX 材质为浏览器近似显示，复杂 UE 材质请另附效果图。'+(s.skinned?' 当前包含蒙皮网格：法向着色可随动画查看，箭头仅适用于静态网格。':'')+'</p>'+(s.missingTextures?.length?'<div class="notice">未找到贴图：'+s.missingTextures.map(esc).join('、')+'。请重新提交 FBX 与对应贴图。</div>':''):'')+'<p class="help-text">检查操作：左键旋转 · 右键平移 · 滚轮缩放。意见绑定当前版本，并记录视角或视频时间点。</p>';
}
function comments(d){const list=d.querySelector('#comments');if(!list)return;const rows=state.comments.filter(c=>c.version_id===state.version?.id);list.innerHTML='<h4>本版意见 <span>'+rows.length+'</span></h4>'+(!rows.length?'<div class="empty-state"><p>还没有意见，等待一次新的交流。</p></div>':rows.map(c=>'<article class="comment-card"><div class="comment-meta"><strong>'+esc(c.author_name)+((c.is_guest||c.guest_link_id)?' <small>· 访客</small>':'')+'</strong><time>'+date(c.created_at)+'</time></div><div class="asset-meta"><span>'+esc(DIM[c.dimension]||'整体建议')+'</span><span class="badge '+(c.verdict==='changes'?'changes':c.verdict==='approved'?'approved':'pending')+'">'+({note:'一般建议',changes:'建议修改',approved:'建议通过'}[c.verdict]||'意见')+'</span></div><p class="comment-text">'+esc(c.body)+'</p>'+(c.context&&Object.keys(c.context).length?'<button class="button ghost small" data-context="'+esc(c.id)+'">定位检查位置'+(Number.isFinite(c.context.time)?' · '+c.context.time.toFixed(1)+'s':'')+'</button>':'')+'</article>').join(''));
 list.querySelectorAll('[data-context]').forEach(b=>b.onclick=()=>{const c=rows.find(x=>x.id===b.dataset.context);if(state.video&&Number.isFinite(c.context.time)){state.video.currentTime=c.context.time;state.video.pause();}else state.viewer?.restore(c.context);});
}
function upload(detail){
 const a=state.selected,d=dialog('提交新版本 · '+a.title,'<form class="form-grid"><label class="upload-zone">'+ico('upload')+'<strong>选择 '+(a.category==='vfx'?'MP4 视频':'FBX 与全部贴图')+'</strong><span>支持多选；每个版本保留原始文件</span><input name="files" type="file" multiple required accept="'+(a.category==='vfx'?'.mp4':'.fbx,.png,.jpg,.jpeg,.webp,.tga,.bmp,.gif')+'"></label><div class="file-list"></div><p class="help-text">单文件上限 200 MB，每次总计 300 MB。'+(state.mode==='cloud'?'云存储还受服务端配额与存储桶限制。':'当前提交仅保存在本机浏览器；请及时下载备份。')+'</p><div class="form-actions"><button class="button primary">保存并预览</button></div></form>');
 d.querySelector('input').onchange=e=>d.querySelector('.file-list').textContent=[...e.target.files].map(f=>f.name+' · '+size(f.size)).join('\n');
 d.querySelector('form').onsubmit=run(async e=>{
  e.preventDefault();const button=e.target.querySelector('button');button.disabled=true;button.textContent='正在保存…';
  try{
    const files=[...e.target.elements.files.files],v=validateFiles(a.category,files);
    const cloudMode=state.mode==='cloud';
    let version={id:uid(),asset_id:a.id,number:Math.max(0,...state.versions.map(x=>x.number))+1,filename:v.mainFile.name,stats:{},created_at:new Date().toISOString()};
    if(cloudMode)version=await state.cloud.uploadVersion(a.id,version,files);else await db.putVersion(version,files);
    // The version is committed. Later status/preview errors must not invite a duplicate upload.
    if(state.selected?.id===a.id)state.versions.unshift(version);
    let warning='';
    const changed={...a,status:'review',updated_at:new Date().toISOString()};
    try{if(cloudMode)await state.cloud.saveAsset(changed);else await db.putAsset(changed);Object.assign(a,changed);}
    catch{warning='版本已保存，作品进度未能更新，请稍后重新设置进度。';}
    d.close();render();
    if(detail.isConnected&&state.selected?.id===a.id){
      detail.querySelector('#versions').insertAdjacentHTML('afterbegin','<option value="'+esc(version.id)+'">V'+version.number+' · '+esc(version.filename)+'</option>');
      detail.querySelector('#versions').value=version.id;
      const statusSelect=detail.querySelector('#asset-status');if(statusSelect)statusSelect.value=a.status;
      try{await loadVersion(detail,version.id);}catch{warning=warning||'版本已保存，预览暂时无法读取；请重新打开此作品。';}
    }
    toast(warning||(cloudMode?'版本已提交到共享评审。':'版本已保存到当前浏览器。'));
  }finally{if(d.isConnected){button.disabled=false;button.textContent='保存并预览';}}
 });
}
function editAsset(a,detail){
 const d=dialog('编辑作品说明','<form class="form-grid"><label class="field">作品名称<input name="title" required maxlength="80" value="'+esc(a.title)+'"></label><label class="field">制作说明<textarea name="description" maxlength="3000">'+esc(a.description)+'</textarea></label><div class="form-actions"><button class="button primary">保存说明</button></div></form>');
 d.querySelector('form').onsubmit=run(async e=>{e.preventDefault();const f=new FormData(e.target);const title=f.get('title').trim();if(!title)throw Error('请填写名称。');a.title=title;a.description=f.get('description').trim();a.updated_at=new Date().toISOString();if(state.mode==='cloud')await state.cloud.saveAsset(a);else await db.putAsset(a);d.close();detail.close();await refresh();await openAsset(a.id);toast('作品说明已保存。');});
}
async function downloadVersion(){if(!state.files.length)throw Error('当前没有可下载的原始文件。');const data={};for(const f of state.files)data[f.relativePath||f.name]=new Uint8Array(await f.arrayBuffer());const blob=new Blob([zipSync(data,{level:0})],{type:'application/zip'});const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=state.selected.title+'_V'+state.version.number+'.zip';a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);}
async function share(assetId=null){
 if(!state.cloud||state.mode!=='cloud'||state.role!=='owner'){toast('请先连接共享评审、登录所有者账号并上传作品，再生成老师专属链接。');settings();return;}
 if(location.protocol!=='https:'||['localhost','127.0.0.1','::1','[::1]'].includes(location.hostname))throw Error('请先把网站发布到 GitHub Pages，再从正式网址生成老师链接。');
 const deployed=state.deployedConfig;
 if(!deployed?.supabaseUrl||!deployed?.supabaseAnonKey||deployed.supabaseUrl.trim().replace(/\/$/,'')!==state.config.supabaseUrl.trim().replace(/\/$/,'')||deployed.supabaseAnonKey.trim()!==state.config.supabaseAnonKey.trim())throw Error('当前连接只在本机保存。请将相同的公开云配置发布到网站，再刷新页面生成老师链接；否则老师的设备无法连接。');
 const data=await state.cloud.createReviewLink(assetId);const url=new URL(location.href);url.hash='review='+data.token;url.search='';
 const d=dialog('老师专属评审链接','<p>老师打开链接即可预览和留言，无需注册账号。</p><label class="field">有效至 '+esc(date(data.expires_at))+'<input readonly id="review-url" value="'+esc(url.href)+'"></label><p class="help-text">此链接可访问'+(assetId?'当前作品':'全部共享作品')+'。你可以提前撤销，原始文件仍保留。</p><div class="form-actions"><button class="button ghost" id="revoke">撤销此链接</button><button class="button primary" id="copy-link">复制链接</button></div>');
 d.querySelector('#copy-link').onclick=run(async()=>{await navigator.clipboard.writeText(url.href);toast('链接已复制，可以发给老师。');});
 d.querySelector('#revoke').onclick=run(async()=>{await state.cloud.revokeReviewLink(data.id);d.close();toast('此评审链接已撤销。');});
}
function settings(){
 const d=dialog('连接与账户','<p class="help-text">GitHub Pages 托管页面；共享存储保存文件、版本与老师意见。未连接时仍可使用本机草稿。</p><form id="config-form" class="form-grid"><label class="field">Supabase 项目地址<input name="url" type="url" value="'+esc(state.config.supabaseUrl||'')+'" placeholder="https://你的项目.supabase.co"></label><label class="field">公开 publishable / anon key<input name="key" value="'+esc(state.config.supabaseAnonKey||'')+'" autocomplete="off" placeholder="仅填写公开密钥"></label><p class="help-text">这里不能填写 secret 或 service_role 密钥。正式部署请在仓库配置公开连接参数。</p><div class="form-actions"><button class="button ghost">连接共享评审</button></div></form><hr><form id="login-form" class="form-grid"><h3>学生 / 项目所有者登录</h3><label class="field">邮箱<input name="email" type="email" required placeholder="你的邮箱"></label><div class="form-actions"><button class="button primary">发送邮箱登录链接</button><button class="button ghost" type="button" id="signout">退出登录</button></div><p class="help-text">首次使用需要完成共享存储初始化，并把你的账户设置为项目所有者。老师只需专属链接。</p></form>');
 d.querySelector('#config-form').onsubmit=run(async e=>{e.preventDefault();const f=new FormData(e.target);const config={...state.config,supabaseUrl:f.get('url').trim(),supabaseAnonKey:f.get('key').trim()};const cloud=createCloud(config);state.cloud=cloud;state.config=config;localStorage.setItem('qixi-config',JSON.stringify(config));state.mode='cloud';await refresh();toast('连接参数已保存；请使用所有者邮箱登录。');});
 d.querySelector('#login-form').onsubmit=run(async e=>{e.preventDefault();if(!state.cloud)throw Error('请先连接共享评审。');await state.cloud.signIn(new FormData(e.target).get('email').trim());toast('登录链接已发送，请在邮箱中打开。');});
 d.querySelector('#signout').onclick=run(async()=>{await state.cloud?.signOut();state.mode='local';d.close();await refresh();toast('已退出共享评审账户。');});
}
function help(){dialog('提交与检查说明','<div class="help-content"><h3>1 · 添加作品与提交版本</h3><p>五类作品的数量不限。场景、角色、产品及动画提交一个 FBX，并同时选择外部贴图；游戏特效提交 MP4。新版本不会覆盖旧文件，意见按版本分别保存。</p><h3>2 · 检查模型</h3><p>旋转、平移、缩放模型，切换材质、线框与法向着色。结构面板可以开关实际节点；材质面板列出实际加载的材质和贴图槽。动画支持片段切换、时间拖动与速度调整。</p><p>三角面数是浏览器导入后三角化的数量，缓冲顶点并非建模软件原始顶点。FBX 材质与 UE 复杂材质可能不同；蒙皮动画应使用法向着色，静态箭头不会表达骨骼变形。只有骨架而没有角色网格的动画需要同时导出对应角色。</p><h3>3 · 给老师评审</h3><p>连接共享存储并以所有者登录，上传作品，再点击“邀请老师评审”。老师打开专属链接即可留下意见。意见会记录版本、模型视角或视频时间点；访客的“建议通过”不会自行改变你的作品进度。</p><h3>4 · 保存与部署</h3><p>“本机草稿”仅在当前浏览器可见，清除浏览器数据会影响草稿，请下载版本备份。GitHub Pages 负责网页托管，跨设备文件与意见由已配置的共享存储保存。MP4 推荐 H.264 / AAC 编码。</p></div>');}
async function boot(){
 try{const response=await fetch(new URL('config.json',document.baseURI),{cache:'no-store'});if(response.ok){state.deployedConfig=await response.json();state.config={...state.config,...state.deployedConfig};}}catch{}
 try{const saved=JSON.parse(localStorage.getItem('qixi-config')||'null');if(saved&&!state.token)state.config={...state.config,...saved};}catch{}
 if(state.config.supabaseUrl&&state.config.supabaseAnonKey){try{state.cloud=createCloud(state.config);if(await state.cloud.getSession())state.mode='cloud';}catch(e){toast(e.message);}}
 try{await refresh();}catch(e){render();toast(e.message);}
}
boot();
