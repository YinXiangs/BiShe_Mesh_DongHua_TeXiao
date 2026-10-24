import { ReviewViewer, encodeThumbnail } from './viewer.js';
import { validateFiles } from './validation.js';
import { PREVIEW_REVISION } from './material-preview.js';

let jobs=Promise.resolve(),viewer,host;

// Both card backfills and new submissions share one renderer and one media job.
export function generateMediaThumbnail(inputFiles,category){
  const files=Array.from(inputFiles||[]);
  const job=jobs.then(()=>generate(files,category));
  jobs=job.catch(()=>{});
  return job;
}

function modelViewer(){
  if(viewer)return viewer;
  host=document.createElement('div');
  host.setAttribute('aria-hidden','true');
  host.style.cssText='position:fixed;left:-10000px;top:0;width:640px;height:400px;overflow:hidden;pointer-events:none;';
  document.body.append(host);
  try{viewer=new ReviewViewer(host,()=>{},{animate:false,grid:false});viewer.renderer.setPixelRatio(1);viewer.fitCanvas();return viewer;}
  catch(error){host.remove();host=null;throw error;}
}

async function generate(files,category){
  const {mainFile}=validateFiles(category,files);
  if(category==='vfx')return videoThumbnail(mainFile);
  const preview=modelViewer();
  try{
    await preview.loadFiles(files);
    preview.setMode('material');
    if(preview.clips.length){preview.selectClip(0);preview.setTime(Math.min(1,Math.max(0,preview.clip.duration*.25)));}
    const stats=preview.stats;
    return {thumbnail:preview.thumbnail(),stats:{
      previewRevision:PREVIEW_REVISION,
      triangles:stats.triangles,vertices:stats.vertices,meshes:stats.meshes,
      materialCount:stats.materialCount,bones:stats.bones,skinned:stats.skinned,
      animationCount:preview.clips.length,
      missingTextures:(stats.missingTextures||[]).slice(0,20).map(name=>String(name).slice(0,200)),
    }};
  }finally{preview.clear();}
}

async function videoThumbnail(file){
  const video=document.createElement('video'),url=URL.createObjectURL(file),deadline=Date.now()+20000;
  video.preload='auto';video.muted=true;video.playsInline=true;
  try{
    video.src=url;video.load();
    await mediaReady(video,['loadedmetadata','durationchange'],()=>video.readyState>=1,deadline);
    if(!video.videoWidth||!video.videoHeight)throw Error('视频没有可读取的画面。');
    await mediaReady(video,['loadeddata','canplay'],()=>video.readyState>=2,deadline);
    const time=Number.isFinite(video.duration)&&video.duration>0?Math.min(1,video.duration*.2):0;
    if(time>.001){
      video.currentTime=time;
      await mediaReady(video,['seeked','loadeddata','canplay'],()=>!video.seeking&&video.readyState>=2&&Math.abs(video.currentTime-time)<.1,deadline);
    }
    return {thumbnail:encodeThumbnail(video),stats:{duration:Number.isFinite(video.duration)?video.duration:null,width:video.videoWidth,height:video.videoHeight,size:file.size}};
  }finally{
    video.pause();video.removeAttribute('src');video.load();video.remove();URL.revokeObjectURL(url);
  }
}

function mediaReady(video,events,ready,deadline){
  if(video.error)return Promise.reject(Error('视频无法解码，请使用 H.264 / AAC 编码的 MP4。'));
  if(ready())return Promise.resolve();
  return new Promise((resolve,reject)=>{
    const cleanup=()=>{clearTimeout(timer);for(const event of events)video.removeEventListener(event,check);video.removeEventListener('error',failed);};
    const check=()=>{if(ready()){cleanup();resolve();}};
    const failed=()=>{cleanup();reject(Error('视频无法解码，请使用 H.264 / AAC 编码的 MP4。'));};
    const timer=setTimeout(()=>{cleanup();reject(Error('视频画面读取超时，请稍后重试。'));},Math.max(1,deadline-Date.now()));
    for(const event of events)video.addEventListener(event,check);
    video.addEventListener('error',failed);
    check();
  });
}
