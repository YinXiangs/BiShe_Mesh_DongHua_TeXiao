import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSharedApi, relativeFileName, planLegacyVersions } from '../src/shared-api.js';

const A='2a9ca496-54de-48c2-aae3-48d33ea55bd1';
const V='62ad4931-76aa-45d1-bc05-cae62dd83dc2';
const NOW=1_800_000_000_000;
const config={apiUrl:'https://shared.example.test'};
const grant=(role='student')=>({token:'synthetic-token-for-'+role+'-abcdefghijklmnop',role,expiresAt:new Date(NOW+28_800_000).toISOString()});
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
function memoryStorage(){const map=new Map();return {map,getItem:key=>map.get(key)||null,setItem:(key,value)=>map.set(key,value),removeItem:key=>map.delete(key)};}
function harness(handler,options={}){
 const storage=memoryStorage(),calls=[];
 const fetch=async(url,options)=>{const call={path:new URL(url).pathname+new URL(url).search,...options};calls.push(call);return handler(call,calls);};
 const api=createSharedApi(config,{storage,fetch,now:()=>NOW,...options});return {api,storage,calls};
}
function readinessHarness(handler){
 let clock=NOW,nextTimer=0;const timers=new Map(),calls=[],delays=[];
 const api=createSharedApi(config,{storage:memoryStorage(),now:()=>clock,
  setTimeout:(callback,milliseconds)=>{const id=++nextTimer;timers.set(id,{callback,milliseconds});return id;},
  clearTimeout:id=>timers.delete(id),sleep:async(milliseconds,{signal}={})=>{assert(!signal?.aborted);delays.push(milliseconds);clock+=milliseconds;},
  fetch:async(url,options)=>{
   const call={path:new URL(url).pathname,...options};calls.push(call);
   const expire=()=>{const pending=[...timers.values()][0];assert(pending);clock+=pending.milliseconds;pending.callback();};
   return handler(call,calls,{expire,clock:()=>clock});
  },
 });return {api,calls,delays,clock:()=>clock,timers};
}

test('readiness retries only anonymous health GETs, then login is a single independent request',async()=>{
 const healthy={ok:true,storageReady:true,version:'qixi-shared-v1'};let waits=0;
 const {api,calls,delays,timers}=readinessHarness((call,all)=>{
  if(call.path==='/api/login')return json(grant());
  if(all.length===1)throw Error('cold service connection closed');
  if(all.length===2)return new Response('<html>starting</html>',{status:503});
  return json(healthy);
 });
 assert.deepEqual(await api.ensureReady({onWait:()=>waits++}),healthy);
 assert.equal(calls.length,3);assert.equal(waits,3);assert.deepEqual(delays,[5000,5000]);assert.equal(timers.size,0);
 assert(calls.every(call=>call.method==='GET'&&call.path==='/api/health'&&call.body===undefined&&call.credentials==='omit'&&!call.headers));
 await api.loginWithCode('synthetic teacher');assert.equal(calls.filter(call=>call.method==='POST').length,1);assert.equal(calls.at(-1).path,'/api/login');
});

test('invalid JSON, wrong service identity and incomplete storage never authorize a login',async()=>{
 const responses=[new Response('<html>starting</html>'),json({ok:true,storageReady:true,version:'other-service'}),json({ok:true,storageReady:false,version:'qixi-shared-v1'}),json({ok:true,storageReady:true,version:'qixi-shared-v1'})];
 const {api,calls}=readinessHarness(()=>responses.shift());
 await api.ensureReady();assert.equal(calls.length,4);assert(calls.every(call=>call.method==='GET'));assert.equal(await api.role(),null);
});

test('cold-start readiness has a ninety-second total bound even for immediate invalid health responses',async()=>{
 const {api,calls,clock}=readinessHarness(()=>json({ok:true,storageReady:true,version:'wrong'}));
 await assert.rejects(api.ensureReady(),error=>error.timeout&&error.message.includes('启动时间较长'));
 assert.equal(clock()-NOW,90000);assert.equal(calls.length,18);assert(calls.every(call=>call.method==='GET'));assert.equal(await api.role(),null);
});

