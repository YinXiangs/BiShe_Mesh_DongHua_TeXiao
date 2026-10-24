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
function harness(handler){
 const storage=memoryStorage(),calls=[];
 const fetch=async(url,options)=>{const call={path:new URL(url).pathname+new URL(url).search,...options};calls.push(call);return handler(call,calls);};
 const api=createSharedApi(config,{storage,fetch,now:()=>NOW});return {api,storage,calls};
}

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
