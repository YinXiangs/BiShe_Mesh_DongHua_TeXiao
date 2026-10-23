import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { TGALoader } from 'three/addons/loaders/TGALoader.js';
import { VertexNormalsHelper } from 'three/addons/helpers/VertexNormalsHelper.js';

export function inspectObject(root) {
  let triangles=0,vertices=0,meshes=0,bones=0,skinned=0,missingNormals=0;
  const materials=new Map(),nodes=[];
  root.traverse(node=>{
    nodes.push({id:node.uuid,name:node.name||node.type,type:node.type,depth:depth(node,root),visible:node.visible});
    if(node.isBone) bones++;
    if(!node.isMesh) return;
    meshes++; if(node.isSkinnedMesh) skinned++;
    const g=node.geometry,p=g.getAttribute('position'); if(!p)return;
    const instances=node.isInstancedMesh?node.count:1;
    vertices+=p.count*instances; triangles+=(g.index?g.index.count:p.count)/3*instances;
    if(!g.getAttribute('normal'))missingNormals++;
    for(const m of (Array.isArray(node.material)?node.material:[node.material])) if(m) {
      const maps=['map','normalMap','bumpMap','roughnessMap','metalnessMap','emissiveMap','alphaMap'].filter(k=>m[k]).map(k=>({slot:k,name:m[k].name||'嵌入或外部贴图'}));
      materials.set(m.uuid,{id:m.uuid,name:m.name||'未命名材质',type:m.type,maps,color:m.color?'#'+m.color.getHexString():'#999999'});
    }
  });
  const box=new THREE.Box3().setFromObject(root),size=box.getSize(new THREE.Vector3());
  return {triangles:Math.round(triangles),vertices,meshes,bones,skinned,missingNormals,materialCount:materials.size,materials:[...materials.values()],nodes,size:size.toArray(),animations:(root.animations||[]).map(c=>({name:c.name||'未命名动作',duration:c.duration}))};
}
function depth(n,root){let d=0;while(n!==root&&n.parent){d++;n=n.parent;}return d;}
function dispose(root){root?.traverse(o=>{o.geometry?.dispose();for(const m of(Array.isArray(o.material)?o.material:[o.material]))if(m){for(const v of Object.values(m))if(v?.isTexture)v.dispose();m.dispose();}});}