test('eight-second attempt deadline covers a hung fetch and a hung JSON body, aborting both before retry',async()=>{
 const healthy={ok:true,storageReady:true,version:'qixi-shared-v1'};
 const {api,calls,clock,timers}=readinessHarness((call,all,{expire})=>{
  if(all.length===1){queueMicrotask(expire);return new Promise(()=>{});}
  if(all.length===2)return {ok:true,json:()=>{queueMicrotask(expire);return new Promise(()=>{});}};
  return json(healthy);
 });
 assert.deepEqual(await api.ensureReady(),healthy);assert.equal(calls.length,3);assert(calls[0].signal.aborted);assert(calls[1].signal.aborted);assert.equal(clock()-NOW,26000);assert.equal(timers.size,0);
});

test('fetch AbortError from an internal attempt timeout is retried rather than treated as caller cancellation',async()=>{
 const {api,calls}=readinessHarness((call,all,{expire})=>{
  if(all.length===1)return new Promise((_,reject)=>{call.signal.addEventListener('abort',()=>reject(Object.assign(Error('fetch was aborted'),{name:'AbortError'})),{once:true});queueMicrotask(expire);});
  return json({ok:true,storageReady:true,version:'qixi-shared-v1'});
 });
 assert.equal((await api.ensureReady()).ok,true);assert.equal(calls.length,2);assert(calls[0].signal.aborted);
});

test('real readiness access errors and caller cancellation are returned without login or repeated mutations',async()=>{
 const denied=readinessHarness(()=>json({error:'service access denied'},401));
 await assert.rejects(denied.api.ensureReady(),error=>error.status===401&&error.message==='service access denied');assert.equal(denied.calls.length,1);assert.equal(denied.timers.size,0);
 const controller=new AbortController();const cancelled=readinessHarness(()=>{controller.abort();return new Promise(()=>{});});
 await assert.rejects(cancelled.api.ensureReady({signal:controller.signal}),error=>error.name==='AbortError');assert.equal(cancelled.calls.length,1);assert.equal(cancelled.timers.size,0);
});

test('server authentication uses expiring Bearer session, never browser cookies or a local role as authority',async()=>{
 const {api,calls,storage}=harness(call=>call.path==='/api/login'?json(grant()):call.path==='/api/session'?json({role:'student',expiresAt:grant().expiresAt}):json({assets:[]}));
 await api.loginWithCode('synthetic passphrase');
 assert.equal(await api.role(),'owner');
 assert.equal((await api.getSession()).role,'student');
 assert.deepEqual(await api.listAssets(),[]);
 assert.equal(calls[0].headers.has('Authorization'),false);
 assert.equal(calls.at(-1).headers.get('Authorization'),'Bearer '+grant().token);
 assert(calls.every(call=>call.credentials==='omit'&&call.cache==='no-store'));
 const persisted=[...storage.map.values()].join('');assert(!persisted.includes('synthetic passphrase'));
});

test('expired persisted login is discarded and cannot turn into a local submission mode',async()=>{
 const storage=memoryStorage();storage.setItem('qixi-shared-session-v1:https://shared.example.test/api',JSON.stringify({...grant(),expiresAt:NOW-1}));
 let fetched=false;const api=createSharedApi(config,{storage,now:()=>NOW,fetch:()=>{fetched=true;}});
 assert.equal(await api.getSession(),null);assert.equal(await api.role(),null);assert.equal(storage.map.size,0);
 await assert.rejects(api.listAssets(),error=>error.status===401);assert.equal(fetched,false);
});

test('401 invalidates the main token and calls the application logout hook',async()=>{
 let denied=false,unauthorized=0;const storage=memoryStorage();
 const api=createSharedApi(config,{storage,now:()=>NOW,onUnauthorized:()=>unauthorized++,fetch:async url=>url.endsWith('/login')?json(grant()):denied?json({error:'登录已过期'},401):json({assets:[]})});
 await api.loginWithCode('synthetic');denied=true;
 await assert.rejects(api.listAssets(),error=>error.status===401);assert.equal(await api.role(),null);assert.equal(unauthorized,1);assert.equal(storage.map.size,0);
});

test('teacher-confirmed migration uses a separate token and does not replace student login',async()=>{
 const {api,calls}=harness(call=>call.path==='/api/login'?json(JSON.parse(call.body).password==='synthetic teacher'?grant('teacher'):grant()):call.path.endsWith('/import-review')?json({id:A,status:'approved'}):json({ok:true}));
 await api.loginWithCode('synthetic student');const temporary=await api.loginWithCode('synthetic teacher',{persist:false});
 assert.equal(await api.role(),'owner');
 await api.importReview(A,{asset:{id:A,status:'approved'},versions:[],comments:[]},temporary.token);
 assert.equal(calls.at(-1).headers.get('Authorization'),'Bearer '+grant('teacher').token);
 await api.logoutToken(temporary.token);assert.equal(await api.role(),'owner');
});

test('metadata updates cannot send student-controlled review or read fields',async()=>{
 const {api,calls}=harness(call=>call.path.endsWith('/login')?json(grant()):json({id:A,title:'岩石'}));
 await api.loginWithCode('synthetic');await api.saveAsset({id:A,title:'岩石',description:'说明',status:'approved',teacher_read_at:'forged'});
 assert.deepEqual(JSON.parse(calls.at(-1).body),{title:'岩石',description:'说明'});
});

test('multipart upload preserves exact file bytes, relative paths and immutable version id, retrying transient part failures',async()=>{
 const content=new Uint8Array(5*1024*1024+11);content.fill(17);content[content.length-1]=93;
 const file=new File([content],'岩石.fbx');Object.defineProperty(file,'relativePath',{value:'模型/岩石.fbx'});
 const sent=[];let retry=true;const version={id:V,asset_id:A,number:1,filename:file.name,files:[]};
 const {api,calls}=harness(async call=>{
  if(call.path==='/api/login')return json(grant());
  if(call.path.endsWith('/uploads'))return json({id:'upload-1',files:[{id:'file-1',partSize:5242880,partCount:2}]});
  if(call.method==='PUT'){
   if(retry){retry=false;throw Error('connection reset');}
   sent.push(new Uint8Array(await call.body.arrayBuffer()));return json({ok:true});
  }
  if(call.path.endsWith('/commit'))return json(version);
  throw Error('Unexpected '+call.path);
 });
 await api.loginWithCode('synthetic');const progress=[];
 assert.deepEqual(await api.uploadVersion(A,{id:V,filename:file.name,stats:{triangles:12}},[file],item=>progress.push(item)),version);
 const begin=JSON.parse(calls.find(call=>call.path.endsWith('/uploads')).body);
 assert.equal(begin.versionId,V);assert.equal(begin.files[0].relative_path,'模型/岩石.fbx');assert.equal(begin.files[0].size,content.length);
 assert.equal(sent.length,2);assert.deepEqual(sent[0],content.subarray(0,5242880));assert.deepEqual(sent[1],content.subarray(5242880));
 assert.equal(progress.at(-1).sent,content.length);assert(!calls.some(call=>call.method==='DELETE'));
});

test('a lost commit response checks committed versions before cleanup or another upload',async()=>{
 const version={id:V,asset_id:A,number:1};
 const {api,calls}=harness(call=>{
  if(call.path==='/api/login')return json(grant());
  if(call.path.endsWith('/uploads'))return json({id:'upload-1',files:[{id:'file-1',partSize:5242880,partCount:1}]});
  if(call.method==='PUT')return json({ok:true});
  if(call.path.endsWith('/commit'))throw Error('lost response');
  if(call.path.endsWith('/versions'))return json({versions:[version]});
  throw Error('Unexpected request');
 });
 await api.loginWithCode('synthetic');assert.deepEqual(await api.uploadVersion(A,{id:V,filename:'rock.fbx'},[new File(['model'],'rock.fbx')]),version);
 assert(!calls.some(call=>call.method==='DELETE'));
});

test('an uncertain commit preserves server bytes and reports an actionable pending result',async()=>{
 const {api,calls}=harness(call=>{
  if(call.path==='/api/login')return json(grant());
  if(call.path.endsWith('/uploads'))return json({id:'upload-1',files:[{id:'file-1',partSize:5242880}]});
  if(call.method==='PUT')return json({ok:true});
  throw Error('offline');
 });
 await api.loginWithCode('synthetic');await assert.rejects(api.uploadVersion(A,{id:V,filename:'rock.fbx'},[new File(['model'],'rock.fbx')]),error=>error.uncertain&&error.versionId===V);
 assert(!calls.some(call=>call.method==='DELETE'));
});