export class ReviewViewer {
  constructor(container,onUpdate=()=>{},options={}) {
    this.container=container;this.onUpdate=onUpdate;this.urls=[];this.helpers=[];this.mode='material';this.playing=false;this.speed=1;this.frame=0;this.dead=false;this.clips=[];this.loadId=0;
    this.renderer=new THREE.WebGLRenderer({antialias:true,alpha:false,preserveDrawingBuffer:true});
    this.renderer.setPixelRatio(Math.min(devicePixelRatio,2));this.renderer.setClearColor(0x141e1a);this.renderer.outputColorSpace=THREE.SRGBColorSpace;
    this.renderer.toneMapping=THREE.ACESFilmicToneMapping;this.renderer.toneMappingExposure=1.25;
    this.renderer.domElement.className='viewer-canvas';this.renderer.domElement.setAttribute('aria-label','可旋转缩放的三维模型预览');container.append(this.renderer.domElement);
    this.scene=new THREE.Scene();this.camera=new THREE.PerspectiveCamera(42,1,.01,10000);this.camera.position.set(5,3.5,5);
    this.controls=new OrbitControls(this.camera,this.renderer.domElement);this.controls.enableDamping=true;
    this.scene.add(new THREE.HemisphereLight(0xffffff,0x737c61,3));
    const key=new THREE.DirectionalLight(0xffe6c7,3.5);key.position.set(5,8,6);this.scene.add(key);
    const fill=new THREE.DirectionalLight(0xb6d6e6,2);fill.position.set(-6,3,-3);this.scene.add(fill);
    this.grid=new THREE.GridHelper(20,20,0x4d6b5a,0x293f33);this.grid.position.y=-.015;this.grid.visible=options.grid!==false;this.scene.add(this.grid);
    this.resize=new ResizeObserver(()=>this.fitCanvas());this.resize.observe(container);this.clock=new THREE.Clock();
    this.loop=()=>{if(this.dead)return;this.frame=requestAnimationFrame(this.loop);const dt=Math.min(this.clock.getDelta(),.1);if(this.mixer&&this.playing)this.mixer.update(dt*this.speed);this.renderFrame();};if(options.animate!==false)this.loop();
  }
  renderFrame(){if(this.dead)return;this.controls.update();this.skeleton?.update();this.renderer.render(this.scene,this.camera);}
  fitCanvas(){const {width,height}=this.container.getBoundingClientRect();if(!width||!height)return;this.renderer.setSize(width,height,false);this.camera.aspect=width/height;this.camera.updateProjectionMatrix();this.renderFrame();}
  clear(){this.loadId++;this.clearHelpers();this.mixer?.stopAllAction();if(this.mixer&&this.root)this.mixer.uncacheRoot(this.root);if(this.root){this.scene.remove(this.root);dispose(this.root);}this.root=null;this.stats=null;this.mixer=null;this.action=null;this.clip=null;this.clips=[];this.playing=false;this.originals=new Map();for(const u of this.urls)URL.revokeObjectURL(u);this.urls=[];this.renderFrame();}
  async loadFiles(files){
    this.clear();const loadId=this.loadId,main=files.find(f=>/\.fbx$/i.test(f.name));if(!main)throw Error('请选择一个 FBX 模型或动画文件。');
    const map=new Map(),byName=new Map(),missing=new Set();
    for(const f of files){const u=URL.createObjectURL(f);this.urls.push(u);const name=normalize(f.relativePath||f.webkitRelativePath||f.name);map.set(name,u);byName.set(f.name.toLowerCase(),u);}
    const manager=new THREE.LoadingManager();let started=false,completeTextures,timer,object;
    const texturesReady=new Promise(resolve=>{completeTextures=resolve;});
    manager.onStart=()=>{started=true;};manager.onLoad=()=>completeTextures();
    const placeholder='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
    manager.setURLModifier(url=>{
      if(/^(blob:|data:)/i.test(url)){if(/^blob:/i.test(url)&&!this.urls.includes(url))this.urls.push(url);return url;}
      const n=normalize(url),basename=n.split('/').pop();const found=map.get(n)||byName.get(basename);
      if(found)return found;missing.add(url);return placeholder;
    });
    manager.addHandler(/\.tga$/i,new TGALoader(manager));
    manager.onError=url=>missing.add(url);
    try{
      const data=await main.arrayBuffer();if(this.dead||loadId!==this.loadId)throw Error('模型预览已取消。');object=new FBXLoader(manager).parse(data,'');
      if(started)await Promise.race([texturesReady,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('模型贴图读取超时，请检查贴图后重试。')),15000);})]);
      if(this.dead||loadId!==this.loadId)throw Error('模型预览已取消。');
      this.setObject(object);this.stats.missingTextures=[...missing];this.onUpdate(this.stats);this.renderFrame();return this.stats;
    }catch(error){if(object&&object!==this.root)dispose(object);if(loadId===this.loadId)this.clear();throw error;}
    finally{clearTimeout(timer);}
  }
  loadDemo(kind){this.clear();this.setObject(makeDemo(kind));return this.stats;}
  setObject(object){
    this.root=object;this.root.updateMatrixWorld(true);
    let box=new THREE.Box3().setFromObject(object),size=box.getSize(new THREE.Vector3()),center=box.getCenter(new THREE.Vector3());
    if(!Number.isFinite(size.length())||size.length()===0){dispose(object);throw Error('文件中没有可显示的几何体。动画文件可能需要对应的角色网格和骨架。');}
    const scale=5/Math.max(size.x,size.y,size.z);object.scale.multiplyScalar(scale);object.updateMatrixWorld(true);
    box=new THREE.Box3().setFromObject(object);center=box.getCenter(new THREE.Vector3());object.position.x-=center.x;object.position.z-=center.z;object.position.y-=box.min.y;
    object.updateMatrixWorld(true);this.scene.add(object);this.originals=new Map();
    object.traverse(o=>{if(o.isMesh)this.originals.set(o.uuid,o.material);});
    this.stats=inspectObject(object);this.clips=object.animations||[];
    if(this.clips.length){this.mixer=new THREE.AnimationMixer(object);this.selectClip(0);}
    this.resetCamera();this.setMode(this.mode);this.fitCanvas();this.onUpdate(this.stats);
  }
  resetCamera(){this.controls.target.set(0,1.7,0);this.camera.position.set(6.8,4.6,7.4);this.controls.update();this.renderFrame();}
  setMode(mode){this.mode=mode;this.clearHelpers();this.root?.traverse(o=>{if(!o.isMesh)return;
    const old=o.material,original=this.originals.get(o.uuid);if(old!==original)for(const m of(Array.isArray(old)?old:[old]))m.dispose();
    if(mode==='normal')o.material=new THREE.MeshNormalMaterial({side:THREE.DoubleSide});
    else if(mode==='wireframe')o.material=(Array.isArray(original)?original:[original]).map(m=>{const clone=m.clone();clone.wireframe=true;clone.map=null;clone.emissiveMap=null;clone.color?.set(0xadd7bf);clone.emissive?.set(0x2c4d3b);return clone;});
    else o.material=original;
  });this.renderFrame();}
  showNormals(on){this.clearHelpers();if(!on||!this.root){this.renderFrame();return;}if(this.stats.skinned){this.renderFrame();throw Error('骨骼动画请使用“法向着色”。箭头仅适用于静态网格。');}
    this.root.traverse(o=>{if(o.isMesh&&o.geometry.getAttribute('normal')){const h=new VertexNormalsHelper(o,.07,0x82cda2);this.scene.add(h);this.helpers.push(h);}});
    this.renderFrame();
  }
  clearHelpers(){for(const h of this.helpers){this.scene.remove(h);h.dispose();}this.helpers=[];if(this.skeleton){this.scene.remove(this.skeleton);this.skeleton.dispose();this.skeleton=null;}}
  showSkeleton(on){if(this.skeleton){this.scene.remove(this.skeleton);this.skeleton.dispose();this.skeleton=null;}if(on&&this.root){this.skeleton=new THREE.SkeletonHelper(this.root);this.scene.add(this.skeleton);}this.renderFrame();}
  nodeVisible(id,value){const o=this.root?.getObjectByProperty('uuid',id);if(o)o.visible=value;this.renderFrame();}
  selectClip(i){if(!this.mixer)return;this.mixer.stopAllAction();this.clip=this.clips[i];this.action=this.mixer.clipAction(this.clip);this.action.play();this.mixer.setTime(0);this.playing=true;this.renderFrame();}
  setTime(t){if(this.mixer){this.mixer.setTime(Number(t));this.playing=false;this.renderFrame();}}
  context(){return {camera:this.camera.position.toArray(),target:this.controls.target.toArray(),time:this.action?.time||0,clip:this.clip?.name||'',mode:this.mode};}
  restore(c){if(c?.camera?.length===3&&c?.target?.length===3&&[...c.camera,...c.target].every(Number.isFinite)){this.camera.position.fromArray(c.camera);this.controls.target.fromArray(c.target);this.controls.update();}if(Number.isFinite(c?.time))this.setTime(c.time);this.renderFrame();}
  thumbnail(){this.renderFrame();return encodeThumbnail(this.renderer.domElement);}
  destroy(){this.dead=true;cancelAnimationFrame(this.frame);this.resize.disconnect();this.controls.dispose();this.clear();this.grid.geometry.dispose();this.grid.material.dispose();this.renderer.dispose();this.renderer.domElement.remove();}
}
export function encodeThumbnail(source,{width=640,height=400,maxBytes=180*1024}={}){
  const canvas=document.createElement('canvas');let quality=.78;
  canvas.width=width;canvas.height=height;
  for(;;){
    const context=canvas.getContext('2d');if(!context)throw Error('当前浏览器无法生成预览图片。');
    context.fillStyle='#141e1a';context.fillRect(0,0,canvas.width,canvas.height);
    const sourceWidth=source.videoWidth||source.width,sourceHeight=source.videoHeight||source.height;
    if(!sourceWidth||!sourceHeight)throw Error('文件没有可生成预览的画面。');
    const ratio=Math.min(canvas.width/sourceWidth,canvas.height/sourceHeight),w=sourceWidth*ratio,h=sourceHeight*ratio;
    context.drawImage(source,(canvas.width-w)/2,(canvas.height-h)/2,w,h);
    const image=canvas.toDataURL('image/jpeg',quality);
    if(!image.startsWith('data:image/jpeg;base64,'))throw Error('浏览器无法编码 JPEG 预览图片。');
    if(image.length<=maxBytes)return image;
    if(quality>.46)quality=Math.max(.46,quality-.12);
    else if(canvas.width>160){canvas.width=Math.max(160,Math.floor(canvas.width*.75));canvas.height=Math.max(100,Math.floor(canvas.height*.75));}
    else throw Error('预览图片超过大小限制，请重试。');
  }
}
function normalize(p){try{p=decodeURIComponent(p);}catch{}return p.replace(/\\/g,'/').replace(/^\.\//,'').toLowerCase();}

export function makeDemo(kind='scene'){
  const g=new THREE.Group();g.name='演示资产 · 非你的提交';
  const mats={green:new THREE.MeshStandardMaterial({color:0x3c6250,roughness:.85}),roof:new THREE.MeshStandardMaterial({color:0x994f3c,roughness:.9}),wood:new THREE.MeshStandardMaterial({color:0xc1945c,roughness:.85}),cream:new THREE.MeshStandardMaterial({color:0xf0dfbd,roughness:.9}),dark:new THREE.MeshStandardMaterial({color:0x263f36}),gold:new THREE.MeshStandardMaterial({color:0xc8a060,metalness:.5,roughness:.5})};
  function add(name,geo,mat,x,y,z){const m=new THREE.Mesh(geo,mats[mat]);m.name=name;m.position.set(x,y,z);g.add(m);return m;}
  const box=(n,s,m,p)=>add(n,new THREE.BoxGeometry(...s),m,...p);
  if(kind==='product'){
    box('邮筒主体',[1.6,2.5,1.25],'green',[0,1.6,0]);add('圆拱顶',new THREE.CylinderGeometry(.8,.8,1.25,24,1,false,0,Math.PI),'green',0,2.85,0).rotation.z=Math.PI/2;
    box('投信口',[1.1,.12,.08],'dark',[0,2.45,.66]);box('门板',[1.15,1.1,.06],'cream',[0,1.15,.66]);box('底座',[2,.3,1.6],'dark',[0,.15,0]);
    box('邮局标牌',[.75,.36,.05],'gold',[0,1.65,.71]);
  }else if(kind==='character'){
    add('邮差头部',new THREE.SphereGeometry(.49,20,14),'cream',0,2.95,0);add('邮差帽',new THREE.CylinderGeometry(.58,.58,.2,20),'green',0,3.35,0);
    add('外套',new THREE.CylinderGeometry(.48,.7,1.25,12),'green',0,1.95,0);box('挎包',[.75,.65,.35],'wood',[.65,1.5,.3]);
    for(const x of[-.29,.29]){box('裤腿',[.35,.8,.4],'dark',[x,.8,0]);box('靴子',[.4,.3,.65],'wood',[x,.25,.12]);}
    for(const x of[-.63,.63])add('衣袖',new THREE.CapsuleGeometry(.19,.75,5,10),'green',x,1.95,0);
  }else if(kind==='animation'){
    add('身体',new THREE.SphereGeometry(.7,20,14),'cream',0,1.8,0);const wing=box('旋转展示翼',[2.8,.15,.75],'green',[0,2,0]);
    const track=new THREE.NumberKeyframeTrack(wing.name+'.rotation[z]',[0,.5,1,1.5,2],[0,.35,0,-.35,0]);g.animations=[new THREE.AnimationClip('演示 · 翅膀摆动',2,[track])];
    add('嘴',new THREE.ConeGeometry(.2,.7,8),'gold',0,1.8,.85).rotation.x=Math.PI/2;
  }else{
    box('石砌基座',[4.8,.3,3.9],'dark',[0,.15,0]);box('邮局墙体',[3.9,2.8,3],'cream',[0,1.7,0]);
    const geo=new THREE.CylinderGeometry(2.7,2.7,3.6,3,1,false);const roof=add('三角屋顶',geo,'roof',0,3.7,0);roof.rotation.z=Math.PI/2;roof.rotation.y=Math.PI/2;
    box('木门',[.9,1.9,.12],'green',[0,1.25,1.56]);box('门楣',[1.8,.42,.2],'wood',[0,2.55,1.65]);
    for(const x of[-1.3,1.3]){box('窗框',[.7,.9,.12],'wood',[x,1.9,1.57]);box('玻璃',[.53,.72,.14],'green',[x,1.9,1.59]);}
    box('烟囱',[.55,1.4,.55],'dark',[1,4.25,-.4]);
  }
  return g;
}