test('permanent part failure aborts only incomplete upload and never attempts commit',async()=>{
 const {api,calls}=harness(call=>{
  if(call.path==='/api/login')return json(grant());
  if(call.path.endsWith('/uploads'))return json({id:'upload-1',files:[{id:'file-1',partSize:5242880}]});
  if(call.method==='PUT')return json({error:'file quota exceeded'},413);
  if(call.method==='DELETE')return json({ok:true});
  throw Error('Unexpected request');
 });
 await api.loginWithCode('synthetic');await assert.rejects(api.uploadVersion(A,{id:V,filename:'rock.fbx'},[new File(['model'],'rock.fbx')]),/quota/);
 assert.equal(calls.filter(call=>call.method==='PUT').length,1);assert(calls.some(call=>call.method==='DELETE'));assert(!calls.some(call=>call.path.endsWith('/commit')));
});

test('idempotent begin skips parts for a committed version',async()=>{
 const version={id:V,number:1};const {api,calls}=harness(call=>call.path==='/api/login'?json(grant()):json({completed:true,version}));
 await api.loginWithCode('synthetic');assert.deepEqual(await api.uploadVersion(A,{id:V,filename:'rock.fbx'},[new File(['model'],'rock.fbx')]),version);
 assert.equal(calls.length,2);
});

test('partial commit resume skips completed files and uploads remaining files before commit',async()=>{
 const version={id:V,number:1};const {api,calls}=harness(call=>{
  if(call.path==='/api/login')return json(grant());
  if(call.path.endsWith('/uploads'))return json({id:'upload-1',files:[{id:'finished-file',partSize:5242880,partCount:1,completed:true},{id:'remaining-file',partSize:5242880,partCount:1,completed:false}]});
  if(call.method==='PUT')return json({ok:true});
  if(call.path.endsWith('/commit'))return json(version);
  throw Error('Unexpected request');
 });
 await api.loginWithCode('synthetic');const progress=[];
 assert.deepEqual(await api.uploadVersion(A,{id:V,filename:'rock.fbx'},[new File(['model'],'rock.fbx'),new File(['texture'],'albedo.png')],value=>progress.push(value)),version);
 const parts=calls.filter(call=>call.method==='PUT');assert.equal(parts.length,1);assert(parts[0].path.includes('remaining-file'));assert.equal(progress.at(-1).sent,12);assert(!calls.some(call=>call.method==='DELETE'));
});

test('transient partial commit failures preserve task for resuming the same immutable version',async()=>{
 const {api,calls}=harness(call=>{
  if(call.path==='/api/login')return json(grant());
  if(call.path.endsWith('/uploads'))return json({id:'upload-1',files:[{id:'file-1',partSize:5242880}]});
  if(call.method==='PUT')return json({ok:true});
  if(call.path.endsWith('/commit'))return json({error:'storage temporarily unavailable',uploadId:'upload-1'},503);
  if(call.path.endsWith('/versions'))return json({versions:[]});
  throw Error('Unexpected request');
 });
 await api.loginWithCode('synthetic');await assert.rejects(api.uploadVersion(A,{id:V,filename:'rock.fbx'},[new File(['model'],'rock.fbx')]),error=>error.retryable&&error.uploadId==='upload-1'&&error.versionId===V);
 assert(!calls.some(call=>call.method==='DELETE'));
});

test('download restores the actual byte contents and relative texture location',async()=>{
 const bytes=new Uint8Array([31,9,24,0,222]);const {api,calls}=harness(call=>call.path==='/api/login'?json(grant()):new Response(bytes));
 await api.loginWithCode('synthetic');const [file]=await api.downloadVersion({files:[{id:'file-1',name:'albedo.png',relative_path:'Textures/albedo.png',type:'image/png'}]});
 assert.equal(file.name,'albedo.png');assert.equal(file.relativePath,'Textures/albedo.png');assert.deepEqual(new Uint8Array(await file.arrayBuffer()),bytes);assert.equal(calls.at(-1).headers.get('Authorization'),'Bearer '+grant().token);
});

test('single-file preview downloads only its requested image, preserving bytes, MIME, path and chunk progress',async()=>{
 const bytes=new Uint8Array([1,3,5,7,9]);const progress=[];
 const {api,calls}=harness(call=>call.path==='/api/login'?json(grant()):new Response(new ReadableStream({start(controller){controller.enqueue(bytes.subarray(0,2));controller.enqueue(bytes.subarray(2));controller.close();}}),{headers:{'content-length':'5'}}));
 await api.loginWithCode('synthetic');
 const image=await api.downloadFile({id:'image-1',name:'正视图.png',relative_path:'三视图/正视图.png',type:'image/png',size:5},{onProgress:item=>progress.push(item)});
 assert.deepEqual(calls.map(call=>call.path),['/api/login','/api/files/image-1']);
 assert.equal(image.name,'正视图.png');assert.equal(image.relativePath,'三视图/正视图.png');assert.equal(image.type,'image/png');
 assert.deepEqual(new Uint8Array(await image.arrayBuffer()),bytes);
 assert.deepEqual(progress.map(item=>item.received),[0,2,5]);assert(progress.every(item=>item.total===5&&item.filename===image.name));
 const download=calls.at(-1);assert.equal(download.method,'GET');assert.equal(download.headers.get('Authorization'),'Bearer '+grant().token);assert(download.signal);assert(!download.path.includes('token'));assert(!download.signal.aborted);
});

test('video-only download infers MIME and total from response headers without fetching any FBX',async()=>{
 const {api,calls}=harness(call=>call.path==='/api/login'?json(grant()):new Response('mp4bytes',{headers:{'content-type':'video/mp4','content-length':'8'}}));
 await api.loginWithCode('synthetic');const progress=[];
 const video=await api.downloadFile({id:'video-1',name:'动画.mp4'},{onProgress:item=>progress.push(item)});
 assert.equal(video.type,'video/mp4');assert.equal(video.relativePath,'动画.mp4');assert.equal(progress.at(-1).received,8);assert.equal(progress.at(-1).total,8);
 assert.deepEqual(calls.filter(call=>call.path.startsWith('/api/files/')).map(call=>call.path),['/api/files/video-1']);
});

test('single-file 401 clears the current login and notifies the existing logout hook once',async()=>{
 let unauthorized=0;const {api,storage,calls}=harness(call=>call.path==='/api/login'?json(grant()):json({error:'会话过期'},401),{onUnauthorized:()=>unauthorized++});
 await api.loginWithCode('synthetic');await assert.rejects(api.downloadFile({id:'image-1',name:'front.jpg'}),error=>error.status===401&&error.message==='会话过期');
 assert.equal(unauthorized,1);assert.equal(storage.map.size,0);assert.equal(await api.role(),null);assert.equal(calls.length,2);
});

test('cancelling a single-file preview aborts its stream and a pre-cancelled download sends no request',async()=>{
 let cancelled=0;const controller=new AbortController();
 const {api,calls}=harness(call=>call.path==='/api/login'?json(grant()):new Response(new ReadableStream({start(stream){stream.enqueue(new Uint8Array([1,2]));},cancel(){cancelled++;}})));
 await api.loginWithCode('synthetic');
 await assert.rejects(api.downloadFile({id:'image-1',name:'front.png'},{signal:controller.signal,onProgress:({received})=>{if(received)controller.abort();}}),error=>error.name==='AbortError');
 assert(calls.at(-1).signal.aborted);assert(cancelled>=1);assert.equal(await api.role(),'owner');
 const before=calls.length;await assert.rejects(api.downloadFile({id:'image-2',name:'side.png'},{signal:controller.signal}),error=>error.name==='AbortError');assert.equal(calls.length,before);
});

test('idle download deadlines bound a hung fetch, a stalled stream and a stalled non-streaming body',async()=>{
 for(const mode of ['fetch','stream','blob']){
  let next=0;const timers=new Map();let abortSignal;
  const {api}=harness(call=>{
   if(call.path==='/api/login')return json(grant());
   abortSignal=call.signal;
   const expire=()=>{const idle=[...timers.values()].find(timer=>timer.ms===60000);assert(idle);idle.callback();};
   if(mode==='fetch'){queueMicrotask(expire);return new Promise(()=>{});}
   if(mode==='blob')return {ok:true,headers:new Headers(),blob:()=>{queueMicrotask(expire);return new Promise(()=>{});}};
   return {ok:true,headers:new Headers(),body:{getReader:()=>({read:()=>{queueMicrotask(expire);return new Promise(()=>{});},cancel:()=>Promise.resolve()})}};
  },{setTimeout:(callback,ms)=>{const id=++next;timers.set(id,{callback,ms});return id;},clearTimeout:id=>timers.delete(id)});
  await api.loginWithCode('synthetic');await assert.rejects(api.downloadFile({id:'image-1',name:'front.png'}),error=>error.timeout&&error.message.includes('下载超时'));
  assert(abortSignal.aborted);assert.equal(timers.size,0);assert.equal(await api.role(),'owner');
 }
});

test('partial and failed file bodies show retryable download errors without invalidating login',async()=>{
 for(const response of [new Response('short'),new Response(new ReadableStream({start(controller){controller.error(Error('connection reset'));}}))]){
  const {api}=harness(call=>call.path==='/api/login'?json(grant()):response);
  await api.loginWithCode('synthetic');await assert.rejects(api.downloadFile({id:'image-1',name:'front.png',size:20}),error=>error.network&&/下载不完整|下载中断/.test(error.message));assert.equal(await api.role(),'owner');
 }
});

test('malformed preview metadata fails before making a remote file request',async()=>{
 const {api,calls}=harness(()=>json(grant()));await api.loginWithCode('synthetic');
 for(const metadata of [{name:'front.png'},{id:'image-1',name:'front.png',relative_path:'../front.png'},{id:'image-1',name:'front.png',size:201*1024*1024}])await assert.rejects(api.downloadFile(metadata));
 assert.equal(calls.length,1);
});

test('invalid paths, file limits and insecure API origins fail before remote uploads',async()=>{
 for(const path of ['../rock.fbx','/rock.fbx','C:/rock.fbx','a//rock.fbx','textures/other.fbx'])assert.throws(()=>relativeFileName({name:'rock.fbx',relativePath:path}));
 assert.equal(relativeFileName({name:'rock.fbx',relativePath:'assets\\rock.fbx'}),'assets/rock.fbx');
 assert.throws(()=>createSharedApi({apiUrl:'http://remote.example.test'}));
 const {api,calls}=harness(()=>json(grant()));await api.loginWithCode('synthetic');
 await assert.rejects(api.uploadVersion(A,{id:V},[new File([],'rock.fbx')]),/200 MB/);
 assert.equal(calls.length,1);
});

test('legacy migration never appends stale files after a newer version created on another device',()=>{
 const local=[{id:'old-v2',number:2},{id:'old-v1',number:1}],cloud=[{id:'old-v1',number:1},{id:'new-shared-v2',number:2}];
 const original=structuredClone({local,cloud});
 assert.throws(()=>planLegacyVersions(local,cloud),error=>error.status===409&&error.message.includes('未追加旧版本'));
 assert.deepEqual({local,cloud},original);
 assert.deepEqual(planLegacyVersions(local,[cloud[0]]),[local[0]]);
 assert.deepEqual(planLegacyVersions(local,[]),[local[1],local[0]]);
 assert.deepEqual(planLegacyVersions(local,[...local,{id:'new-shared-v3',number:3}]),[]);
});

test('shared boot never reads a browser-specific configuration or falls back to local assets',async()=>{
 const source=await readFile(new URL('../src/app.js',import.meta.url),'utf8');
 const boot=source.slice(source.indexOf('async function boot(){'),source.indexOf('let backgroundRefresh='));
 assert(boot.includes('createSharedApi'));assert(boot.includes('getSession()'));
 assert(!boot.includes('createCloud('));assert(!boot.includes('qixi-config'));assert(!boot.includes('db.getAssets'));assert(!boot.includes('verifyEntryPassword'));
 assert(source.includes('state.cloud.importReview(asset.id,{asset,versions:versions.map(({id,number})=>({id,number})),comments},teacherGrant.token)'));
 assert(!source.includes('db.putAsset(a)'));
});
