import "./style.css";
import "./vn/fonts";
import { FONTS } from "./vn/fonts";
import { EFFECTS, getGlobalSpeed, setGlobalSpeed } from "./vn/effects";
import { createFalaEditor } from "./vn/tiptap";
import { renderFala, normalizeFala, falaPlain } from "./vn/render";
import type { Editor } from "@tiptap/core";

"use strict";

/* ---------- estado ---------- */
const S = {
  dir:null, outDir:null, images:[], chapters:[], stats:[], mode:'triage',
  active:'unassigned', sel:new Set(), tIdx:0, thumb:120
};
const UN='__unassigned__', REJ='__rejected__';
const IMG_RE=/\.(jpe?g|png|webp|gif|bmp|avif)$/i;

/* ---------- IndexedDB minúsculo ---------- */
function idb(){return new Promise((res,rej)=>{const r=indexedDB.open('organizador',1);
  r.onupgradeneeded=e=>{const db=e.target.result; if(!db.objectStoreNames.contains('kv'))db.createObjectStore('kv');};
  r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error);});}
async function idbGet(k){const db=await idb();return new Promise((res,rej)=>{const t=db.transaction('kv').objectStore('kv').get(k);t.onsuccess=()=>res(t.result);t.onerror=()=>rej(t.error);});}
async function idbSet(k,v){const db=await idb();return new Promise((res,rej)=>{const t=db.transaction('kv','readwrite').objectStore('kv').put(v,k);t.onsuccess=()=>res();t.onerror=()=>rej(t.error);});}

/* ---------- persistência (manifesto por nome de arquivo) ---------- */
let saveTimer=null;
function save(){clearTimeout(saveTimer);saveTimer=setTimeout(async()=>{
  const man={};
  for(const im of S.images) man[im.name]={chap:im.chap,order:im.order,rej:im.rej,taken:im.taken,stats:im.stats,texts:im.texts,cardBefore:im.cardBefore,cardAfter:im.cardAfter,scene:im.scene,music:im.music,pace:im.pace,clock:im.clock};
  await idbSet('manifest',man);
  await idbSet('chapters',S.chapters);
  await idbSet('stats',S.stats);
},250);}

/* ---------- helpers ---------- */
const $=s=>document.querySelector(s);
const uid=()=>Math.random().toString(36).slice(2,9);
const el=(t,c)=>{const e=document.createElement(t);if(c)e.className=c;return e;};
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function slug(n){return n.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||'cap';}
function toast(msg){const t=$('#toast');t.textContent=msg;t.style.display='block';clearTimeout(t._t);t._t=setTimeout(()=>t.style.display='none',2200);}
function inChap(id){return S.images.filter(i=>!i.rej&&i.chap===id).sort((a,b)=>a.order-b.order);}
function statById(id){return S.stats.find(s=>s.id===id);}
function defaultChapters(){return [
  {id:uid(),name:'Dia 1 · dia'},{id:uid(),name:'Dia 1 · noite'},{id:uid(),name:'Dia 2 · dia'}
];}

/* ---------- abrir / ler pasta ---------- */
async function pickFolder(){
  if(!window.showDirectoryPicker){alert('Seu navegador não suporta a File System Access API. Use o Chrome ou Edge.');return;}
  try{const h=await window.showDirectoryPicker({mode:'readwrite'}); await idbSet('dir',h); await loadFolder(h);}catch(e){if(e.name!=='AbortError')console.error(e);}
}
async function reopen(){
  const h=await idbGet('dir'); if(!h)return;
  const p=await h.requestPermission({mode:'readwrite'});
  if(p!=='granted'){alert('Permissão negada.');return;}
  await loadFolder(h);
}
async function loadFolder(handle){
  S.dir=handle;
  const man=(await idbGet('manifest'))||{};
  const savedChaps=await idbGet('chapters');
  S.chapters = (savedChaps&&savedChaps.length)?savedChaps:defaultChapters();
  S.stats = (await idbGet('stats'))||[];
  const imgs=[];
  for await (const [name,ent] of handle.entries()){
    if(ent.kind!=='file'||!IMG_RE.test(name))continue;
    const file=await ent.getFile();
    const m=man[name]||{};
    imgs.push({name,handle:ent,url:URL.createObjectURL(file),
      chap:(m.chap!==undefined)?m.chap:null, order:(m.order!==undefined)?m.order:null,
      rej:!!m.rej, hash:null, taken:m.taken, stats:m.stats||{},
      texts:m.texts||[], cardBefore:m.cardBefore||[], cardAfter:m.cardAfter||[], scene:m.scene||{}, music:m.music||null, pace:m.pace||null, clock:(m.clock??null)});   // undefined = ainda não lido; 0 = lido, sem data
  }
  imgs.sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true}));
  imgs.forEach((im,i)=>{if(im.order==null)im.order=i;}); // semeia ordem por nome p/ imagens sem manifesto
  S.images=imgs; S.sel.clear();
  migrateMusic();   // música por-capítulo (modelo antigo) vira um ponto na 1ª foto de cada dia
  migrateClocks();  // start/fim/velocidade (modelo antigo) viram marcos na 1ª e última foto
  // abre a triagem na 1ª "a definir" (cai direto nas fotos recém-adicionadas); 0 se não houver
  const firstUndef=imgs.findIndex(i=>!i.rej&&i.chap===null);
  S.tIdx=firstUndef>=0?firstUndef:0;
  $('#btnReopen').style.display='none';
  $('#modeSeg').style.display=''; $('#btnExport').style.display='';
  $('#btnSave').style.display=''; $('#btnRestore').style.display='';
  render();
  scanExif();   // em segundo plano: a hora real de cada foto é o que dá ritmo ao Relembrar
}

// migra o modelo antigo (chapter.music) para pontos por-foto: a faixa do dia começa na 1ª foto dele
function migrateMusic(){
  let changed=false;
  for(const ch of S.chapters){
    if(ch.music){
      const ims=inChap(ch.id);
      if(ims.length && !ims[0].music) ims[0].music=ch.music;
      delete ch.music; changed=true;
    }
  }
  if(changed)save();
}
// migra o modelo antigo de horas (ch.timeStart/timeEnd/timeStep) para marcos por-foto (im.clock)
function migrateClocks(){
  let changed=false;
  for(const ch of S.chapters){
    if(ch.timeStart==null&&ch.timeEnd==null&&ch.timeStep==null)continue;
    const ims=inChap(ch.id);
    if(ims.length){
      const last=ims.length-1;
      if(ch.timeStart!=null&&ims[0].clock==null)ims[0].clock=ch.timeStart;
      if(last>0){
        let endMin=null;
        if(ch.timeEnd!=null)endMin=ch.timeEnd;
        else if(ch.timeStart!=null&&ch.timeStep!=null)endMin=ch.timeStart+last*ch.timeStep;
        // só cria o marco final se for coerente (>= início) — evita herdar um fim velho/baixo
        if(endMin!=null&&ims[last].clock==null&&(ims[0].clock==null||endMin>=ims[0].clock))ims[last].clock=Math.round(endMin);
      }
    }
    delete ch.timeStart; delete ch.timeEnd; delete ch.timeStep; changed=true;
  }
  if(changed)save();
}

/* ---------- ações ---------- */
function assign(im,chapId){
  im.chap=chapId; im.rej=false;
  im.order=Math.max(-1,...inChap(chapId).filter(x=>x!==im).map(x=>x.order))+1;
  save();
}
function reject(im){im.rej=true;im.chap=im.chap??null;save();}
function unreject(im){im.rej=false;save();}
function unassign(im){im.chap=null;im.rej=false;save();}
/* manda um punhado de fotos para outro capítulo (ou p/ "A definir" / "Rejeitadas") */
function moveToChapter(names,dest){
  const ims=names.map(n=>S.images.find(x=>x.name===n)).filter(Boolean);
  if(!ims.length)return;
  if(dest===REJ)ims.forEach(reject);
  else if(dest===UN)ims.forEach(unassign);
  else{const ch=S.chapters.find(c=>c.id===dest);if(!ch)return;ims.forEach(im=>assign(im,dest));}
  const label=dest===REJ?'Rejeitadas':dest===UN?'A definir':S.chapters.find(c=>c.id===dest).name;
  S.sel.clear(); save(); renderSequence(); updateCounts();
  toast(`${ims.length} foto${ims.length===1?'':'s'} → ${label}`);
}

/* ---------- render dispatcher ---------- */
function render(){
  updateModeUI();
  updateCounts();
  if(S.mode==='triage') renderTriage();
  else if(S.mode==='recall') renderRecall();
  else renderSequence();
}
function updateModeUI(){
  document.querySelectorAll('#modeSeg button').forEach(b=>b.classList.toggle('on',b.dataset.mode===S.mode));
  const seq=S.mode==='sequence';
  $('#side').style.display=seq?'':'none';
  $('#btnSim').style.display=(seq&&S.active!==UN&&S.active!==REJ)?'':'none';
  $('#zoomBox').style.display=seq?'':'none';
}
function updateCounts(){
  const un=S.images.filter(i=>!i.rej&&i.chap===null).length;
  const rj=S.images.filter(i=>i.rej).length;
  $('#counts').textContent=`${S.images.length} imagens · ${un} a definir · ${rj} rejeitadas`;
}

/* ---------- TRIAGEM ---------- */
function renderTriage(){
  const c=$('#content'); c.style.overflow='hidden'; c.style.display='flex';
  if(!S.images.length){emptyOpen();return;}
  S.tIdx=Math.max(0,Math.min(S.tIdx,S.images.length-1));
  const im=S.images[S.tIdx];
  const chapName=im.rej?'REJEITADA':(im.chap?(S.chapters.find(x=>x.id===im.chap)||{}).name:'a definir');
  const keys=S.chapters.map((ch,i)=>`<button data-assign="${ch.id}"><kbd>${i+1}</kbd> ${ch.name}</button>`).join('');
  const undef=S.images.filter(i=>!i.rej&&i.chap===null).length;
  c.innerHTML=`<div class="triage">
    <div class="stage"><img src="${im.url}" alt=""></div>
    <div class="prog"><i style="width:${(S.tIdx+1)/S.images.length*100}%"></i></div>
    <div class="meta">
      <span>${S.tIdx+1} / ${S.images.length}</span>
      <span class="tag ${im.rej?'rej':''}">${chapName}</span>
      <span style="color:var(--dim)">${im.name}</span>
    </div>
    <div class="keys">
      ${keys}
      <button data-rej class="danger"><kbd>X</kbd> Rejeitar</button>
      <button data-un><kbd>U</kbd> Limpar</button>
    </div>
    <div class="keys">
      <button data-first title="Primeira imagem"><kbd>Home</kbd> ⏮ Início</button>
      <button data-jumpun ${undef?'':'disabled'} title="Pula para a próxima ainda não classificada"><kbd>N</kbd> ⏭ Próxima a definir${undef?` (${undef})`:''}</button>
      <button data-last title="Última imagem"><kbd>End</kbd> Fim ⏭</button>
    </div>
    <div style="color:var(--dim);font-size:12px"><kbd>Espaço</kbd> ou <kbd>→</kbd> próxima · <kbd>←</kbd> anterior</div>
  </div>`;
  c.querySelectorAll('[data-assign]').forEach(b=>b.onclick=()=>{assign(im,b.dataset.assign);advanceUnassigned();});
  c.querySelector('[data-rej]').onclick=()=>{reject(im);advanceUnassigned();};
  c.querySelector('[data-un]').onclick=()=>{unassign(im);renderTriage();updateCounts();};
  c.querySelector('[data-first]').onclick=()=>{S.tIdx=0;renderTriage();updateCounts();};
  c.querySelector('[data-last]').onclick=()=>{S.tIdx=S.images.length-1;renderTriage();updateCounts();};
  c.querySelector('[data-jumpun]').onclick=()=>jumpUnassigned();
}
/* salta para a próxima imagem "a definir" (a partir da atual, com volta ao começo) */
function jumpUnassigned(){
  const n=S.images.length; if(!n)return;
  for(let k=1;k<=n;k++){
    const idx=(S.tIdx+k)%n; const im=S.images[idx];
    if(!im.rej&&im.chap===null){S.tIdx=idx;renderTriage();updateCounts();return;}
  }
  toast('Nenhuma imagem “a definir”.');
}
/* depois de classificar (definir dia / rejeitar): pula direto para a próxima "a definir",
   com volta ao começo. Assim as fotos já organizadas (de aberturas anteriores da mesma pasta)
   não interrompem o fluxo — não precisa ficar apertando N. */
function advanceUnassigned(){
  const n=S.images.length; if(!n)return;
  for(let k=1;k<=n;k++){
    const idx=(S.tIdx+k)%n; const im=S.images[idx];
    if(!im.rej&&im.chap===null){S.tIdx=idx;renderTriage();updateCounts();return;}
  }
  // acabaram as "a definir": fica na foto atual (já reflete a classificação) e avisa
  renderTriage();updateCounts();toast('Tudo classificado ✓');
}

/* ---------- STATS ----------
   Um stat é uma definição global {id,nome,emoji,cor}. Anexá-lo a uma foto guarda uma contagem
   (im.stats[id] = quantas vezes). No Recall, a caixinha acumula essas contagens conforme as fotos
   passam. Definições vivem em idb('stats'); as contagens viajam no manifesto, por nome de arquivo. */
const STAT_COLORS=['#ff6b8b','#ff9f43','#ffd93d','#4ecb8d','#5b8cff','#a78bfa','#ff6b6b','#2dd4bf'];
let statEditId=null, statColor=STAT_COLORS[0];
let statPopEl=null;

function statBadgesHTML(im){
  let b='';
  if(im.stats) for(const id in im.stats){
    const s=statById(id); if(!s||!im.stats[id])continue;
    b+=`<span class="stb" style="--c:${esc(s.color)}">${esc(s.emoji||'⭐')}${im.stats[id]>1?' ×'+im.stats[id]:''}</span>`;
  }
  return b;
}
function bumpImgStat(im,id,delta){
  im.stats=im.stats||{};
  const v=(im.stats[id]||0)+delta;
  if(v<=0)delete im.stats[id]; else im.stats[id]=v;
  save();
}
// repinta só os selinhos de um tile (sem re-render geral, pra não fechar o popover)
// indicadores read-only no tile: stats + 💬 (textos) + 🎵 (música) + 🎬 (cena)
function tindHtml(im){
  const sceneSet=im.scene&&((im.scene.fx&&im.scene.fx!=='crossfade')||im.scene.mood);
  return statBadgesHTML(im)
    +(((im.texts&&im.texts.length)||(im.cardAfter&&im.cardAfter.length)||(im.cardBefore&&im.cardBefore.length))?'<span class="ti">💬</span>':'')
    +((im.music&&im.music.file)?'<span class="ti">🎵</span>':'')
    +(sceneSet?'<span class="ti">🎬</span>':'');
}
function refreshTileStats(name){
  document.querySelectorAll('.tile').forEach(t=>{
    if(t.dataset.name!==name)return;
    const im=S.images.find(x=>x.name===name); if(!im)return;
    let box=t.querySelector('.tind');
    if(!box){ box=el('div','tind'); t.appendChild(box); }
    box.innerHTML=tindHtml(im);
  });
}
function closeStatPop(){
  if(statPopEl){statPopEl.remove();statPopEl=null;document.removeEventListener('pointerdown',statPopOutside,true);}
}
function statPopOutside(e){ if(statPopEl&&!statPopEl.contains(e.target))closeStatPop(); }
function openStatPop(anchor,name){
  closeStatPop();
  const im=S.images.find(x=>x.name===name); if(!im)return;
  const p=el('div','statPop'); statPopEl=p;
  const build=()=>{
    p.innerHTML='<h5>Stats desta foto</h5>';
    if(!S.stats.length){
      const e0=el('div','statPopEmpty'); e0.textContent='Nenhum stat criado ainda.'; p.appendChild(e0);
    }else S.stats.forEach(s=>{
      const row=el('div','statPopRow'); const n=(im.stats&&im.stats[s.id])||0;
      row.innerHTML=`<span class="e">${esc(s.emoji||'⭐')}</span><span class="dot" style="background:${esc(s.color)}"></span><span class="nm">${esc(s.name)}</span>`+
        `<button class="statStep" data-d="-1">−</button><span class="ct">${n}</span><button class="statStep primary" data-d="1">＋</button>`;
      row.querySelector('[data-d="-1"]').onclick=()=>{bumpImgStat(im,s.id,-1);build();refreshTileStats(name);};
      row.querySelector('[data-d="1"]').onclick=()=>{bumpImgStat(im,s.id,1);build();refreshTileStats(name);};
      p.appendChild(row);
    });
    const nb=el('button','mini statPopNew'); nb.textContent='＋ Criar novo stat';
    nb.onclick=()=>{closeStatPop();openStatModal(null);};
    p.appendChild(nb);
  };
  build();
  document.body.appendChild(p);
  const r=anchor.getBoundingClientRect(), pw=p.offsetWidth, ph=p.offsetHeight;
  let left=Math.min(r.left, innerWidth-8-pw);
  let top=r.bottom+6; if(top+ph>innerHeight-8)top=Math.max(8,r.top-ph-6);
  p.style.left=Math.max(8,left)+'px'; p.style.top=top+'px';
  setTimeout(()=>document.addEventListener('pointerdown',statPopOutside,true),0);
}
function openStatModal(id){
  closeStatPop();
  statEditId=id||null;
  const s=id?statById(id):null;
  $('#statModalT').textContent=s?'Editar stat':'Novo stat';
  $('#statName').value=s?s.name:'';
  $('#statEmoji').value=s?(s.emoji||''):'';
  statColor=s?s.color:STAT_COLORS[0];
  const sw=$('#statSwatches'); sw.innerHTML='';
  STAT_COLORS.forEach(col=>{
    const b=el('button'); b.style.background=col;
    if(col===statColor)b.classList.add('on');
    b.onclick=()=>{statColor=col;sw.querySelectorAll('button').forEach(x=>x.classList.remove('on'));b.classList.add('on');};
    sw.appendChild(b);
  });
  $('#statDelete').style.display=s?'inline-flex':'none';
  $('#statModal').classList.add('show');
  setTimeout(()=>$('#statName').focus(),30);
}
function saveStatModal(){
  const name=$('#statName').value.trim()||'Stat';
  const emoji=$('#statEmoji').value.trim()||'⭐';
  if(statEditId){const s=statById(statEditId); if(s){s.name=name;s.emoji=emoji;s.color=statColor;}}
  else S.stats.push({id:uid(),name,emoji,color:statColor});
  save(); $('#statModal').classList.remove('show'); render();
}
function deleteStatDef(){
  if(!statEditId)return;
  const s=statById(statEditId);
  if(s&&!confirm(`Apagar o stat “${s.name}”? Ele sai de todas as fotos.`))return;
  S.stats=S.stats.filter(x=>x.id!==statEditId);
  for(const im of S.images) if(im.stats&&im.stats[statEditId]!==undefined)delete im.stats[statEditId];
  save(); $('#statModal').classList.remove('show'); render();
}

/* ---------- TEXTOS (visual novel) ----------
   Cada fala é um doc TipTap rico ({doc,fx,speed}). Falas legadas (string) são normalizadas ao abrir.
   O editor por-fala dá negrito/itálico/sublinhado + cor/fonte/tamanho por trecho, efeito por fala,
   e uma prévia que reproduz a digitação como no Recall. Velocidade é global (localStorage). */
let textEditName=null;
let textEditMode='photo';
let vnEditors:Editor[]=[];   // instâncias TipTap vivas no modal (destruídas ao fechar/re-renderizar)
const VN_SIZES=[['','Tam.'],['0.8em','P'],['1em','M'],['1.3em','G'],['1.7em','GG']];
const VN_COLORS=['#ffffff','#ff9ec7','#ffd166','#8ecae6','#a0e8af','#ff6b6b','#c8b6ff'];

// mode: 'photo' (falas + cena + tela preta depois) | 'cardAfter' | 'cardBefore' (só a tela preta, focado)
function cardArrOf(im){ return textEditMode==='cardBefore'?im.cardBefore:im.cardAfter; }
function openTextModal(name, mode){
  mode=mode||'photo';
  const im=S.images.find(x=>x.name===name); if(!im)return;
  if(mode==='card')mode='cardAfter';                 // compat
  textEditName=name; textEditMode=mode;
  im.texts=(im.texts||[]).map(normalizeFala);        // migra falas legadas p/ o formato rico
  im.cardBefore=(im.cardBefore||[]).map(normalizeFala);
  im.cardAfter=(im.cardAfter||[]).map(normalizeFala);
  const card=mode!=='photo';
  const arr=cardArrOf(im);                            // em modo foto, a seção "tela preta" edita a de depois
  $('#textModalT').textContent=mode==='cardBefore'?'Tela preta ANTES de '+name:(mode==='cardAfter'?'Tela preta DEPOIS de '+name:'Textos — '+name);
  $('#textIntro').style.display=card?'none':'';
  $('#cenaRow').style.display=card?'none':'';         // cena é da foto, não do cartão
  $('#textOverSec').style.display=card?'none':'';     // "falas sobre a foto" só no modo foto
  $('#textCardLbl').textContent=card?'Falas desta tela preta':'Tela preta depois desta foto';
  $('#textCardDel').style.display=card?'inline-flex':'none';
  const sc=im.scene||{};                              // sincroniza a linha "Cena desta foto"
  $('#cenaFx').value=sc.fx||'crossfade';
  $('#cenaMood').value=sc.mood||'';
  $('#cenaHold').value=String(sc.hold||0);
  syncVnSpeed();
  if(!card)renderFalaCards('#textOver', im.texts);
  if(card&&!arr.length)arr.push(normalizeFala(''));   // abre já com uma fala pronta
  renderFalaCards('#textCard', arr);
  $('#textModal').classList.add('show');
}
function destroyVnEditors(){ vnEditors.forEach(ed=>{try{ed.destroy();}catch(e){}}); vnEditors=[]; }

function renderFalaCards(sel, arr){
  const wrap=$(sel); wrap.innerHTML='';
  arr.forEach((fala,i)=>{
    const card=el('div','falaCard');
    const tools=el('div','falaTools');
    tools.innerHTML=
      `<button data-cmd="bold" title="Negrito"><b>B</b></button>`+
      `<button data-cmd="italic" title="Itálico"><i>I</i></button>`+
      `<button data-cmd="underline" title="Sublinhado"><u>U</u></button>`+
      `<span class="tsep"></span>`+
      VN_COLORS.map(c=>`<button class="csw" data-color="${c}" style="background:${c}" title="Cor do trecho"></button>`).join('')+
      `<button class="csw none" data-color="" title="Tirar cor">⌀</button>`+
      `<span class="tsep"></span>`+
      `<select data-font title="Fonte do trecho">${FONTS.map((f,fi)=>`<option value="${fi}">${esc(f.label)}</option>`).join('')}</select>`+
      `<select data-size title="Tamanho do trecho">${VN_SIZES.map((s,si)=>`<option value="${si}">${s[1]}</option>`).join('')}</select>`+
      `<span class="grow"></span>`+
      `<select data-fx title="Efeito de escrita desta fala">${EFFECTS.map(fx=>`<option value="${fx.id}"${fala.fx===fx.id?' selected':''}>${esc(fx.label)}</option>`).join('')}</select>`+
      `<button data-preview title="Prévia">▶</button>`+
      `<button data-remove class="danger" title="Remover fala">✕</button>`;
    const mount=el('div','falaEditor');
    card.append(tools,mount); wrap.appendChild(card);
    const ed=createFalaEditor(mount, fala.doc);
    vnEditors.push(ed);
    ed.on('update',()=>{ fala.doc=ed.getJSON(); save(); });
    const q=(s)=>tools.querySelector(s);
    q('[data-cmd="bold"]').onclick=()=>ed.chain().focus().toggleBold().run();
    q('[data-cmd="italic"]').onclick=()=>ed.chain().focus().toggleItalic().run();
    q('[data-cmd="underline"]').onclick=()=>ed.chain().focus().toggleUnderline().run();
    tools.querySelectorAll('[data-color]').forEach(b=>b.onclick=()=>{const c=b.getAttribute('data-color'); const ch=ed.chain().focus(); (c?ch.setColor(c):ch.unsetColor()).run();});
    q('[data-font]').onchange=(e)=>{const css=FONTS[+e.target.value].css; const ch=ed.chain().focus(); (css?ch.setFontFamily(css):ch.unsetFontFamily()).run(); e.target.selectedIndex=0;};
    q('[data-size]').onchange=(e)=>{const sz=VN_SIZES[+e.target.value][0]; const ch=ed.chain().focus(); (sz?ch.setFontSize(sz):ch.unsetFontSize()).run(); e.target.selectedIndex=0;};
    q('[data-fx]').onchange=(e)=>{fala.fx=e.target.value; save();};
    q('[data-preview]').onclick=()=>previewFala(fala);
    q('[data-remove]').onclick=()=>{arr.splice(i,1); save(); renderFalaCards(sel,arr);};
  });
}
function addTextRow(which){
  const im=S.images.find(x=>x.name===textEditName); if(!im)return;
  if(which==='over'){im.texts.push(normalizeFala('')); renderFalaCards('#textOver',im.texts);}
  else{const arr=cardArrOf(im); arr.push(normalizeFala('')); renderFalaCards('#textCard',arr);}
  save();
}
function closeTextModal(){
  const im=S.images.find(x=>x.name===textEditName);
  if(im){ // descarta falas vazias ao concluir
    im.texts=(im.texts||[]).map(normalizeFala).filter(f=>falaPlain(f));
    im.cardBefore=(im.cardBefore||[]).map(normalizeFala).filter(f=>falaPlain(f));
    im.cardAfter=(im.cardAfter||[]).map(normalizeFala).filter(f=>falaPlain(f));
    save();
  }
  destroyVnEditors();
  $('#textModal').classList.remove('show'); render();
}

// prévia: overlay fullscreen que toca uma sequência de falas como no Recall (opcionalmente com a foto
// de fundo). Usada tanto pelo ▶ do editor (1 fala, sem foto) quanto pelo duplo-clique na grade (foto + texts).
const MOOD_FILTER={warm:'saturate(1.28) sepia(.16) brightness(1.03)',cold:'saturate(1.06) contrast(1.04) hue-rotate(14deg)',night:'brightness(.66) saturate(.82) contrast(1.06)',bw:'grayscale(1) contrast(1.06)'};
// PV.list = nomes da visão atual (navegável com ← →); vazio = prévia de 1 fala do editor (sem foto)
let PV={list:[],idx:0,falas:[],i:0,ctrl:null};
function pvPlay(){ PV.ctrl=renderFala($('#vnPreviewText'), PV.falas[PV.i], ()=>{}); }
// prévia de UMA fala (▶ do editor): sem foto, sem navegação
function previewFala(fala){
  pvKill();
  PV={list:[],idx:0,falas:[normalizeFala(fala)].filter(f=>falaPlain(f)),i:0,ctrl:null};
  $('#vnPreviewImg').style.display='none';
  $('#vnPreviewText').textContent=''; $('#vnPreview').classList.add('show');
  if(PV.falas.length)pvPlay();
}
// prévia da foto (duplo-clique / menu): foto + falas, navegável com ← → dentro da visão atual
function openPhotoPreview(name){
  const list=(S.viewList||[]).map(im=>im.name);
  PV.list=list; PV.idx=Math.max(0,list.indexOf(name));
  $('#vnPvMove').innerHTML='<option value="">↦ Mover para dia…</option>'+
    S.chapters.map(ch=>`<option value="${esc(ch.id)}">${esc(ch.name)}</option>`).join('');
  $('#vnPreview').classList.add('show');
  pvShow();
}
// da prévia: manda a foto atual para um dia ou "a definir" (tira da rejeição), pula pra próxima
function pvMove(dest){
  const im=S.images.find(x=>x.name===PV.list[PV.idx]); if(!im)return;
  if(dest===UN)unassign(im); else assign(im,dest);      // ambos tiram o rej
  const label=dest===UN?'A definir':(S.chapters.find(c=>c.id===dest)||{}).name||'';
  PV.list.splice(PV.idx,1);
  renderSequence(); updateCounts();                     // atualiza a grade atrás
  toast('→ '+label);
  if(!PV.list.length){ closePreview(); return; }
  if(PV.idx>=PV.list.length)PV.idx=PV.list.length-1;
  pvShow();
}
function pvShow(){
  pvKill();
  const im=S.images.find(x=>x.name===PV.list[PV.idx]); if(!im){closePreview();return;}
  PV.falas=(im.texts||[]).map(normalizeFala).filter(f=>falaPlain(f)); PV.i=0;
  const img=$('#vnPreviewImg'); img.style.display='block'; img.src=im.url; img.style.filter=(im.scene&&MOOD_FILTER[im.scene.mood])||'none';
  $('#vnPreviewText').textContent='';
  if(PV.falas.length)pvPlay();
}
function pvNav(d){ if(!PV.list.length)return; const n=PV.idx+d; if(n<0||n>=PV.list.length)return; PV.idx=n; pvShow(); }
function previewSkip(){                                     // espaço / clique: completa a fala, ou avança
  if(PV.ctrl&&!PV.ctrl.done){ PV.ctrl.complete(); return; }
  if(PV.i<PV.falas.length-1){ PV.i++; pvPlay(); return; }
  if(!PV.list.length)closePreview();                       // prévia de 1 fala: acabou → fecha
}
function pvKill(){ if(PV.ctrl){PV.ctrl.destroy();PV.ctrl=null;} }
function closePreview(){ pvKill(); PV.list=[]; $('#vnPreview').classList.remove('show'); const img=$('#vnPreviewImg'); if(img){img.removeAttribute('src');img.style.display='none';} }

// velocidade global de digitação
function syncVnSpeed(){ const s=getGlobalSpeed(); const r=$('#vnSpeed'); if(r)r.value=String(s); const l=$('#vnSpeedLbl'); if(l)l.textContent=s.toFixed(1)+'×'; }

/* ---------- SEQUENCIAR ---------- */
function renderSequence(){
  const c=$('#content'); c.style.overflow='auto'; c.style.display='block';
  renderSidebar();
  let list, title;
  if(S.active===UN){list=S.images.filter(i=>!i.rej&&i.chap===null).sort((a,b)=>a.order-b.order);title='A definir';}
  else if(S.active===REJ){list=S.images.filter(i=>i.rej);title='Rejeitadas';}
  else {list=inChap(S.active);title=(S.chapters.find(x=>x.id===S.active)||{}).name||'';}
  S.viewList=list;

  let html='';
  // paleta de stats — sempre visível: criar/editar as definições (nome, emoji, cor)
  const chips=S.stats.map(s=>`<button class="statChip" data-editstat="${esc(s.id)}"><span class="dot" style="background:${esc(s.color)}"></span><span>${esc(s.emoji||'⭐')} ${esc(s.name)}</span></button>`).join('');
  html+=`<div class="statsBar"><span class="lbl">Stats</span>${chips}<button class="statChip add" data-newstat>＋ Novo</button></div>`;
  if(!list.length){
    html+=`<div style="color:var(--mut);padding:40px;text-align:center">Nada em “${title}”.</div>`;
  }else{
    const cols=Math.max(2,Math.floor(($('#content').clientWidth-24)/S.thumb));
    html+=`<div class="grid" style="grid-template-columns:repeat(${cols},1fr)">`;
    // relógio no tile: numa view de capítulo, a lista JÁ é o capítulo e i é a posição —
    // computo os minutos (com clamp monotônico) uma vez e uso i. Fora de capítulo, sem relógio.
    const activeCh=(S.active!==UN&&S.active!==REJ)?S.chapters.find(c=>c.id===S.active):null;
    const activeMins=activeCh?clockMins(activeCh).mins:null;
    const clkAt=(pos)=>activeMins?activeMins[pos]:null;
    const cardBlockHtml=(im,which)=>{                       // bloco preto (tela de texto) na grade
      const arr=((which==='before'?im.cardBefore:im.cardAfter)||[]).filter(f=>falaPlain(f));
      if(!arr.length||im.rej)return '';
      const prev=esc(falaPlain(arr[0]).slice(0,120));
      return `<div class="cardBlock" data-cardfor="${esc(im.name)}" data-cardwhich="${which}" title="Tela preta — clique para editar">
        <div class="cbInner"><span class="cbTag">▦ tela preta</span><span class="cbText">${prev||'(vazio)'}</span>${arr.length>1?`<span class="cbMore">+${arr.length-1} fala${arr.length-1>1?'s':''}</span>`:''}</div>
      </div>`;
    };
    list.forEach((im,i)=>{
      const ind=tindHtml(im);
      const cm=clkAt(i); const clk=cm!=null?fmtMin(cm):'';   // hora calculada, mostrada no próprio tile
      const clkBadge=clk?`<span class="tclock${im.clock!=null?' pin':''}" title="${im.clock!=null?'Hora fixada (marco)':'Hora interpolada'}">${im.clock!=null?'🕐 ':''}${clk}</span>`:'';
      html+=cardBlockHtml(im,'before');                      // tela preta ANTES desta foto
      html+=`<div class="tile ${S.sel.has(im.name)?'sel':''} ${im.rej?'rej':''}" data-name="${esc(im.name)}">
        <img src="${im.url}" alt="" loading="lazy">
        <span class="idx"${S.active!==REJ?' data-idx style="cursor:pointer" title="Mover para posição"':''}>${i+1}</span>
        ${clkBadge}
        <div class="selbox" data-selbox title="Selecionar">✓</div>
        <span class="rejbadge">rej</span>
        ${ind?`<div class="tind">${ind}</div>`:''}
        <span class="edgeHint edgeHintL">＋</span><span class="edgeHint edgeHintR">＋</span>
      </div>`;
      html+=cardBlockHtml(im,'after');                       // tela preta DEPOIS desta foto
    });
    html+='</div>';
  }
  html+=actionBarHtml();                               // barra de ações fixa embaixo (aparece se há seleção)
  c.innerHTML=html;

  c.classList.toggle('hasBar', !!S.sel.size);          // espaço p/ a barra fixa não cobrir a última linha
  wireActionBar(c);

  // paleta de stats
  c.querySelectorAll('[data-editstat]').forEach(b=>b.addEventListener('click',()=>openStatModal(b.dataset.editstat)));
  c.querySelector('[data-newstat]')?.addEventListener('click',()=>openStatModal(null));

  // tiles: borda esq/dir = inserir tela preta antes/depois · centro: 1 clique menu · 2 cliques preview
  c.querySelectorAll('.cardBlock').forEach(b=>{
    b.addEventListener('click',()=>openTextModal(b.dataset.cardfor, b.dataset.cardwhich==='before'?'cardBefore':'cardAfter'));
  });
  const edgeZone=(t,e)=>{ const r=t.getBoundingClientRect(); const fx=(e.clientX-r.left)/r.width; return fx<0.2?'L':fx>0.8?'R':null; };
  c.querySelectorAll('.tile').forEach(t=>{
    const name=t.dataset.name;
    t.addEventListener('mousemove',e=>{ const z=edgeZone(t,e); t.classList.toggle('edgeL',z==='L'); t.classList.toggle('edgeR',z==='R'); });
    t.addEventListener('mouseleave',()=>t.classList.remove('edgeL','edgeR'));
    t.addEventListener('click',e=>{
      if(e.target.closest('[data-selbox]')||e.target.closest('[data-idx]'))return;
      if(dndBlocksClick())return;
      const z=edgeZone(t,e);
      if(z){ clearTimeout(tileClickTimer); openTextModal(name, z==='L'?'cardBefore':'cardAfter'); return; }  // borda: cria tela preta
      const x=e.clientX, y=e.clientY;
      clearTimeout(tileClickTimer);
      tileClickTimer=setTimeout(()=>openTileMenu(x,y,name),240);   // centro: menu (ou preview no 2º clique)
    });
    t.addEventListener('dblclick',e=>{
      if(e.target.closest('[data-selbox]')||e.target.closest('[data-idx]'))return;
      if(edgeZone(t,e))return;                                     // duplo clique na borda não abre preview
      clearTimeout(tileClickTimer); closeTileMenu();
      openPhotoPreview(name);
    });
    const idxEl=t.querySelector('[data-idx]');
    if(idxEl)idxEl.addEventListener('click',e=>{e.stopPropagation();startIdxEdit(idxEl,name);});
    t.querySelector('[data-selbox]').addEventListener('click',e=>{
      e.stopPropagation();
      if(S.sel.has(name))S.sel.delete(name);else S.sel.add(name);
      renderSequence();
    });
    t.addEventListener('pointerdown',e=>{
      if(e.button!==0)return;
      if(e.target.closest('[data-selbox]')||e.target.closest('[data-idx]'))return;
      dndPend(e,'tile',name);
    });
  });
}

// barra de ações fixa embaixo: 1 selecionada = ações da foto; 2+ = ações em lote
function actionBarHtml(){
  if(!S.sel.size)return '';
  const dests=[...S.chapters.map(ch=>({id:ch.id,name:ch.name})),{id:UN,name:'📥 A definir'},{id:REJ,name:'🗑 Rejeitadas'}]
    .filter(o=>o.id!==S.active)
    .map(o=>`<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('');
  const moveSel=`<select class="mini" data-ab-move title="Mover para outro dia"><option value="">↦ Mover para…</option>${dests}</select>`;
  if(S.sel.size===1){
    const name=[...S.sel][0]; const im=S.images.find(x=>x.name===name); if(!im)return '';
    return `<div class="actionBar">
      <img class="abThumb" src="${im.url}" alt="">
      <span class="abName" title="${esc(name)}">${esc(name)}</span>
      <div class="abBtns">
        <button class="mini" data-ab="expand">⤢ Ampliar</button>
        <button class="mini" data-ab="text">💬 Textos &amp; cena</button>
        <button class="mini" data-ab="music">🎵 Música</button>
        <button class="mini" data-ab="stats">✦ Stats</button>
        <button class="mini" data-ab="tempo">⏱ Tempo</button>
        <button class="mini" data-ab="clock">🕐 Fixar hora</button>
        ${moveSel}
        <button class="mini danger" data-ab="reject">🗑 ${im.rej?'Restaurar':'Rejeitar'}</button>
      </div>
      <button class="mini abClose" data-ab="clear" title="Limpar seleção">✕</button>
    </div>`;
  }
  const two=S.sel.size===2;
  return `<div class="actionBar">
    <span class="abName">✓ ${S.sel.size} selecionadas</span>
    <div class="abBtns">
      ${moveSel}
      ${S.active!==UN&&S.active!==REJ?'<button class="mini" data-ab="together">↹ Trazer junto</button>':''}
      ${two&&S.active!==UN&&S.active!==REJ?'<button class="mini" data-ab="compare">⇆ Comparar</button>':''}
      <button class="mini danger" data-ab="reject">🗑 Rejeitar sel.</button>
    </div>
    <button class="mini abClose" data-ab="clear" title="Limpar seleção">✕</button>
  </div>`;
}
function wireActionBar(c){
  const bar=c.querySelector('.actionBar'); if(!bar)return;
  const one=S.sel.size===1?[...S.sel][0]:null;
  bar.querySelector('[data-ab-move]')?.addEventListener('change',e=>{ const d=e.target.value; if(d)moveToChapter([...S.sel],d); });
  bar.querySelectorAll('[data-ab]').forEach(b=>b.addEventListener('click',()=>{
    const a=b.dataset.ab;
    if(a==='clear'){S.sel.clear();renderSequence();}
    else if(a==='expand'&&one)openLightbox(S.viewList,one);
    else if(a==='text'&&one)openTextModal(one);
    else if(a==='music'&&one)openMusicForPhoto(one);
    else if(a==='stats'&&one)openStatPop(b,one);
    else if(a==='tempo'&&one)openTempoPop(b,one);
    else if(a==='clock'&&one)openClockPin(b,one);
    else if(a==='together')bringTogether();
    else if(a==='compare')openCompare();
    else if(a==='reject'){
      if(one){const im=S.images.find(x=>x.name===one); if(im){im.rej?unreject(im):reject(im);} renderSequence();updateCounts();}
      else{S.images.filter(i=>S.sel.has(i.name)).forEach(reject);S.sel.clear();renderSequence();updateCounts();}
    }
  }));
}
// popover de tempo por foto (multiplicador sobre o ritmo automático)
function openTempoPop(anchor,name){
  closeStatPop();
  const im=S.images.find(x=>x.name===name); if(!im)return;
  const cur=im.pace||1;
  const opts=[[0.55,'Rápido'],[1,'Normal'],[1.7,'Devagar'],[2.6,'Bem devagar']];
  const p=el('div','statPop'); statPopEl=p;
  p.innerHTML='<h5>Tempo desta foto no Relembrar</h5>';
  opts.forEach(([v,label])=>{
    const row=el('button','tempoOpt'+(cur===v?' on':''));
    row.textContent=label;
    row.onclick=()=>{ im.pace=(v===1?null:v); save(); closeStatPop(); renderSequence(); toast('Tempo: '+label); };
    p.appendChild(row);
  });
  document.body.appendChild(p);
  const r=anchor.getBoundingClientRect(), pw=p.offsetWidth, ph=p.offsetHeight;
  let left=Math.min(r.left, innerWidth-8-pw), top=r.top-ph-8; if(top<8)top=r.bottom+8;
  p.style.left=Math.max(8,left)+'px'; p.style.top=top+'px';
  setTimeout(()=>document.addEventListener('pointerdown',statPopOutside,true),0);
}
function globalPace(){ const v=parseFloat(localStorage.getItem('rcPace')||''); return v>0?v:1; }
function setGlobalPace(v){ localStorage.setItem('rcPace', String(v)); }

// fixar a hora (marco) desta foto. Guarda a hora de parede (HH:MM); a virada do dia é resolvida no
// cálculo (chapAnchors): uma hora menor que o marco anterior = dia seguinte. Sem trava.
function openClockPin(anchor,name){
  closeStatPop();
  const im=S.images.find(x=>x.name===name); if(!im)return;
  const ch=im.chap?S.chapters.find(c=>c.id===im.chap):null;
  const pos=ch?inChap(ch.id).findIndex(x=>x.name===name):-1;
  // pré-preenchido: a hora fixada, ou a interpolada atual (bom ponto de partida)
  let preset=CLOCK_DEFAULT_START;
  if(im.clock!=null)preset=im.clock;
  else if(ch){ const m=clockMinAt(ch,pos); if(m!=null)preset=((Math.round(m)%1440)+1440)%1440; }
  const p=el('div','statPop'); statPopEl=p; p.style.width='214px';
  p.innerHTML=`<h5>Fixar hora desta foto</h5>
    <input type="time" class="fIn" id="pinTime" value="${fmtMin(preset)}">
    <div style="display:flex;gap:6px;margin-top:12px">
      <button class="mini" id="pinClear" title="Deixa a hora ser interpolada"${im.clock==null?' disabled':''}>Soltar</button>
      <span style="flex:1"></span>
      <button class="mini primary" id="pinSave">Fixar</button>
    </div>
    <p style="margin:8px 2px 0;color:var(--dim);font-size:11px">Se a hora for menor que a do marco anterior, entra como madrugada (dia seguinte).</p>`;
  document.body.appendChild(p);
  p.querySelector('#pinTime').addEventListener('keydown',e=>e.stopPropagation());
  p.querySelector('#pinSave').onclick=()=>{ const v=parseHHMM(p.querySelector('#pinTime').value); if(v==null){toast('Hora inválida.');return;} im.clock=v; save(); closeStatPop(); renderSequence(); toast('Marco fixado: '+fmtMin(v)); };
  p.querySelector('#pinClear').onclick=()=>{ im.clock=null; save(); closeStatPop(); renderSequence(); toast('Marco solto.'); };
  const r=anchor.getBoundingClientRect(), pw=p.offsetWidth, ph=p.offsetHeight;
  let left=Math.min(r.left, innerWidth-8-pw), top=r.top-ph-8; if(top<8)top=r.bottom+8;
  p.style.left=Math.max(8,left)+'px'; p.style.top=top+'px';
  setTimeout(()=>document.addEventListener('pointerdown',statPopOutside,true),0);
}

// menu de contexto da miniatura (1 clique): mesmas ações da barra, ancorado no cursor
let tileClickTimer=null, tileMenuEl=null;
function closeTileMenu(){ if(tileMenuEl){tileMenuEl.remove();tileMenuEl=null;document.removeEventListener('pointerdown',tileMenuOutside,true);} }
function tileMenuOutside(e){ if(tileMenuEl&&!tileMenuEl.contains(e.target))closeTileMenu(); }
function openTileMenu(x,y,name){
  closeStatPop(); closeTileMenu();
  const im=S.images.find(z=>z.name===name); if(!im)return;
  const at=()=>({getBoundingClientRect:()=>({left:x,right:x,top:y,bottom:y,width:0,height:0})}); // âncora falsa no cursor
  const m=el('div','tileMenu'); tileMenuEl=m;
  const dests=[...S.chapters.map(ch=>({id:ch.id,name:ch.name})),{id:UN,name:'📥 A definir'},{id:REJ,name:'🗑 Rejeitadas'}]
    .filter(o=>o.id!==im.chap).map(o=>`<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('');
  m.innerHTML=
    `<button data-m="open">⤢ Abrir (com texto)</button>`+
    `<button data-m="text">💬 Textos &amp; cena</button>`+
    `<button data-m="music">🎵 Música</button>`+
    `<button data-m="stats">✦ Stats</button>`+
    `<button data-m="tempo">⏱ Tempo</button>`+
    `<button data-m="clock">🕐 Fixar hora</button>`+
    `<div class="tmSep"></div>`+
    `<select data-m-move><option value="">↦ Mover para…</option>${dests}</select>`+
    `<button class="danger" data-m="reject">🗑 ${im.rej?'Restaurar':'Rejeitar'}</button>`;
  document.body.appendChild(m);
  const mw=m.offsetWidth, mh=m.offsetHeight;
  m.style.left=Math.max(8,Math.min(x, innerWidth-8-mw))+'px';
  m.style.top=Math.max(8,Math.min(y, innerHeight-8-mh))+'px';
  m.querySelector('[data-m-move]').addEventListener('change',e=>{ const d=e.target.value; if(d){closeTileMenu();moveToChapter([name],d);} });
  m.querySelectorAll('[data-m]').forEach(b=>b.addEventListener('click',()=>{
    const a=b.dataset.m; closeTileMenu();
    if(a==='open')openPhotoPreview(name);
    else if(a==='text')openTextModal(name);
    else if(a==='music')openMusicForPhoto(name);
    else if(a==='stats')openStatPop(at(),name);
    else if(a==='tempo')openTempoPop(at(),name);
    else if(a==='clock')openClockPin(at(),name);
    else if(a==='reject'){ im.rej?unreject(im):reject(im); renderSequence();updateCounts(); }
  }));
  setTimeout(()=>document.addEventListener('pointerdown',tileMenuOutside,true),0);
}

function renderSidebar(){
  const s=$('#side');
  let h='<h4>Capítulos</h4><div id="chapList">';
  S.chapters.forEach(ch=>{
    const n=inChap(ch.id).length;
    h+=`<div class="chap ${S.active===ch.id?'on':''}" data-chap="${esc(ch.id)}">
      <span class="drag" data-chapdrag title="Arraste para reordenar">⠿</span>
      <span class="nm" title="${esc(ch.name)} — duplo clique para renomear">${esc(ch.name)}</span>
      <span class="n">${n}</span>
      <button class="x" data-editchap title="Renomear (ou duplo clique no nome)">✎</button>
      <button class="x" data-delchap title="Remover capítulo">✕</button></div>`;
  });
  h+='</div>';
  h+=`<button class="mini" id="addChap" style="width:100%;margin-top:4px">＋ Capítulo</button>`;
  const un=S.images.filter(i=>!i.rej&&i.chap===null).length;
  const rj=S.images.filter(i=>i.rej).length;
  h+=`<div class="divider">
    <div class="chap ${S.active===UN?'on':''}" data-chap="${UN}"><span class="nm">📥 A definir</span><span class="n">${un}</span></div>
    <div class="chap ${S.active===REJ?'on':''}" data-chap="${REJ}" style="color:#ffb4b4"><span class="nm">🗑 Rejeitadas</span><span class="n">${rj}</span></div>
  </div>`;
  s.innerHTML=h;

  s.querySelectorAll('[data-chap]').forEach(row=>{
    const id=row.dataset.chap;
    row.addEventListener('click',e=>{
      // renomeando: o clique é do usuário mirando o cursor no campo — trocar de capítulo aqui
      // re-renderizaria a barra e mataria o input embaixo do dedo dele
      if(e.target.closest('input')||e.target.closest('button')||dndBlocksClick())return;
      S.active=id;S.sel.clear();renderSequence();updateModeUI();});
    if(id!==UN&&id!==REJ){
      row.querySelector('.nm').addEventListener('dblclick',ev=>{ev.stopPropagation();editChap(id);});
      row.querySelector('[data-editchap]').addEventListener('click',ev=>{ev.stopPropagation();editChap(id);});
      row.querySelector('[data-delchap]').addEventListener('click',ev=>{ev.stopPropagation();delChap(id);});
      row.querySelector('[data-chapdrag]').addEventListener('pointerdown',ev=>{
        if(ev.button!==0)return; ev.stopPropagation(); dndPend(ev,'chap',id);});
    }
  });
  $('#addChap').onclick=()=>{S.chapters.push({id:uid(),name:'Novo capítulo'});save();renderSidebar();editChap(S.chapters[S.chapters.length-1].id);};
}

function editChap(id){
  const ch=S.chapters.find(x=>x.id===id); if(!ch)return;
  const row=[...document.querySelectorAll('#chapList [data-chap]')].find(e=>e.dataset.chap===id);
  if(!row)return;
  row.innerHTML=`<input value="${esc(ch.name)}" maxlength="60" aria-label="Nome do capítulo">`;
  const inp=row.querySelector('input'); inp.focus(); inp.select();
  // trava: sair do modo edição re-renderiza e tira o input do DOM, o que dispara mais um blur.
  // Sem ela, Escape cancelaria e o blur seguinte salvaria assim mesmo o texto descartado.
  let done=false;
  const finish=keep=>{
    if(done)return; done=true;
    const v=inp.value.trim();
    if(keep&&v&&v!==ch.name){ch.name=v;save();}
    renderSequence();                 // o nome também aparece na triagem e no Relembrar
  };
  inp.addEventListener('keydown',e=>{e.stopPropagation();
    if(e.key==='Enter'){e.preventDefault();finish(true);}
    else if(e.key==='Escape'){e.preventDefault();finish(false);}});
  inp.addEventListener('blur',()=>finish(true));
  inp.addEventListener('pointerdown',e=>e.stopPropagation());
  inp.addEventListener('click',e=>e.stopPropagation());
}

/* ---------- RELÓGIO SINTÉTICO POR CAPÍTULO (marcos, à prova de conflito) ----------
   UM conceito só: marcos = fotos com im.clock (min desde 0h). O 🕐 do capítulo fixa início/fim do dia
   (marcos na 1ª e última foto); o 🕐 da foto fixa marcos no meio. Entre marcos o relógio interpola
   pela posição (golden hour, com poucas fotos, desacelera). Conflito é IMPOSSÍVEL: a edição limita a
   hora entre os marcos vizinhos. ch.timeStart/timeEnd/timeStep = modelo antigo, migrado p/ marcos. */
const CLOCK_DEFAULT_START=14*60;   // 14:00 (pré-preenchimento do 1º marco)
const CLOCK_DEFAULT_STEP=4;        // min/foto (só p/ migrar capítulos do modelo antigo)
function fmtMin(total){ const m=((Math.round(total)%1440)+1440)%1440; return String(Math.floor(m/60)).padStart(2,'0')+':'+String(m%60).padStart(2,'0'); }
function parseHHMM(s){ const m=/^(\d{1,2}):(\d{2})$/.exec(s||''); if(!m)return null; const h=+m[1],mm=+m[2]; if(h>23||mm>59)return null; return h*60+mm; }
// UM conceito só: marcos = fotos com im.clock (hora de parede, min desde 0h). O dia é uma LINHA DO
// TEMPO CONTÍNUA: se a hora "volta" de um marco pro próximo (ex: 19:33 → 01:32), virou o dia e somo
// 24h internamente (min contínuo). Assim a interpolação é sempre crescente; o display volta a wrap.
function chapAnchors(ch){
  const ims=inChap(ch.id);
  const raw=[];
  ims.forEach((im,i)=>{ if(im.clock!=null)raw.push({pos:i,wall:im.clock}); });
  const anchors=[]; let addDay=0, prevWall=-1;
  for(const a of raw){ if(a.wall<prevWall)addDay+=1440; anchors.push({pos:a.pos,min:a.wall+addDay}); prevWall=a.wall; }
  return {ims,anchors};
}
// minutos por posição: interpola entre marcos e CONTINUA nas pontas (extrapola na inclinação do
// trecho vizinho) — assim o relógio não congela depois do último marco. Com 1 marco só, fica plano.
function clockMins(ch){
  const {ims,anchors}=chapAnchors(ch);
  const n=ims.length, out=new Array(n).fill(null);
  if(!anchors.length)return {ims,mins:out};
  const f=anchors[0], L=anchors[anchors.length-1];
  const slope=(b,a)=>b.pos!==a.pos?(b.min-a.min)/(b.pos-a.pos):0;
  for(let p=0;p<n;p++){
    if(anchors.length===1){ out[p]=f.min; continue; }                       // 1 marco: plano
    if(p<f.pos){ out[p]=Math.max(0,f.min+(p-f.pos)*slope(anchors[1],f)); continue; }         // antes: segue a 1ª rampa (não negativa)
    if(p>L.pos){ out[p]=L.min+(p-L.pos)*slope(L,anchors[anchors.length-2]); continue; }      // depois: segue a última rampa (pode passar da meia-noite)
    for(let k=0;k<anchors.length-1;k++){ const a=anchors[k],b=anchors[k+1]; if(p>=a.pos&&p<=b.pos){ out[p]=a.min+(b.min-a.min)*(p-a.pos)/(b.pos-a.pos); break; } }
  }
  return {ims,mins:out};
}
function clockMinAt(ch,pos){ const {mins}=clockMins(ch); return (pos>=0&&pos<mins.length)?mins[pos]:null; }
// hora (HH:MM) de uma foto: sintética se o capítulo tiver marcos; senão cai no EXIF
function photoClock(im,ch){
  if(ch){
    const {ims,mins}=clockMins(ch);
    const pos=ims.findIndex(x=>x.name===im.name);
    if(pos>=0&&mins[pos]!=null)return fmtMin(mins[pos]);
  }
  return im.taken?fmtHour(im.taken):'';
}
/* remove um capítulo; as fotos dele voltam para “A definir” (arquivos não são tocados) */
function delChap(id){
  const ch=S.chapters.find(x=>x.id===id); if(!ch)return;
  const n=S.images.filter(i=>i.chap===id).length;
  if(n&&!confirm(`Remover “${ch.name}”? As ${n} foto${n===1?'':'s'} dele voltam para “A definir”.`))return;
  S.images.filter(i=>i.chap===id).forEach(i=>i.chap=null);
  S.chapters=S.chapters.filter(x=>x.id!==id);
  if(S.active===id)S.active=UN;
  save(); renderSequence(); updateModeUI(); updateCounts();
  toast(`Capítulo “${ch.name}” removido.`);
}
/* reordena a barra lateral: idx é a posição de inserção na lista COM o capítulo ainda nela */
function moveChapTo(id,idx){
  const a=S.chapters.findIndex(x=>x.id===id); if(a<0)return;
  if(idx===a||idx===a+1)return;
  const [m]=S.chapters.splice(a,1);
  if(idx>a)idx--;
  S.chapters.splice(Math.max(0,Math.min(idx,S.chapters.length)),0,m);
  save(); renderSidebar();
}

/* reordena dentro da visão atual; idx é a posição de inserção na lista COM as movidas ainda nela */
function moveTo(names,idx){
  if(S.active===REJ)return;
  const list=(S.viewList||[]).slice();
  const set=new Set(names);
  const moving=list.filter(i=>set.has(i.name));
  if(!moving.length)return;
  const before=list.slice(0,idx).filter(i=>set.has(i.name)).length; // as que saem antes do alvo puxam o índice
  const rest=list.filter(i=>!set.has(i.name));
  rest.splice(Math.max(0,Math.min(idx-before,rest.length)),0,...moving);
  rest.forEach((im,i)=>im.order=i);
  save(); renderSequence();
}

/* mover para posição (reinserção 1-based, não swap) */
function moveToPosition(name,targetPos){
  if(S.active===REJ)return;                 // não faz sentido em Rejeitadas
  const list=(S.viewList||[]).slice();      // mesma ordem dos badges exibidos
  const N=list.length;
  const fi=list.findIndex(i=>i.name===name);
  if(fi<0)return;
  const [moved]=list.splice(fi,1);          // remove ANTES de inserir → resolve off-by-one ao ir p/ frente
  targetPos=Math.max(1,Math.min(targetPos,N));
  list.splice(targetPos-1,0,moved);
  list.forEach((im,i)=>im.order=i);
  save(); renderSequence();
}
/* transforma o badge .idx num input de posição */
function startIdxEdit(el,name){
  const cur=el.textContent.trim();
  el.innerHTML=`<input type="text" inputmode="numeric" draggable="false" value="${cur}" style="width:34px;padding:0 3px;font:inherit;text-align:center;border:1px solid var(--acc);background:var(--panel2);color:var(--txt);border-radius:4px">`;
  const inp=el.querySelector('input'); inp.focus(); inp.select();
  let closed=false;
  const cancel=()=>{if(closed)return;closed=true;renderSequence();};
  const commit=()=>{if(closed)return;closed=true;const v=parseInt(inp.value,10);if(v>0)moveToPosition(name,v);else renderSequence();};
  inp.addEventListener('mousedown',e=>e.stopPropagation()); // não inicia drag do tile
  inp.addEventListener('click',e=>e.stopPropagation());
  inp.addEventListener('keydown',e=>{e.stopPropagation();
    if(e.key==='Enter'){e.preventDefault();commit();}
    else if(e.key==='Escape'){e.preventDefault();cancel();}});
  inp.addEventListener('blur',cancel);
}
function bringTogether(){
  if(S.active===UN||S.active===REJ)return;
  const list=inChap(S.active);
  const selected=list.filter(i=>S.sel.has(i.name));
  if(selected.length<2)return;
  const anchor=Math.min(...selected.map(i=>list.indexOf(i)));
  const rest=list.filter(i=>!S.sel.has(i.name));
  rest.splice(anchor,0,...selected);
  rest.forEach((im,i)=>im.order=i);
  save(); renderSequence();
}

/* ---------- arrastar e soltar (pointer events) ----------
   O HTML5 drag-and-drop dava o comportamento "janky": ghost do navegador, dragover/dragleave
   piscando entre tiles vizinhos e nenhum auto-scroll. Aqui o arraste é feito à mão:
   um ghost segue o cursor, uma linha marca onde a foto cai, a lista rola sozinha perto das
   bordas, e várias selecionadas viajam juntas. Serve tanto p/ fotos quanto p/ os capítulos. */
const DND={pend:null,on:false,kind:null,names:[],ghost:null,line:null,idx:null,chapDrop:null,
  x:0,y:0,vel:0,raf:0,endT:0,
  box:null,mqTiles:null,mqBase:null,mqNames:null,mqAnchor:null,cRect:null}; // laço de seleção
const DND_THRESHOLD=5;   // px antes de virar arraste — abaixo disso ainda é um clique
const DND_EDGE=70;       // faixa perto da borda que dispara o auto-scroll

function dndPend(e,kind,name){DND.pend={kind,name,x:e.clientX,y:e.clientY,add:e.shiftKey||e.metaKey||e.ctrlKey};}
/* ponto do cursor em coordenadas da grade (contando a rolagem) — o laço vive nesse espaço,
   então a âncora fica colada no conteúdo mesmo enquanto a lista rola sozinha */
function dndPt(x=DND.x,y=DND.y){
  const c=$('#content');
  return {x:x-DND.cRect.left+c.scrollLeft, y:y-DND.cRect.top+c.scrollTop};
}
function dndBlocksClick(){return DND.on||performance.now()-DND.endT<200;}

function dndBegin(p){
  DND.on=true; DND.kind=p.kind; DND.idx=null; DND.chapDrop=null; DND.vel=0;
  if(p.kind==='marquee'){
    const c=$('#content');
    DND.cRect=c.getBoundingClientRect();
    // as posições dos tiles são medidas uma vez: nada na grade se mexe durante o laço
    const sx=c.scrollLeft, sy=c.scrollTop;
    DND.mqTiles=[...c.querySelectorAll('.tile')].map(t=>{
      const r=t.getBoundingClientRect();
      return {el:t,name:t.dataset.name,
        x1:r.left-DND.cRect.left+sx, y1:r.top-DND.cRect.top+sy,
        x2:r.right-DND.cRect.left+sx, y2:r.bottom-DND.cRect.top+sy};
    });
    DND.mqBase=new Set(p.add?S.sel:[]);   // shift/⌘: soma à seleção que já existia
    DND.mqNames=new Set(DND.mqBase);
    DND.mqAnchor=dndPt(p.x,p.y);          // âncora é onde o botão desceu, não onde cruzou o limiar
    DND.box=el('div','marquee'); c.appendChild(DND.box);
    document.body.classList.add('mq');
    DND.raf=requestAnimationFrame(dndLoop);
    return;
  }
  if(p.kind==='tile'){
    // arrastar uma foto que faz parte de uma seleção leva a seleção inteira, na ordem da visão
    DND.names=(S.sel.has(p.name)&&S.sel.size>1)
      ? (S.viewList||[]).filter(i=>S.sel.has(i.name)).map(i=>i.name)
      : [p.name];
    const im=S.images.find(i=>i.name===p.name);
    const side=Math.max(72,Math.min(120,S.thumb*0.85));
    DND.ghost=el('div','dragGhost');
    DND.ghost.style.width=DND.ghost.style.height=side+'px';
    DND.ghost.innerHTML=`<img src="${im?im.url:''}" alt="">`+
      (DND.names.length>1?`<span class="cnt">${DND.names.length}</span>`:'');
  }else{
    DND.names=[p.name];
    const ch=S.chapters.find(c=>c.id===p.name);
    DND.ghost=el('div','dragGhost chapGhost');
    DND.ghost.textContent=ch?ch.name:'';
  }
  DND.line=el('div','dropLine');
  document.body.append(DND.ghost,DND.line);
  document.body.classList.add('dnd');
  document.querySelectorAll('.tile').forEach(t=>{if(DND.names.includes(t.dataset.name))t.classList.add('ghosted');});
  DND.raf=requestAnimationFrame(dndLoop);
}

/* onde a foto cai, em coordenadas de tela: percorre os tiles na ordem de leitura */
function dropIndexAt(x,y){
  const tiles=[...document.querySelectorAll('#content .tile')];
  for(let i=0;i<tiles.length;i++){
    const r=tiles[i].getBoundingClientRect();
    if(y>=r.bottom)continue;                       // linha inteira acima do cursor
    if(x<r.left+r.width/2)return i;                // metade esquerda -> entra antes
    if(x<r.right)return i+1;                       // metade direita  -> entra depois
    const nx=tiles[i+1]&&tiles[i+1].getBoundingClientRect();
    if(!nx||nx.top>=r.bottom)return i+1;           // sobrou espaço no fim da linha
  }
  return tiles.length;
}
function chapIndexAt(y){
  const rows=[...document.querySelectorAll('#chapList [data-chap]')];
  for(let i=0;i<rows.length;i++){
    const r=rows[i].getBoundingClientRect();
    if(y<r.top+r.height/2)return i;
  }
  return rows.length;
}
function dndLine(rect,vertical,atEnd){
  const s=DND.line.style; s.display='block';
  if(vertical){s.width='3px';s.height=rect.height+'px';s.top=rect.top+'px';s.left=(atEnd?rect.right+2:rect.left-5)+'px';}
  else{s.height='3px';s.width=rect.width+'px';s.left=rect.left+'px';s.top=(atEnd?rect.bottom:rect.top-3)+'px';}
}

function dndUpdate(){
  if(DND.kind==='marquee'){dndMarquee();return;}
  DND.ghost.style.left=DND.x+'px'; DND.ghost.style.top=DND.y+'px';
  document.querySelectorAll('.chap.drop').forEach(c=>c.classList.remove('drop'));
  DND.chapDrop=null; DND.idx=null; DND.vel=0;
  DND.line.style.display='none';
  const under=document.elementFromPoint(DND.x,DND.y);
  const row=under&&under.closest&&under.closest('#side [data-chap]');

  if(DND.kind==='chap'){
    if(!row&&!(under&&under.closest&&under.closest('#side')))return;
    const idx=chapIndexAt(DND.y);
    const rows=[...document.querySelectorAll('#chapList [data-chap]')];
    if(!rows.length)return;
    DND.idx=idx;
    const atEnd=idx>=rows.length;
    dndLine((atEnd?rows[rows.length-1]:rows[idx]).getBoundingClientRect(),false,atEnd);
    return;
  }
  // fotos: soltar num capítulo da barra lateral move; no meio da grade, reordena
  if(row){
    const id=row.dataset.chap;
    if(id!==S.active){DND.chapDrop=id;row.classList.add('drop');}
    return;
  }
  if(S.active===REJ)return;                        // "Rejeitadas" não tem ordem própria
  const tiles=document.querySelectorAll('#content .tile');
  if(!tiles.length)return;
  const idx=dropIndexAt(DND.x,DND.y);
  DND.idx=idx;
  const atEnd=idx>=tiles.length;
  dndLine((atEnd?tiles[tiles.length-1]:tiles[idx]).getBoundingClientRect(),true,atEnd);
  dndAuto();
}
/* laço: desenha o retângulo e marca quem ele cruza. Só mexe nas classes — S.sel (e a re-render)
   só acontecem ao soltar, senão a barra de seleção apareceria no meio do gesto e empurraria a grade. */
function dndMarquee(){
  const a=DND.mqAnchor, p=dndPt();
  const x1=Math.min(a.x,p.x), y1=Math.min(a.y,p.y), x2=Math.max(a.x,p.x), y2=Math.max(a.y,p.y);
  const s=DND.box.style;
  s.left=x1+'px'; s.top=y1+'px'; s.width=(x2-x1)+'px'; s.height=(y2-y1)+'px';
  DND.mqNames=new Set(DND.mqBase);
  for(const t of DND.mqTiles){
    const hit=t.x1<x2&&t.x2>x1&&t.y1<y2&&t.y2>y1;
    if(hit)DND.mqNames.add(t.name);
    t.el.classList.toggle('sel',hit||DND.mqBase.has(t.name));
  }
  dndAuto();
}
/* perto do topo/base da grade, a lista rola sozinha — proporcional à distância da borda */
function dndAuto(){
  const c=$('#content'), r=c.getBoundingClientRect();
  if(DND.y<r.top+DND_EDGE)DND.vel=-(1-(DND.y-r.top)/DND_EDGE)*18;
  else if(DND.y>r.bottom-DND_EDGE)DND.vel=(1-(r.bottom-DND.y)/DND_EDGE)*18;
  DND.vel=Math.max(-18,Math.min(18,DND.vel));
}
function dndLoop(){
  if(!DND.on){DND.raf=0;return;}
  if(DND.vel){
    const c=$('#content'), y0=c.scrollTop;
    c.scrollTop+=DND.vel;
    if(c.scrollTop!==y0)dndUpdate();               // rolou: a linha tem que acompanhar os tiles
  }
  DND.raf=requestAnimationFrame(dndLoop);
}
function dndEnd(){
  cancelAnimationFrame(DND.raf); DND.raf=0;
  DND.ghost&&DND.ghost.remove(); DND.line&&DND.line.remove(); DND.box&&DND.box.remove();
  DND.ghost=DND.line=DND.box=null;
  // o laço mexe nas classes direto no DOM: devolve todas ao que S.sel diz, e quem for aplicar
  // a seleção nova (o pointerup) re-renderiza logo em seguida. Assim Esc/cancelar já desfazem.
  if(DND.mqTiles)DND.mqTiles.forEach(t=>t.el.classList.toggle('sel',S.sel.has(t.name)));
  DND.mqTiles=null;
  document.body.classList.remove('dnd','mq');
  document.querySelectorAll('.tile.ghosted').forEach(t=>t.classList.remove('ghosted'));
  document.querySelectorAll('.chap.drop').forEach(c=>c.classList.remove('drop'));
  DND.on=false; DND.pend=null; DND.endT=performance.now();
}
addEventListener('pointermove',e=>{
  if(!DND.on){
    const p=DND.pend; if(!p)return;
    if(Math.hypot(e.clientX-p.x,e.clientY-p.y)<DND_THRESHOLD)return;
    DND.x=e.clientX; DND.y=e.clientY;
    dndBegin(p);
  }
  DND.x=e.clientX; DND.y=e.clientY;
  dndUpdate();
});
addEventListener('pointerup',()=>{
  if(!DND.on){
    // clique seco no vazio da grade (sem laço, sem modificador): larga a seleção
    const p=DND.pend; DND.pend=null;
    if(p&&p.kind==='marquee'&&!p.add&&S.sel.size){S.sel.clear();renderSequence();}
    return;
  }
  const {kind,names,idx,chapDrop,mqNames}=DND;
  dndEnd();
  if(kind==='marquee'){S.sel=mqNames;renderSequence();return;}
  if(kind==='tile'){
    if(chapDrop)moveToChapter(names,chapDrop);
    else if(idx!=null)moveTo(names,idx);
  }else if(idx!=null)moveChapTo(names[0],idx);
});
addEventListener('pointercancel',()=>{if(DND.on)dndEnd();else DND.pend=null;});
addEventListener('blur',()=>{if(DND.on)dndEnd();});

/* ---------- comparar / preview ---------- */
function openCompare(){
  const [a,b]=[...S.sel].map(n=>S.images.find(i=>i.name===n));
  const list=inChap(S.active);
  const body=$('#cmpBody');
  body.innerHTML=`
    <div><img src="${a.url}"><h5>${a.name}</h5><button data-first="${a.name}">Esta vem antes</button></div>
    <div><img src="${b.url}"><h5>${b.name}</h5><button data-first="${b.name}">Esta vem antes</button></div>`;
  $('#cmpModal').classList.add('show');
  body.querySelectorAll('[data-first]').forEach(btn=>btn.onclick=()=>{
    const first=btn.dataset.first, second=(first===a.name)?b.name:a.name;
    const fi=list.find(i=>i.name===first), si=list.find(i=>i.name===second);
    const ordered=list.filter(i=>i!==si);
    ordered.splice(ordered.indexOf(fi)+1,0,si);
    ordered.forEach((im,i)=>im.order=i);
    save();$('#cmpModal').classList.remove('show');S.sel.clear();renderSequence();
  });
}
/* ---------- visualizador (lightbox) ---------- */
let LB={list:[],i:0};
function openLightbox(list,startName){
  LB.list=list.slice(); LB.i=Math.max(0,LB.list.findIndex(x=>x.name===startName));
  lbShow(); $('#lb').classList.add('show');
}
function lbShow(){
  if(!LB.list.length){$('#lb').classList.remove('show');return;}
  LB.i=Math.max(0,Math.min(LB.i,LB.list.length-1));
  const im=LB.list[LB.i];
  $('#lbImg').src=im.url;
  const canMove=(S.active!==REJ);
  const pin=$('#lbPosInput');
  pin.value=LB.i+1; pin.disabled=!canMove; pin.style.opacity=canMove?'1':'.4';
  $('#lbTotal').textContent='/ '+LB.list.length;
  $('#lbName').textContent=im.name;
  $('#lbReject').textContent=im.rej?'Recuperar':'Rejeitar';
}
function lbMoveTo(v){
  if(S.active===REJ)return;
  const im=LB.list[LB.i];
  moveToPosition(im.name,v);              // reordena a visão + persiste + renderSequence
  LB.list=(S.viewList||[]).slice();       // ressincroniza com a nova ordem
  LB.i=Math.max(0,LB.list.findIndex(x=>x.name===im.name));
  lbShow();
}
function lbNav(d){LB.i+=d;if(LB.i<0)LB.i=LB.list.length-1;if(LB.i>=LB.list.length)LB.i=0;lbShow();}
function lbClose(){$('#lb').classList.remove('show');renderSequence();updateCounts();}
function lbToggleReject(){
  const im=LB.list[LB.i];
  if(im.rej)unreject(im);else reject(im);
  lbShow();
}
function lbRemoveFromSeq(){
  const im=LB.list[LB.i];
  unassign(im);                 // volta para “A definir”, sem tocar no arquivo
  LB.list.splice(LB.i,1);       // some do visualizador
  if(!LB.list.length){lbClose();return;}
  if(LB.i>=LB.list.length)LB.i=LB.list.length-1;
  lbShow();
}

/* ---------- backup portável de sessão ----------
   TODA a organização (o "trabalho") vive no IndexedDB do Chrome: manifesto por nome de arquivo
   (capítulo, ordem, rejeição, data, STATS, TEXTOS, CARTÕES) + a lista de capítulos e as definições
   de stats. As imagens em si ficam na pasta, no disco. Se o Chrome perder o IndexedDB, esse trabalho
   some — por isso dá pra BAIXAR tudo num .json e IMPORTAR de volta depois. O manifesto sai no mesmo
   formato do idb, então importar é só regravar o idb e reaplicar por nome de arquivo. */
function sessionManifest(){
  const man={};
  for(const im of S.images) man[im.name]={chap:im.chap,order:im.order,rej:im.rej,taken:im.taken,stats:im.stats,texts:im.texts,cardBefore:im.cardBefore,cardAfter:im.cardAfter,scene:im.scene,music:im.music,pace:im.pace,clock:im.clock};
  return man;
}
function sessionData(){
  return {app:'ComposerOrganizer',v:2,ts:Date.now(),chapters:S.chapters,stats:S.stats,manifest:sessionManifest()};
}
function downloadSession(){
  if(!S.images.length){toast('Abra a pasta antes de baixar o backup.');return;}
  const blob=new Blob([JSON.stringify(sessionData())],{type:'application/json'});
  const a=el('a'); a.href=URL.createObjectURL(blob);
  a.download=`composer-sessao-${new Date().toISOString().slice(0,10)}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href),1000);
  toast('Backup baixado.');
}
async function importSessionData(data){
  await idbSet('manifest',data.manifest);
  await idbSet('chapters',data.chapters||[]);
  await idbSet('stats',data.stats||[]);
  if(S.dir) await loadFolder(S.dir);                 // pasta aberta: reaplica por nome + re-render
  else { S.chapters=data.chapters||S.chapters; S.stats=data.stats||[]; render(); }
}
async function importSessionFile(file){
  let data; try{data=JSON.parse(await file.text());}catch(e){toast('Não consegui ler o arquivo.');return;}
  if(!data||!data.manifest){toast('Não parece um backup do Organizador.');return;}
  const n=Object.keys(data.manifest).length, nc=(data.chapters||[]).length, ns=(data.stats||[]).length;
  if(!confirm(`Importar este backup? Substitui a organização atual — ${n} fotos, ${nc} capítulos, ${ns} stats. As imagens no disco não são tocadas.`))return;
  await importSessionData(data);
  toast(S.dir?'Backup importado.':'Backup carregado. Abra a pasta das imagens para ver.');
}

/* ---------- similaridade (dHash) ---------- */
async function computeHash(im){
  if(im.hash!==null)return im.hash;
  const file=await im.handle.getFile();
  const bmp=await createImageBitmap(file);
  const w=9,h=8,cv=document.createElement('canvas');cv.width=w;cv.height=h;
  const ctx=cv.getContext('2d',{willReadFrequently:true});
  ctx.drawImage(bmp,0,0,w,h); bmp.close&&bmp.close();
  const d=ctx.getImageData(0,0,w,h).data;
  let hash=0n;
  for(let y=0;y<8;y++)for(let x=0;x<8;x++){
    const i1=(y*w+x)*4,i2=(y*w+x+1)*4;
    const g1=0.299*d[i1]+0.587*d[i1+1]+0.114*d[i1+2];
    const g2=0.299*d[i2]+0.587*d[i2+1]+0.114*d[i2+2];
    hash=(hash<<1n)|(g1<g2?1n:0n);
  }
  im.hash=hash; return hash;
}
function hamming(a,b){let x=a^b,c=0;while(x){c+=Number(x&1n);x>>=1n;}return c;}
async function similaritySort(){
  if(S.active===UN||S.active===REJ)return;
  const list=inChap(S.active); if(list.length<3)return;
  $('#btnSim').disabled=true; $('#btnSim').textContent='✦ Calculando…';
  for(let i=0;i<list.length;i++){await computeHash(list[i]);$('#btnSim').textContent=`✦ ${i+1}/${list.length}…`;}
  const used=new Set(),res=[]; let cur=list[0];used.add(cur.name);res.push(cur);
  while(res.length<list.length){
    let best=null,bd=Infinity;
    for(const im of list){if(used.has(im.name))continue;const dd=hamming(cur.hash,im.hash);if(dd<bd){bd=dd;best=im;}}
    used.add(best.name);res.push(best);cur=best;
  }
  res.forEach((im,i)=>im.order=i);
  $('#btnSim').disabled=false; $('#btnSim').textContent='✦ Ordenar por similaridade';
  save(); renderSequence(); toast('Ordenado por similaridade — ajuste o que precisar.');
}

/* ---------- pipeline de imagem do player ----------
   O engasgo do Relembrar não vinha da ideia de zoom, vinha daqui: a mesma foto de 12MP era
   decodificada DUAS vezes por slide (uma como <img>, outra como background do fundo) e ainda
   levava um blur(48px) numa camada maior que a tela. Agora cada foto é decodificada uma vez, já
   reduzida ao que a tela usa de verdade, e o fundo sai de uma miniatura de 32px (truque do
   blur-up: esticada, ela já chega borrada de graça). */
const RCC=new Map();            // name -> {url,tiny,w,h}
const RCC_MAX=16;               // LRU curto: são bitmaps grandes, não podem ficar todos vivos
/* teto de pixels: numa vertical em fill a foto ocupa a largura da tela, então mais que isso
   (limitado a 2x de DPR, e a 3200 no total) é peso que ninguém enxerga */
function rcTarget(){
  const dpr=Math.min(devicePixelRatio||1,2);
  return Math.min(3200,Math.round(Math.max(innerWidth,innerHeight)*dpr));
}
async function rcPrep(im){
  const hit=RCC.get(im.name);
  if(hit){RCC.delete(im.name);RCC.set(im.name,hit);return hit;}   // reusar = renovar no LRU
  const file=await im.handle.getFile();
  // imageOrientation: sem isto a foto do celular sai deitada ao passar pelo canvas
  let bmp=await createImageBitmap(file,{imageOrientation:'from-image'});
  const t=rcTarget(), k=Math.min(1,t/Math.max(bmp.width,bmp.height));
  if(k<1){
    const rs=await createImageBitmap(bmp,{resizeWidth:Math.round(bmp.width*k),
      resizeHeight:Math.round(bmp.height*k),resizeQuality:'high'});
    bmp.close(); bmp=rs;
  }
  const cv=new OffscreenCanvas(bmp.width,bmp.height);
  cv.getContext('2d').drawImage(bmp,0,0);
  const blob=await cv.convertToBlob({type:'image/webp',quality:.92});
  const tw=32,th=Math.max(1,Math.round(32*bmp.height/bmp.width));  // 32px: o blur come todo o resto
  const tc=document.createElement('canvas'); tc.width=tw; tc.height=th;
  tc.getContext('2d').drawImage(bmp,0,0,tw,th);
  const rec={url:URL.createObjectURL(blob),tiny:tc.toDataURL('image/jpeg',.72),w:bmp.width,h:bmp.height};
  bmp.close();
  RCC.set(im.name,rec);
  for(const key of [...RCC.keys()]){
    if(RCC.size<=RCC_MAX)break;
    if(key===im.name)continue;                                     // nunca despejar a que acabou de entrar
    URL.revokeObjectURL(RCC.get(key).url); RCC.delete(key);
  }
  return rec;
}

/* ---------- EXIF: a hora real da foto ----------
   Só o DateTimeOriginal interessa — é ele que dá o ritmo do dia. O APP1 mora no começo do JPEG,
   então basta ler os primeiros 256KB e caminhar o IFD à mão; uma lib inteira para um campo só
   não se paga. Devolve ms locais (foi na hora local que ele viveu o festival) ou 0. */
function exifWalk(v,tiff){
  const le=v.getUint16(tiff)===0x4949;                 // "II" = little endian, "MM" = big
  const u16=o=>v.getUint16(o,le), u32=o=>v.getUint32(o,le);
  if(u16(tiff+2)!==0x002A)return 0;
  const find=(ifd,tag)=>{
    if(ifd+2>v.byteLength)return 0;
    const n=u16(ifd);
    for(let i=0;i<n;i++){
      const e=ifd+2+i*12;
      if(e+12>v.byteLength)return 0;
      // vale para os dois tags que usamos: o LONG cabe inline, a string de 20 bytes vira offset
      if(u16(e)===tag)return u32(e+8);
    }
    return 0;
  };
  const ifd0=tiff+u32(tiff+4);
  const ex=find(ifd0,0x8769);                          // ponteiro para o IFD do Exif
  let off=ex?find(tiff+ex,0x9003):0;                   // DateTimeOriginal
  if(!off)off=find(ifd0,0x0132);                       // DateTime, se o original não existir
  if(!off||tiff+off+19>v.byteLength)return 0;
  let s='';
  for(let i=0;i<19;i++){const c=v.getUint8(tiff+off+i); if(!c)break; s+=String.fromCharCode(c);}
  const m=s.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  return m?new Date(+m[1],+m[2]-1,+m[3],+m[4],+m[5],+m[6]).getTime():0;
}
function exifDate(v){
  if(v.byteLength<4||v.getUint16(0)!==0xFFD8)return 0;  // não é JPEG
  let p=2;
  while(p+4<v.byteLength){
    if(v.getUint8(p)!==0xFF)return 0;
    const mk=v.getUint8(p+1);
    if(mk===0xE1){                                      // APP1 = onde o Exif mora
      if(v.getUint32(p+4)!==0x45786966)return 0;        // "Exif"
      return exifWalk(v,p+10);                          // pula "Exif\0\0" → começa o TIFF
    }
    if(mk===0xDA)return 0;                              // começou a imagem: não há mais metadado
    p+=2+v.getUint16(p+2);
  }
  return 0;
}
async function readTaken(im){
  try{
    const file=await im.handle.getFile();
    const t=exifDate(new DataView(await file.slice(0,262144).arrayBuffer()));
    return t||file.lastModified||0;                     // sem EXIF: a data do arquivo já ordena
  }catch(e){return 0;}
}
/* varre em segundo plano: com centenas de fotos isto não pode segurar a interface */
async function scanExif(){
  let n=0;
  for(const im of S.images){
    if(im.taken!==undefined)continue;
    im.taken=await readTaken(im);
    if(++n%20===0)await new Promise(r=>setTimeout(r,0));
  }
  if(n){save(); if(S.mode==='recall')renderRecall();}
}
const fmtHour=ts=>ts?new Date(ts).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}):'';
const fmtDay=ts=>ts?new Date(ts).toLocaleDateString('pt-BR',{weekday:'long',day:'numeric',month:'long'}):'';
const fmtSecs=s=>{s=Math.max(0,Math.round(s));return Math.floor(s/60)+':'+String(s%60).padStart(2,'0');};
/* intervalo de horas do capítulo, para a cartela: "14:20 → 03:40" */
function chapSpan(chId){
  const ch=S.chapters.find(c=>c.id===chId);
  const ims=inChap(chId);
  if(ch){                                              // relógio sintético (marcos): 1ª → última
    const a=clockMinAt(ch,0), b=clockMinAt(ch,ims.length-1);
    if(a!=null){ return fmtMin(a)+(ims.length>1&&b!=a?' → '+fmtMin(b):''); }
  }
  const t=ims.map(i=>i.taken).filter(Boolean);
  if(!t.length)return '';
  const a=Math.min(...t), b=Math.max(...t);
  return fmtHour(a)+(b-a>60000?' → '+fmtHour(b):'');
}

/* ---------- música por capítulo ----------
   O arquivo vai para _musica/ dentro da pasta do usuário (ele já deu permissão de escrita, e é o
   mesmo espírito do _sessao.json): a trilha viaja junto com as fotos e toca offline, sem upload
   pra lugar nenhum. Em S.chapters fica só a referência {file,start}. */
// Música por PONTO/foto: im.music={file,start} = "a partir desta foto, toque X". A faixa ativa num
// beat é o último ponto de música <= posição atual (continua entre dias até o próximo ponto).
// MUS.key = nome da foto dona do ponto tocando; MUS.urls indexa por nome de arquivo (dedupe).
const MUS={cur:null,key:null,urls:new Map(),
  vol:Math.min(1,Math.max(0,+(localStorage.getItem('rcVol')??.8))),
  muted:localStorage.getItem('rcMute')==='1'};
const musVol=()=>MUS.muted?0:MUS.vol;
async function musUrl(file){
  if(!file)return null;
  if(MUS.urls.has(file))return MUS.urls.get(file);
  try{
    const dir=await S.dir.getDirectoryHandle('_musica');
    const fh=await dir.getFileHandle(file);
    const url=URL.createObjectURL(await fh.getFile());
    MUS.urls.set(file,url); return url;
  }catch(e){return null;}
}
// ponto de música ativo na posição i: o último beat de foto (<= i) que define im.music
function activeCue(i){
  for(let k=Math.min(i,RC.list.length-1);k>=0;k--){
    const b=RC.list[k];
    if(b&&b.im&&b.im.music&&b.im.music.file) return {cue:b.im.music,key:b.im.name};
  }
  return null;
}
// avalia o ponto ativo neste beat e troca a faixa se mudou (ou silencia se ainda não houve ponto)
function musSync(i){
  const ac=activeCue(i);
  if(ac)musPlayCue(ac.cue,ac.key);
  else if(MUS.cur)musStop(1.2);
}
/* Rampa de volume no relógio de parede, por setInterval — de propósito NÃO em rAF: o rAF congela
   em aba de fundo, e um crossfade travado no meio deixaria a faixa velha tocando baixinho pra
   sempre. Assim, escondido, o fade fica grosseiro mas sempre chega ao fim.
   O contador _f resolve dois fades na mesma faixa (troca rápida de capítulo): o mais novo assume. */
function musFade(a,to,secs,stop){
  if(!a)return;
  const from=a.volume, t0=performance.now(), ms=Math.max(1,secs*1000);
  const my=(a._f=(a._f||0)+1);
  clearInterval(a._fi);
  const step=()=>{
    if(a._f!==my){clearInterval(a._fi);return;}
    const k=Math.min(1,(performance.now()-t0)/ms);
    a.volume=Math.max(0,Math.min(1,from+(to-from)*k));
    if(k>=1){clearInterval(a._fi); if(stop)a.pause();}
  };
  a._fi=setInterval(step,30);
  step();
}
async function musPlayCue(cue,key){
  if(MUS.key===key){                        // mesmo ponto: a faixa continua de onde está
    // ...a não ser que a pausa a tenha parado e o usuário tenha saído dela pela seta
    if(MUS.cur&&MUS.cur.paused&&!RC.paused){MUS.cur.play().catch(()=>{});musFade(MUS.cur,musVol(),.6);}
    return;
  }
  MUS.key=key;
  const old=MUS.cur;
  const url=await musUrl(cue.file);
  if(MUS.key!==key)return;                   // já trocou de ponto enquanto o arquivo abria
  if(old)musFade(old,0,2,true);
  if(!url){MUS.cur=null;return;}
  const a=new Audio(url);
  a.volume=0;
  a.addEventListener('ended',()=>{a.currentTime=cue.start||0;a.play().catch(()=>{});}); // repete a partir do ponto escolhido, não do zero
  MUS.cur=a;
  a.currentTime=cue.start||0;
  // sem await: a promessa do play() só resolve quando a faixa realmente começa, e esperar por ela
  // faria os primeiros segundos da música tocarem em volume 0 — justo a abertura que ele escolheu
  a.play().catch(()=>{});
  musFade(a,musVol(),2.5);                  // entrada mais longa que a saída: a virada fica macia
}
function musStop(secs=1.5){
  if(MUS.cur)musFade(MUS.cur,0,secs,true);
  MUS.cur=null; MUS.key=null;
}
function musApplyVol(){
  if(MUS.cur){MUS.cur._f=(MUS.cur._f||0)+1; clearInterval(MUS.cur._fi); MUS.cur.volume=musVol();} // cancela fade em curso
  const b=$('#rcMute'); if(b)b.textContent=MUS.muted||!MUS.vol?'🔇':'🔊';
  const r=$('#rcVol'); if(r)r.value=Math.round(MUS.vol*100);
}

/* ---------- escolher a faixa e o ponto onde ela começa (por FOTO) ---------- */
let ME={name:null,file:null,start:0};
async function openMusicForPhoto(name){
  const im=S.images.find(x=>x.name===name); if(!im)return;
  ME={name,file:null,start:im.music?(im.music.start||0):0};
  $('#musChap').textContent='A partir desta foto';
  $('#musName').textContent=im.music?im.music.file:'nenhuma faixa ainda';
  $('#musRemove').style.display=im.music?'':'none';
  $('#musEdit').style.display='none';
  const a=$('#musAudio'); a.pause(); a.removeAttribute('src');
  $('#musModal').classList.add('show');
  if(im.music){const u=await musUrl(im.music.file); if(u)musPreview(u,ME.start);}
}
function musPreview(url,start){
  const a=$('#musAudio'); const r=$('#musStart');
  a.src=url;
  a.addEventListener('loadedmetadata',()=>{
    const d=isFinite(a.duration)?a.duration:0;
    r.max=Math.max(1,d.toFixed(1)); r.value=Math.min(start,d);
    ME.start=+r.value;
    $('#musDur').textContent=fmtSecs(d);
    $('#musStartLbl').textContent=fmtSecs(ME.start);
    $('#musEdit').style.display='';
    a.currentTime=ME.start;
  },{once:true});
}
function musCloseModal(){$('#musAudio').pause();$('#musModal').classList.remove('show');}
async function musSave(){
  const im=S.images.find(x=>x.name===ME.name); if(!im)return;
  const {file,start}=ME;
  if(file){
    if(!S.dir){toast('Abra a pasta das fotos primeiro.');return;}
    const ext=(file.name.match(/\.[a-z0-9]+$/i)||['.mp3'])[0];
    const fname=slug(file.name.replace(/\.[^.]+$/,''))+ext;
    try{
      const dir=await S.dir.getDirectoryHandle('_musica',{create:true});
      const fh=await dir.getFileHandle(fname,{create:true});
      const ws=await fh.createWritable(); await ws.write(await file.arrayBuffer()); await ws.close();
      im.music={file:fname,start};
    }catch(e){toast('Não deu para gravar em _musica/: '+e.message);return;}
    MUS.urls.delete(fname);
  }else if(im.music){im.music.start=start;}
  else{toast('Escolha um arquivo de música.');return;}
  MUS.key=null;   // força reavaliar o ponto ativo já com a mudança
  save(); musCloseModal(); render(); toast('Música salva a partir desta foto.');
}
function musRemove(){
  const im=S.images.find(x=>x.name===ME.name); if(!im)return;
  im.music=null;
  MUS.key=null; if(MUS.cur)musStop(.6);
  save(); musCloseModal(); render(); toast('Ponto de música removido (o arquivo continua em _musica/).');
}

/* ---------- RELEMBRAR ---------- */
const RC={list:[],i:0,idleT:null,lastChap:null,slide:null,wheelLock:0,
  phase:'load',                    // load → scan → out → rest (deitadas pulam direto para rest)
  zoom:localStorage.getItem('rcZoom')!=='0', // toggle: false = foto inteira e parada, uma por uma
  scannable:false,fill:1,inspect:false,level:2.4,
  sy:0,sy0:0,syTop:0,syEnd:0,vel:0,// varredura: posição, partida, limites e velocidade (px, px/s)
  hold:0,paused:false,m:1,         // flecha segurada (-1/0/+1), pausa, e o multiplicador em vigor
  u:.5,v:.5,                       // cursor normalizado (0..1) na tela — só a lupa usa
  sc:1,tx:0,ty:0,                  // transform em cena
  tSc:1,tTx:0,tTy:0,raf:0,last:0,  // transform de destino — o rcLoop persegue um a partir do outro
  play:localStorage.getItem('rcPlay')!=='0', // auto-avanço
  autoT:0,finT:0,secs:16,pace:null,close:false};
/* ---------- ritmo pelo tempo real ----------
   O que faz o dia parecer o dia é o intervalo entre as fotos. Rajada (você segurou o botão) passa
   voando e sem varredura — o enquadramento já foi visto na foto anterior. Um buraco de horas ganha
   respiro e um crossfade longo. É o EXIF ditando o compasso, não um timer fixo. */
const PACE={burst:3,near:90,far:1800};   // segundos: rajada, mesmo momento, "mudou o dia"
function paceOf(i){
  const cur=RC.list[i], prev=RC.list[i-1], next=RC.list[i+1];
  const gap=(a,b)=>(a&&b&&a.im&&b.im&&a.im.taken&&b.im.taken&&a.ch.id===b.ch.id)?(b.im.taken-a.im.taken)/1000:null;
  const gPrev=gap(prev,cur), gNext=gap(cur,next);
  const burst=gPrev!=null&&gPrev<=PACE.burst;
  let hold=3400;
  if(gNext!=null)hold=gNext<=PACE.burst?1500:gNext<=PACE.near?2800:gNext<=PACE.far?4000:6000;
  // ritmo automático × ajuste do usuário: global (rcPace) e por-foto (im.pace) multiplicam o hold
  const mult=globalPace()*((cur&&cur.im&&cur.im.pace)||1);
  hold=Math.round(hold*mult*jitterOf(cur));                       // + variação natural (não metronômico)
  // rajada varre mais curto, mas VARRE: sem isso ela ficava parada e pequena, e num festival quase
  // tudo é rajada — era o que fazia o zoom sumir do show inteiro
  return {burst,hold,scan:burst?RCSECS*.5:RCSECS,breath:gNext!=null&&gNext>PACE.far};
}
/* variação "natural" no tempo em tela: fator estável por foto (hash do nome, como o closeOf), pra
   os intervalos não ficarem metronômicos. NÃO toca no relógio/horário — só na duração do slide.
   Desligável em "Ritmo natural"; ±38% em torno de 1. */
function jitterOn(){ return localStorage.getItem('rcJitter')!=='0'; }   // ligado por padrão
function jitterOf(beat){
  if(!jitterOn()||!beat||!beat.im)return 1;
  const n=beat.im.name; let h=0; for(let k=0;k<n.length;k++)h=(h*31+n.charCodeAt(k))>>>0;
  return 0.62 + (h%1000)/1000*0.76;                              // 0.62 .. 1.38
}
/* “olhar de perto”: parte das fotos, em vez de recuar até a foto inteira (que numa vertical deixa
   dois terços de tela vazios), para a uns 1.55x e fica ali. Escolha por hash do nome — sorteada,
   mas estável: a mesma foto recebe sempre o mesmo tratamento, revisita após revisita. */
const RCCLOSE=1.55;
function closeOf(i){
  const n=RC.list[i].im.name;
  let h=0; for(let k=0;k<n.length;k++)h=(h*31+n.charCodeAt(k))>>>0;
  return h%3===0;
}
/* agenda a próxima foto sozinha. Só dispara em 'rest': durante a varredura quem manda é o rcLoop. */
function rcAuto(){
  clearTimeout(RC.autoT);
  if(!RC.play||RC.paused||RC.inspect||RC.statPending||RC.vnPending||RC.phase!=='rest')return;
  const ms=((RC.pace&&RC.pace.hold)||2200)+(RC.sceneHold||0);   // respiro extra da cena / através do preto
  RC.autoT=setTimeout(()=>{
    if(!RC.play||RC.paused||RC.inspect)return;
    if(RC.i>=RC.list.length-1)rcEnd(); else rcNav(1);
  },ms);
}
function rcPlayBtn(){const b=$('#rcPlayBtn'); if(b){b.textContent=(RC.play&&!RC.paused)?'⏸':'▶';
  b.title=(RC.play&&!RC.paused)?'Pausar (espaço)':'Continuar (espaço)';}}
function rcEnd(){
  const dias=S.chapters.filter(c=>inChap(c.id).length).length;
  const nf=RC.list.filter(b=>b.im).length;           // só fotos (cartões não contam)
  $('#rcFinT').textContent='Fim';
  $('#rcFinS').textContent=`${nf} fotos · ${dias} dia${dias===1?'':'s'}`;
  $('#rcFin').classList.add('on');
  musStop(4);
  clearTimeout(RC.finT); RC.finT=setTimeout(rcClose,5600);
}
// tudo que foi classificado, capítulos na ordem da barra lateral, fotos na ordem que você montou.
// beats: {im,ch} = foto (pode ter im.texts sobre ela) · {card,texts,ch} = tela preta depois de uma foto
function recallList(){
  const out=[];
  for(const ch of S.chapters) for(const im of inChap(ch.id)){
    if(im.cardBefore&&im.cardBefore.length) out.push({card:true,texts:im.cardBefore.slice(),ch,beforeName:im.name});
    out.push({im,ch});
    if(im.cardAfter&&im.cardAfter.length) out.push({card:true,texts:im.cardAfter.slice(),ch,afterName:im.name});
  }
  return out;
}
function renderRecall(){
  const c=$('#content'); c.style.overflow='auto'; c.style.display='block';
  const list=recallList();
  if(!list.length){
    c.style.display='flex';
    c.innerHTML=`<div class="center"><h2>Nada pra relembrar ainda</h2>
      <p>Classifique as fotos em capítulos na Triagem. Elas aparecem aqui na ordem exata que você montou em Sequenciar.</p></div>`;
    return;
  }
  const cards=S.chapters.map(ch=>{
    const ims=inChap(ch.id);
    const cover=ims[0]?`background-image:url('${ims[0].url}')`:''; // aspas simples: aspas duplas fechariam o style=""
    const span=chapSpan(ch.id);
    const nmus=ims.filter(im=>im.music&&im.music.file).length;   // pontos de música definidos neste dia
    return `<div class="chapCard${ims.length?'':' empty'}">
      <button class="go" data-chap="${esc(ch.id)}"${ims.length?'':' disabled'}>
        <div class="cover" style="${cover}">${ims.length?'':'vazio'}</div>
        <div class="meta"><div class="t">${esc(ch.name)}</div>
          <div class="s">${ims.length} foto${ims.length===1?'':'s'}${span?' · '+span:''}${nmus?' · ♪ '+nmus:''}</div></div>
      </button>
      <div class="play">▶</div>
    </div>`;
  }).join('');
  c.innerHTML=`<div class="recall">
    <div class="recallHead">
      <div>
        <h2>Relembrar</h2>
        <p>${list.length} fotos em ${S.chapters.length} capítulos, na ordem que você montou.
        Passa sozinho, <b>no ritmo em que o dia aconteceu</b>: o intervalo real entre as fotos vira o tempo de cada uma — rajada passa voando, buraco de horas ganha respiro.
        Com o zoom ligado, cada vertical entra ampliada e <b>desce sozinha</b>, devagar, até revelar a base — e parte delas <b>fica de perto</b> em vez de recuar até a foto inteira.
        Segure <kbd>→</kbd> para acelerar a descida, <kbd>←</kbd> para voltar; parada a foto, a flecha troca de foto.
        <kbd>espaço</kbd> pausa tudo · <kbd>↑</kbd> <kbd>↓</kbd> pulam · <kbd>Z</kbd> zoom · <kbd>M</kbd> mudo · clique no meio para a lupa · <kbd>F</kbd> tela cheia · <kbd>Esc</kbd> sai.</p>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px">
        <button class="primary" id="rcStart">▶ Começar do início</button>
        <label class="ck"><input type="checkbox" id="rcZoomCk"${RC.zoom?' checked':''}> Zoom automático</label>
        <label class="ck"><input type="checkbox" id="rcPlayCk"${RC.play?' checked':''}> Passar sozinho</label>
        <label class="ck" title="Ritmo geral do slideshow (mais rápido ↔ mais devagar)">Ritmo <input type="range" id="rcPaceR" min="0.5" max="2" step="0.1" value="${globalPace()}" style="width:110px"> <span id="rcPaceLbl" style="font:11px monospace;color:var(--mut);min-width:2.4em">${globalPace().toFixed(1)}×</span></label>
        <label class="ck" title="Varia um pouco o tempo de cada foto na tela, pra não ficar metronômico (não muda os horários)"><input type="checkbox" id="rcJitterCk"${jitterOn()?' checked':''}> Ritmo natural</label>
      </div>
    </div>
    <div class="chapCards">${cards}</div>
  </div>`;
  $('#rcStart').onclick=()=>rcOpen(0);
  $('#rcPaceR').oninput=e=>{ setGlobalPace(+e.target.value); $('#rcPaceLbl').textContent=(+e.target.value).toFixed(1)+'×'; };
  $('#rcJitterCk').onchange=e=>localStorage.setItem('rcJitter',e.target.checked?'1':'0');
  $('#rcZoomCk').onchange=e=>rcZoomSet(e.target.checked);
  $('#rcPlayCk').onchange=e=>{RC.play=e.target.checked;localStorage.setItem('rcPlay',RC.play?'1':'0');};
  c.querySelectorAll('.go[data-chap]:not([disabled])').forEach(b=>b.onclick=()=>{
    const idx=list.findIndex(x=>x.ch.id===b.dataset.chap);
    if(idx>=0)rcOpen(idx);
  });
}
function rcOpen(i){
  RC.list=recallList(); if(!RC.list.length)return;
  RC.i=Math.max(0,Math.min(i,RC.list.length-1));
  RC.lastChap=null; RC.slide=null;
  RC.play=localStorage.getItem('rcPlay')!=='0';
  clearTimeout(RC.finT); $('#rcFin').classList.remove('on');
  $('#rcStage').innerHTML='';
  RC.statVals={}; RC.statPending=false; clearTimeout(RC.statDT); // zera contadores/reveal da sessão
  const sb=$('#rcStats'); sb.classList.remove('on'); sb.innerHTML='';
  const bb=$('#rcStatBig'); bb.classList.remove('on'); bb.innerHTML='';
  RC.vnHidden=false; rcVNClear(); $('#rcVN').classList.remove('hidden'); // zera as falas da sessão
  RC.hudTime=''; RC.sceneHold=0; $('#rcHudCh').textContent=''; $('#rcHudTime').textContent=''; // zera o relógio da sessão
  $('#rc').classList.add('show');
  MUS.key=null; musApplyVol();     // este clique é o gesto que libera o autoplay do áudio
  rcZoomApply();                                     // sem slide em cena: só acerta o botão e a classe
  rcShow(); rcWake();
  document.documentElement.requestFullscreen?.().catch(()=>{}); // gesto do usuário — o Chrome permite
}
// HUD persistente: capítulo em cima, relógio embaixo. Sem EXIF, mantém a última hora conhecida.
function rcHud(chName, hour){
  $('#rcHudCh').textContent=chName||'';
  if(hour)RC.hudTime=hour;                             // hora já formatada (photoClock); sem hora, mantém a última
  const el=$('#rcHudTime'), now=RC.hudTime||'';
  if(el.textContent!==now){                           // mudou de hora entre fotos: micro-tick
    el.textContent=now;
    el.classList.remove('tick'); void el.offsetWidth; el.classList.add('tick');
  }
}
function rcFlash(){ const f=$('#rcFlash'); if(!f)return; f.classList.remove('go'); void f.offsetWidth; f.classList.add('go'); }
function rcShow(){
  rcVNClear();                                        // beat novo: encerra qualquer fala pendente
  if(RC.list[RC.i]&&RC.list[RC.i].card)return rcShowCard();
  const {im,ch}=RC.list[RC.i];
  cancelAnimationFrame(RC.raf); RC.raf=0;             // foto nova: a varredura da anterior morre aqui
  clearTimeout(RC.autoT);
  RC.inspect=false; RC.phase='load'; RC.hold=0; RC.paused=false; RC.m=1;
  RC.sc=RC.tSc=1; RC.tx=RC.tTx=0; RC.ty=RC.tTy=0;
  RC.pace=paceOf(RC.i); RC.secs=RC.pace.scan||RCSECS; RC.close=closeOf(RC.i);
  const scene=im.scene||{};                           // tom da cena: transição, clima, respiro
  RC.sceneHold=(scene.fx==='black'?1200:0)+(scene.hold?scene.hold*1600:0);
  $('#rc').classList.remove('zoomed');
  rcPlayBtn();

  // cada foto é um slide próprio (fundo + imagem) que entra sobre o anterior
  const s=document.createElement('div');
  s.className='rcSlide pan kb'+((RC.i%4)+1)+(scene.mood?' mood-'+scene.mood:'');
  const bg=document.createElement('div'); bg.className='rcBg';
  const img=document.createElement('img'); img.alt='';
  s.append(bg,img);
  $('#rcStage').appendChild(s);
  const old=RC.slide; RC.slide=s;
  // transição por foto: crossfade (padrão) · corte seco · através do preto · flash
  const fxKind=scene.fx||'crossfade';
  // buraco de horas na linha do tempo: a virada demora mais, como quem respira entre um lugar e outro
  let fade=RC.pace.breath?1500:500;
  if(fxKind==='cut')fade=60;
  s.style.transitionDuration=fade+'ms';
  if(old)old.style.transitionDuration=(fxKind==='black'?600:fade)+'ms';
  if(fxKind==='black'){
    // o slide velho sai primeiro; o novo entra depois de um respiro no preto (revelação)
    if(old){old.classList.remove('in'); setTimeout(()=>old.remove(),640);}
    setTimeout(()=>{ if(RC.slide===s)s.classList.add('in'); }, 640+700);
  }else{
    requestAnimationFrame(()=>{
      s.classList.add('in');
      if(old){old.classList.remove('in'); setTimeout(()=>old.remove(),fade+80);}
    });
    if(fxKind==='flash')rcFlash();
  }
  // a foto só tem tamanho depois de carregar — antes disso não há o que medir nem enquadrar
  const enter=()=>{
    if(RC.slide!==s)return;                           // já trocou de foto enquanto esta carregava
    rcMeasure();
    if(RC.zoom&&RC.scannable&&!rcRM.matches&&RC.pace.scan>0){
      rcSetup(0);                                     // varredura no ponto de partida
      RC.phase='scan';
      RC.sc=RC.fill; RC.tx=0; RC.ty=RC.sy; rcApply(); // entra já ampliada e enquadrada, sem deslizar
      rcKick();
    }else{                                            // deitada, rajada, ou zoom desligado: inteira e parada
      RC.phase='rest'; RC.sc=1; RC.tx=0; RC.ty=0;
      if(RC.zoom)rcRelease();                         // devolve a foto ao Ken Burns
      else rcApply();                                 // zoom off: segue em .pan (sem animação), sem transform
      rcAuto();
    }
    rcBar();
  };
  img.addEventListener('load',enter,{once:true});
  // decodifica uma vez, já no tamanho da tela; o fundo sai da miniatura de 32px
  rcPrep(im).then(rec=>{
    if(RC.slide!==s)return;
    bg.style.backgroundImage=`url("${rec.tiny}")`;
    img.src=rec.url;
  }).catch(()=>{if(RC.slide===s){bg.style.backgroundImage=`url("${im.url}")`;img.src=im.url;}});

  $('#rcCount').textContent=`${RC.i+1} / ${RC.list.length}`;
  rcHud(ch.name, photoClock(im,ch));                   // capítulo + relógio sintético no canto sup. direito
  $('#rcTitle').textContent=''; $('#rcSub').textContent='';  // info subiu pro HUD; rodapé só progresso
  rcBar();
  if(RC.lastChap!==ch.id){
    RC.lastChap=ch.id;
    const sp=chapSpan(ch.id);
    rcCard(ch.name+(sp?' · '+sp:''));
  }
  musSync(RC.i);                                     // toca/troca a faixa conforme o ponto de música ativo
  rcStatsShow();                                     // reveal central dos pontos ganhos + acúmulo no canto
  if(!RC.statPending)rcVNStart(im.texts);            // sem pausa de stat: começa as falas já; com pausa, começa no dismiss
  for(const d of [1,2,-1]){const n=RC.list[RC.i+d]; if(n&&n.im)rcPrep(n.im).catch(()=>{});} // vizinhas prontas antes da vez
}
/* Stats no Recall, em dois lugares:
   - REVEAL central: quando a foto atual soma pontos, os stats ganhos aparecem grandes no meio com
     "+N". O slideshow pausa (RC.statPending) até dar → ou passar ~2,8s; aí eles "pousam" no canto.
   - CANTINHO: total acumulado do Dia 1 até a foto atual. Recalcula do zero (idempotente; voltar desce).
   A separação faz o número do canto só subir DEPOIS do reveom — os pontos parecem viajar do meio pro canto. */
function rcStatsShow(){
  clearTimeout(RC.statDT); RC.statPending=false;
  const cur=RC.list[RC.i]&&RC.list[RC.i].im;
  const inc=cur&&cur.stats?cur.stats:null;
  const gains=inc?S.stats.filter(s=>inc[s.id]>0):[];
  if(!gains.length){ rcStatBigHide(); rcStatsCorner(RC.i,true); return; }
  rcStatsCorner(RC.i-1,false);                        // canto mostra tudo ATÉ antes desta foto
  const totals={};                                   // total já incluindo esta foto (pro rótulo do reveal)
  for(let k=0;k<=RC.i;k++){const b=RC.list[k]; const st=b&&b.im&&b.im.stats; if(st)for(const id in st)totals[id]=(totals[id]||0)+st[id];}
  rcStatBigShow(gains,inc,totals);
  RC.statPending=true;
  RC.statDT=setTimeout(rcStatDismiss,2800);
}
function rcStatDismiss(){
  if(!RC.statPending)return;
  clearTimeout(RC.statDT); RC.statPending=false;
  rcStatBigHide();
  rcStatsCorner(RC.i,true);                           // agora inclui esta foto: conta e dá o pop no canto
  const cur=RC.list[RC.i]&&RC.list[RC.i].im;
  if(cur&&cur.texts&&cur.texts.length)rcVNStart(cur.texts); // depois dos pontos, entram as falas
  else rcAuto();                                     // senão, libera o auto-avanço que estava segurado
}
function rcStatBigShow(gains,inc,totals){
  const big=$('#rcStatBig'); if(!big)return;
  big.innerHTML='';
  gains.forEach((s,k)=>{
    const card=el('div','rcBigCard'); card.style.setProperty('--c',s.color); card.style.animationDelay=(k*90)+'ms';
    card.innerHTML=`<span class="be">${esc(s.emoji||'⭐')}</span>`+
      `<div class="bmeta"><div class="bn">${esc(s.name)}</div><div class="bt">total ${totals[s.id]}</div></div>`+
      `<span class="bp">+${inc[s.id]}</span>`;
    big.appendChild(card);
    requestAnimationFrame(()=>card.classList.add('in'));
  });
  big.classList.add('on');
}
function rcStatBigHide(){
  const big=$('#rcStatBig'); if(!big||!big.classList.contains('on'))return;
  big.querySelectorAll('.rcBigCard').forEach(c=>{c.style.animationDelay='0ms';c.classList.remove('in');c.classList.add('out');});
  setTimeout(()=>{big.classList.remove('on');big.innerHTML='';},420);
}
function rcStatsCorner(upto,animate){
  const box=$('#rcStats'); if(!box)return;
  const totals={};
  for(let k=0;k<=upto;k++){const b=RC.list[k]; const st=b&&b.im&&b.im.stats; if(st)for(const id in st)totals[id]=(totals[id]||0)+st[id];}
  const active=S.stats.filter(s=>totals[s.id]>0);
  RC.statVals=RC.statVals||{};
  if(!active.length){box.classList.remove('on');box.innerHTML='';RC.statVals={};return;}
  box.classList.add('on');
  for(const id in RC.statVals) if(!totals[id]){const r=box.querySelector(`[data-st="${id}"]`);if(r)r.remove();delete RC.statVals[id];}
  active.forEach(s=>{
    const prev=RC.statVals[s.id]||0, cur=totals[s.id];
    let row=box.querySelector(`[data-st="${s.id}"]`);
    if(!row){
      row=el('div','rcStatRow'); row.dataset.st=s.id; row.style.setProperty('--c',s.color);
      row.innerHTML=`<span class="e">${esc(s.emoji||'⭐')}</span><span class="n">${esc(s.name)}</span><span class="v">${animate?prev:cur}</span>`;
      box.appendChild(row); requestAnimationFrame(()=>row.classList.add('in'));
    }
    const vEl=row.querySelector('.v');
    if(cur!==prev&&animate){
      rcCountUp(vEl,prev,cur);
      if(cur>prev){vEl.classList.remove('bump');void vEl.offsetWidth;vEl.classList.add('bump');}
    }else vEl.textContent=cur;
    RC.statVals[s.id]=cur;
  });
}
function rcCountUp(elm,from,to){
  const dur=Math.min(700,180+Math.abs(to-from)*120), t0=performance.now();
  (function step(t){const p=Math.min(1,(t-t0)/dur);elm.textContent=Math.round(from+(to-from)*p);if(p<1)requestAnimationFrame(step);})(performance.now());
}

/* ---------- VISUAL NOVEL: falas digitadas ----------
   As falas de uma foto (im.texts) aparecem sobre ela; as de um cartão (beat preto) aparecem no lugar
   da foto. Digita letra por letra; enquanto houver fala não-lida, RC.vnPending segura o avanço.
   → completa a fala em digitação (1º) e depois avança (2º). Em auto-play, cada fala tem um respiro
   proporcional ao tamanho e avança sozinha. H esconde/mostra a caixa sem parar o fluxo. */
// as falas agora são docs ricos; o renderer (renderFala) cuida da digitação/efeito/estilo por trecho
function rcVNStart(falasRaw){
  rcVNClear();
  const falas=(falasRaw||[]).map(normalizeFala).filter(f=>falaPlain(f));
  if(!falas.length){RC.vnPending=false;return;}
  RC.vn={falas,i:0,typing:false,ctrl:null,dwell:0};
  RC.vnPending=true;
  $('#rcVN').classList.add('on');
  $('#rcVNhint').textContent='→ continuar · H esconde';
  rcVNPlayLine();
}
function rcVNPlayLine(){
  const v=RC.vn; if(!v)return;
  clearTimeout(v.dwell); v.typing=true;
  v.ctrl=renderFala($('#rcVNtext'), v.falas[v.i], ()=>{ if(RC.vn===v){ v.typing=false; rcVNAfterLine(); } });
}
function rcVNAfterLine(){
  const v=RC.vn; if(!v)return;
  if(RC.play&&!RC.paused){ const len=falaPlain(v.falas[v.i]).length; const t=Math.min(6000,1500+len*46); v.dwell=setTimeout(()=>rcVNAdvance(false),t); }
}
function rcVNAdvance(manual){
  const v=RC.vn; if(!v||!RC.vnPending)return;
  if(v.typing&&v.ctrl&&!v.ctrl.done){ v.ctrl.complete(); return; } // 1º → completa a fala (onDone dispara afterLine)
  clearTimeout(v.dwell);
  if(v.i<v.falas.length-1){ v.i++; rcVNPlayLine(); }
  else{ rcVNClear(); if(manual)rcNav(1); else rcAuto(); } // fim das falas: manual troca já; auto agenda pelo ritmo
}
function rcVNClear(){
  const v=RC.vn; if(v){ clearTimeout(v.dwell); if(v.ctrl)v.ctrl.destroy(); }
  RC.vn=null; RC.vnPending=false;
  const box=$('#rcVN'); if(box){ box.classList.remove('on'); const t=$('#rcVNtext'); if(t)t.textContent=''; }
}
function rcVNToggleHide(){
  RC.vnHidden=!RC.vnHidden;
  $('#rcVN').classList.toggle('hidden',RC.vnHidden);
  toast(RC.vnHidden?'Texto escondido · H para mostrar':'Texto visível');
}
/* beat de cartão: tela preta que herda o lugar da foto, com as falas por cima */
function rcShowCard(){
  const beat=RC.list[RC.i];
  cancelAnimationFrame(RC.raf); RC.raf=0; clearTimeout(RC.autoT);
  RC.inspect=false; RC.phase='rest'; RC.hold=0; RC.paused=false; RC.m=1;
  RC.statPending=false; clearTimeout(RC.statDT);
  RC.pace={hold:1200,scan:0,breath:true}; RC.scannable=false; RC.sceneHold=0;
  RC.sc=RC.tSc=1; RC.tx=RC.tTx=0; RC.ty=RC.tTy=0;
  rcHud(beat.ch?beat.ch.name:'', null);               // mantém capítulo e a última hora no HUD
  $('#rc').classList.remove('zoomed'); rcPlayBtn();
  const s=el('div','rcSlide'); s.style.background='#000';
  $('#rcStage').appendChild(s);
  const old=RC.slide; RC.slide=s;
  const fade=800; s.style.transitionDuration=fade+'ms'; if(old)old.style.transitionDuration=fade+'ms';
  requestAnimationFrame(()=>{ s.classList.add('in'); if(old){old.classList.remove('in'); setTimeout(()=>old.remove(),fade+80);} });
  $('#rcTitle').textContent=''; $('#rcSub').textContent='';
  $('#rcCount').textContent=`${RC.i+1} / ${RC.list.length}`; rcBar();
  rcStatsCorner(RC.i,false);                           // canto continua visível (cartão não soma nada)
  musSync(RC.i);                                       // mantém a faixa do ponto ativo (ou silencia)
  const n=RC.list[RC.i+1]; if(n&&n.im)rcPrep(n.im).catch(()=>{});
  setTimeout(()=>{ if(RC.slide===s)rcVNStart(beat.texts); },520); // falas entram depois do fade
}

/* ---------- leitura por varredura ----------
   Uma vertical (9:16) contida num monitor 16:9 ocupa só ~1/3 da largura: sobra tela dos dois lados e a
   foto fica pequena e distante. Aqui ela entra AMPLIADA até preencher a largura (RC.fill), pousando um
   pouco abaixo da borda de cima (RCDROP — o alto de uma vertical quase sempre é céu/teto vazio), e
   então DESCE SOZINHA, devagar, até revelar a base. Aí recua para a foto inteira e fica parada.

     varredura (scan)  →  recuo (out)  →  parada (rest)  →  flecha  →  próxima foto

   Durante a varredura a flecha é acelerador, não navegação: segurar → acelera a descida, segurar ←
   sobe de volta. A flecha só troca de foto depois que a varredura acabou.
   Foto deitada não tem sobra nenhuma: entra direto em "parada", com o Ken Burns de sempre. */
const rcRM=matchMedia('(prefers-reduced-motion:reduce)');
const RCDROP=.22;      // onde a varredura começa, em fração da altura da foto (0 = colada na borda de cima)
const RCSECS=16;       // duração da varredura inteira, em segundos, na velocidade normal
const RCFAST=5;        // segurar →: multiplica a velocidade
const RCBACK=4;        // segurar ←: volta, nesta velocidade
function rcImg(){return RC.slide&&RC.slide.querySelector('img');}
function rcMeasure(){
  const img=rcImg();
  RC.fill=1; RC.scannable=false;
  if(!img||!img.offsetWidth)return;
  const sharp=img.naturalWidth*2/img.offsetWidth;  // teto de nitidez: nada de esticar além de 2x os pixels reais
  RC.fill=Math.max(1,Math.min(3.2,sharp,innerWidth/img.offsetWidth)); // 3.2: verticais extremas viram túnel
  RC.scannable=RC.fill>1.35;                       // deitadas e 4:3 sobram pouco: não há o que varrer
}
// o quanto a foto passa da tela, em px, numa dada escala (metade para cada lado)
function rcOver(s){
  const img=rcImg(); if(!img)return{x:0,y:0};
  return {x:Math.max(0,(img.offsetWidth*s-innerWidth)/2), y:Math.max(0,(img.offsetHeight*s-innerHeight)/2)};
}
/* limites da varredura, em px de deslocamento vertical da foto (sy>0 desce a foto = mostra o alto dela).
   frac = onde repor a varredura (0 = partida, 1 = base) — o resize recalcula tudo sem perder o lugar. */
function rcSetup(frac){
  const img=rcImg(); if(!img)return;
  const o=rcOver(RC.fill), ph=img.offsetHeight*RC.fill;
  RC.syTop=o.y;                                    // borda de cima da foto colada no topo da tela
  RC.syEnd=-o.y;                                   // borda de baixo colada na base da tela: fim da varredura
  RC.sy0=Math.max(RC.syEnd,o.y-RCDROP*ph);         // partida, RCDROP abaixo da borda de cima
  RC.vel=(RC.sy0-RC.syEnd)/(RC.secs||RCSECS);      // px/s para cobrir o caminho todo no tempo da foto
  RC.sy=RC.sy0+(RC.syEnd-RC.sy0)*frac;
}
function rcTargets(){
  if(RC.inspect){                                  // lupa: o mouse passeia livre, nos dois eixos
    const o=rcOver(RC.level);
    RC.tSc=RC.level; RC.tTx=-(RC.u-.5)*2*o.x; RC.tTy=-(RC.v-.5)*2*o.y;
    return;
  }
  RC.tTx=0;
  if(RC.phase==='scan'){RC.tSc=RC.fill; RC.tTy=RC.sy; return;}
  // com o zoom desligado ele pediu foto inteira e parada — “de perto” não vale aqui
  if(RC.close&&RC.scannable&&RC.zoom){             // recuo parcial: fica perto, sem as bordas vazias
    RC.tSc=Math.min(RC.fill,RCCLOSE); RC.tTy=0; return;
  }
  RC.tSc=1; RC.tTy=0;                              // recuo e parada: a foto inteira, centrada
}
function rcApply(){
  const img=rcImg(); if(!img)return;
  img.style.transform=`translate3d(${RC.tx.toFixed(1)}px,${RC.ty.toFixed(1)}px,0) scale(${RC.sc.toFixed(4)})`;
}
function rcLoop(ts){
  RC.raf=0;
  if(!RC.slide)return;
  const dt=Math.min(.05,Math.max(0,(ts-RC.last)/1000)); RC.last=ts;  // .05: se a aba dormiu, não teleporta
  if(RC.phase==='scan'&&!RC.inspect){
    const alvo=RC.paused?0:RC.hold>0?RCFAST:RC.hold<0?-RCBACK:1;
    RC.m+=(alvo-RC.m)*Math.min(1,dt*7);            // o acelerador entra e sai suave, não em degrau
    RC.sy-=RC.vel*RC.m*dt;                         // sy diminui = a foto sobe = revela o que vem abaixo
    if(RC.sy>RC.syTop){RC.sy=RC.syTop; RC.m=0;}    // topo da foto: não há mais o que voltar
    if(RC.sy<=RC.syEnd){RC.sy=RC.syEnd; RC.phase='out'; RC.hold=0;}  // chegou na base: recua
  }
  rcTargets();
  // ease exponencial, mas em função do tempo: mesmo movimento a 60 ou a 144 fps. O recuo é mais lento.
  const k=rcRM.matches?1:1-Math.pow(1-(RC.phase==='out'?.04:.14),dt*60);
  RC.sc+=(RC.tSc-RC.sc)*k; RC.tx+=(RC.tTx-RC.tx)*k; RC.ty+=(RC.tTy-RC.ty)*k;
  const parado=Math.abs(RC.tSc-RC.sc)<.001&&Math.abs(RC.tTx-RC.tx)<.3&&Math.abs(RC.tTy-RC.ty)<.3;
  if(parado){RC.sc=RC.tSc; RC.tx=RC.tTx; RC.ty=RC.tTy;}
  rcApply(); rcBar();
  if(RC.phase==='out'&&parado){RC.phase='rest'; rcAuto();}   // a foto pousou: começa a contar a próxima
  if(parado&&!RC.inspect&&!RC.scannable&&RC.zoom)rcRelease(); // deitada: devolve a foto ao Ken Burns
  if(RC.phase==='scan'||RC.inspect||!parado)RC.raf=requestAnimationFrame(rcLoop);
}
function rcKick(){if(!RC.raf&&RC.slide){RC.last=performance.now(); RC.raf=requestAnimationFrame(rcLoop);}}
function rcEngage(){if(RC.slide)RC.slide.classList.add('pan');}
function rcRelease(){
  const img=rcImg(); if(!img||!RC.slide.classList.contains('pan'))return;
  RC.slide.classList.remove('pan'); img.style.transform='';
}
/* a flecha muda de papel conforme a fase: acelerador durante a varredura, navegação depois dela */
function rcHold(d){                                // segurando: acelera (→) ou volta (←) a varredura
  if(RC.statPending||RC.vnPending)return false;   // com reveal/fala na tela, a seta avança isso (via rcArrow), não acelera
  if(RC.phase!=='scan'||RC.inspect)return false;
  RC.hold=d; RC.paused=false; rcKick(); rcWake();
  return true;
}
function rcArrow(d){                               // toque: só troca de foto quando a varredura acabou
  if(RC.statPending){rcStatDismiss();return;}     // reveal na tela: a seta manda os pontos pro canto
  if(RC.vnPending){rcVNAdvance(true);return;}       // fala na tela: a seta completa/avança a fala
  if(RC.inspect){rcInspectOff();return;}
  if(RC.phase==='scan')return;
  rcNav(d);
}
/* espaço: uma pausa só para tudo — varredura, auto-avanço e música. Antes ele avançava a foto
   quando a varredura já tinha acabado; com trilha tocando, pausar é o que se espera do espaço. */
function rcPause(){
  RC.paused=!RC.paused;
  if(RC.paused){clearTimeout(RC.autoT); if(MUS.cur)musFade(MUS.cur,0,.4,true);}
  else{
    if(MUS.cur){MUS.cur.play().catch(()=>{}); musFade(MUS.cur,musVol(),.6);}
    rcAuto();
  }
  rcPlayBtn(); rcKick(); rcWake();
}
/* lupa: clique no centro amplia no ponto clicado e o mouse passeia pela foto; clique de novo volta.
   A varredura congela enquanto a lupa está aberta e retoma de onde parou. */
function rcInspectOn(cx,cy){
  if(!rcImg())return;
  RC.u=cx/innerWidth; RC.v=cy/innerHeight;
  RC.level=Math.max(2.4,RC.fill*1.4);              // sempre mais perto do que o enquadramento atual
  RC.inspect=true; RC.hold=0;
  clearTimeout(RC.autoT);                          // olhando de perto: o show espera
  $('#rc').classList.add('zoomed'); rcEngage(); rcKick(); rcWake();
}
function rcInspectOff(){
  RC.inspect=false;
  $('#rc').classList.remove('zoomed'); rcKick(); rcWake(); rcAuto();
}
/* toggle do zoom automático (varredura + Ken Burns). Desligado, a foto entra inteira e fica parada:
   a flecha volta a ser navegação pura. A lupa continua valendo — só acontece se você clicar. */
function rcZoomSet(on){
  RC.zoom=on;
  localStorage.setItem('rcZoom',on?'1':'0');
  const ck=$('#rcZoomCk'); if(ck)ck.checked=on;
  rcZoomApply();
  if($('#rc').classList.contains('show'))toast(on?'Zoom automático ligado':'Zoom automático desligado');
}
function rcZoomApply(){
  $('#rc').classList.toggle('nozoom',!RC.zoom);
  $('#rcZoomBtn').classList.toggle('off',!RC.zoom);
  $('#rcZoomBtn').title=RC.zoom?'Desligar zoom automático (Z)':'Ligar zoom automático (Z)';
  if(!RC.slide)return;
  if(!RC.zoom){                                      // corta a varredura em curso: recua para a foto inteira
    if(RC.inspect)rcInspectOff();
    RC.hold=0; RC.paused=false;
    if(RC.phase==='scan')RC.phase='out';
    rcEngage();                                      // segura o Ken Burns: quem manda no transform é o rcLoop
    rcKick();
  }else{                                             // religou: a foto em cena volta a varrer do começo
    rcMeasure();
    if(RC.scannable&&!rcRM.matches){rcSetup(0); RC.phase='scan'; rcEngage();}
    rcKick();
  }
  rcWake();
}
function rcCard(text){
  const el=$('#rcCard');
  el.querySelector('span').textContent=text;
  el.classList.remove('on'); void el.offsetWidth; el.classList.add('on');
}
// a barra acompanha a varredura dentro da foto, não só a troca de foto
function rcBar(){
  let p=0;
  if(RC.phase==='scan')p=.92*Math.max(0,Math.min(1,(RC.sy0-RC.sy)/(RC.sy0-RC.syEnd||1)));
  else if(RC.phase==='out')p=.96;
  else if(RC.phase==='rest')p=1;
  $('#rcBar>i').style.width=((RC.i+p)/RC.list.length*100)+'%';
}
function rcNav(d){
  // ↑↓ pulam de beat direto: rcShow encerra reveal/fala do beat anterior. → ← passam por rcArrow,
  // que primeiro dispensa o reveal de stat e avança as falas antes de trocar de beat.
  const n=RC.i+d;
  if(n<0){rcCard('Começo');return;}
  if(n>=RC.list.length){rcCard('Fim ✦');return;}
  RC.i=n; rcShow(); rcWake();
}
function rcGo(i){RC.i=Math.max(0,Math.min(i,RC.list.length-1));rcShow();rcWake();}
function rcWake(){
  const el=$('#rc'); el.classList.remove('idle'); clearTimeout(RC.idleT);
  if(RC.inspect)return;                             // na lupa o cursor precisa continuar visível
  RC.idleT=setTimeout(()=>el.classList.add('idle'),2600);
}
function rcFs(){
  if(document.fullscreenElement)document.exitFullscreen().catch(()=>{});
  else document.documentElement.requestFullscreen().catch(()=>{});
}
function rcClose(){
  $('#rc').classList.remove('show','fs','zoomed');
  cancelAnimationFrame(RC.raf); RC.raf=0;
  RC.inspect=false; RC.phase='load'; RC.hold=0; RC.paused=false;
  $('#rcStage').innerHTML=''; RC.slide=null;
  rcVNClear();                                        // encerra timers de digitação de falas
  clearTimeout(RC.idleT); clearTimeout(RC.autoT); clearTimeout(RC.finT);
  $('#rcFin').classList.remove('on');
  musStop(1.2);
  if(document.fullscreenElement)document.exitFullscreen().catch(()=>{});
}

/* ---------- exportar ---------- */
function buildExportList(){
  const out=[]; let n=1;
  for(const ch of S.chapters){
    for(const im of inChap(ch.id)){
      const ext=(im.name.match(/\.[^.]+$/)||['.jpg'])[0];
      out.push({im,name:String(n).padStart(3,'0')+'_'+slug(ch.name)+ext});
      n++;
    }
  }
  return out;
}
// rótulo do destino: pasta escolhida, ou a subpasta padrão dentro da pasta das imagens
function destLabel(){return S.outDir?`${S.outDir.name}/`:`${S.dir?S.dir.name:'…'}/_organizado/`;}
function refreshDest(){
  $('#exportDest').textContent=destLabel();
  $('#exportDest').title=destLabel();
  $('#exportDestReset').style.display=S.outDir?'':'none';
}
async function pickExportDir(){
  try{
    const h=await window.showDirectoryPicker({mode:'readwrite',id:'organizador-export'});
    S.outDir=h; await idbSet('outdir',h); refreshDest();
  }catch(e){if(e.name!=='AbortError')console.error(e);}
}
async function resetExportDir(){S.outDir=null; await idbSet('outdir',null); refreshDest();}
function openExport(){
  const list=buildExportList();
  if(!list.length){alert('Nada para exportar. Classifique algumas imagens primeiro.');return;}
  const prev=list.slice(0,4).map(x=>x.name).join('\n')+(list.length>4?`\n… (+${list.length-4})`:'');
  $('#exportPreview').textContent=prev;
  refreshDest();
  $('#exportModal').classList.add('show');
}
// destino efetivo: a pasta escolhida (grava direto nela) ou _organizado/ dentro da pasta das imagens
async function resolveDest(){
  if(!S.outDir) return {out:await S.dir.getDirectoryHandle('_organizado',{create:true}), rejBase:S.dir};
  const p=await S.outDir.requestPermission({mode:'readwrite'});
  if(p!=='granted'){alert('Sem permissão de escrita na pasta de destino. Escolha a pasta de novo.');return null;}
  return {out:S.outDir, rejBase:S.outDir};
}
async function doExport(){
  const list=buildExportList();
  const dest=await resolveDest(); if(!dest)return;
  const {out,rejBase}=dest;
  let done=0;
  for(const {im,name} of list){
    const src=await im.handle.getFile();
    const fh=await out.getFileHandle(name,{create:true});
    const ws=await fh.createWritable();
    await ws.write(await src.arrayBuffer()); await ws.close();
    done++; $('#exportGo').textContent=`${done}/${list.length}…`;
  }
  if($('#ckRej').checked){
    const rejDir=await rejBase.getDirectoryHandle('_rejeitadas',{create:true});
    for(const im of S.images.filter(i=>i.rej)){
      const src=await im.handle.getFile();
      const fh=await rejDir.getFileHandle(im.name,{create:true});
      const ws=await fh.createWritable(); await ws.write(await src.arrayBuffer()); await ws.close();
    }
  }
  $('#exportGo').textContent='Exportar agora';
  $('#exportModal').classList.remove('show');
  toast(`✓ ${list.length} imagens em ${destLabel()}`);
}

/* ---------- telas iniciais ---------- */
function emptyOpen(){
  $('#content').innerHTML=`<div class="center">
    <h2>Nenhuma imagem carregada</h2>
    <p>Abra a pasta com suas imagens. A ferramenta lê tudo, você classifica em capítulos, rejeita as ruins, ordena, e exporta cópias renumeradas — sem tocar nos originais.</p>
  </div>`;
}

/* ---------- teclado global ---------- */
document.addEventListener('keydown',e=>{
  // arrastando: Esc larga a foto onde ela estava
  if(DND.on){if(e.key==='Escape'){e.preventDefault();dndEnd();}return;}
  // player "Relembrar" aberto: só navegação, nada de editar
  if($('#rc').classList.contains('show')){
    const k=e.key;
    // varrendo: ← → são acelerador (segurar). Parada a foto: trocam de foto. ↑ ↓ pulam sempre.
    if(k==='ArrowRight'){e.preventDefault(); if(!rcHold(1)&&!e.repeat)rcArrow(1);}
    else if(k==='ArrowLeft'){e.preventDefault(); if(!rcHold(-1)&&!e.repeat)rcArrow(-1);}
    else if(k==='ArrowDown'||k==='PageDown'){e.preventDefault(); if(!e.repeat)rcNav(1);}
    else if(k==='ArrowUp'||k==='PageUp'){e.preventDefault(); if(!e.repeat)rcNav(-1);}
    else if(k===' '){e.preventDefault(); if(!e.repeat)rcPause();}
    else if(k==='Escape'){if(RC.inspect)rcInspectOff();else rcClose();} // na lupa: Esc só desfaz o zoom
    else if(k.toLowerCase()==='f'){e.preventDefault();rcFs();}
    else if(k.toLowerCase()==='m'){e.preventDefault(); if(!e.repeat){MUS.muted=!MUS.muted;
      localStorage.setItem('rcMute',MUS.muted?'1':'0');musApplyVol();rcWake();}}
    else if(k.toLowerCase()==='z'){e.preventDefault(); if(!e.repeat)rcZoomSet(!RC.zoom);}
    else if(k.toLowerCase()==='h'){e.preventDefault(); if(!e.repeat)rcVNToggleHide();}
    else if(k==='Home'){e.preventDefault();rcGo(0);}
    else if(k==='End'){e.preventDefault();rcGo(RC.list.length-1);}
    else rcWake();
    return;
  }
  // visualizador aberto: setas navegam, esc fecha, x rejeita
  if($('#lb').classList.contains('show')){
    if(e.key==='ArrowRight'){e.preventDefault();lbNav(1);}
    else if(e.key==='ArrowLeft'){e.preventDefault();lbNav(-1);}
    else if(e.key==='Escape')lbClose();
    else if(e.key.toLowerCase()==='x')lbToggleReject();
    else if(e.key.toLowerCase()==='d'||e.key==='Delete'){e.preventDefault();lbRemoveFromSeq();}
    return;
  }
  if($('#vnPreview').classList.contains('show')){    // prévia fullscreen
    if(PV.list.length&&e.key==='ArrowRight'){e.preventDefault();pvNav(1);}   // ← → trocam de foto na visão
    else if(PV.list.length&&e.key==='ArrowLeft'){e.preventDefault();pvNav(-1);}
    else if(e.key===' '||e.key==='ArrowRight'){e.preventDefault();previewSkip();} // espaço avança o texto (→ na prévia de 1 fala)
    else if(e.key==='Escape')closePreview();
    return;}
  if(document.querySelector('.modal.show')){
    if(e.key==='Escape'){
      $('#musAudio').pause();
      if($('#textModal').classList.contains('show'))closeTextModal();   // limpa editores TipTap + poda falas vazias
      else document.querySelectorAll('.modal').forEach(m=>m.classList.remove('show'));
    }
    return;}
  if(document.activeElement&&document.activeElement.tagName==='INPUT')return;
  if(S.mode!=='triage'||!S.images.length)return;
  const im=S.images[S.tIdx];
  if(e.key===' '||e.key==='ArrowRight'){e.preventDefault();if(S.tIdx<S.images.length-1)S.tIdx++;renderTriage();updateCounts();}
  else if(e.key==='ArrowLeft'){if(S.tIdx>0)S.tIdx--;renderTriage();}
  else if(e.key.toLowerCase()==='x'){reject(im);advanceUnassigned();}
  else if(e.key.toLowerCase()==='u'){unassign(im);renderTriage();updateCounts();}
  else if(e.key.toLowerCase()==='n'){e.preventDefault();jumpUnassigned();}
  else if(e.key==='Home'){e.preventDefault();S.tIdx=0;renderTriage();updateCounts();}
  else if(e.key==='End'){e.preventDefault();S.tIdx=S.images.length-1;renderTriage();updateCounts();}
  else if(/^[1-9]$/.test(e.key)){const ch=S.chapters[+e.key-1];if(ch){assign(im,ch.id);advanceUnassigned();}}
});

/* ---------- wiring ---------- */
$('#btnOpen').onclick=pickFolder;
$('#btnReopen').onclick=reopen;
$('#btnSim').onclick=similaritySort;
$('#btnSave').onclick=downloadSession;
$('#btnRestore').onclick=()=>$('#importFile').click();
$('#importFile').onchange=e=>{const f=e.target.files[0]; if(f)importSessionFile(f); e.target.value='';};
$('#btnExport').onclick=openExport;
$('#lbPrev').onclick=()=>lbNav(-1);
$('#lbNext').onclick=()=>lbNav(1);
$('#lbClose').onclick=lbClose;
$('#lbReject').onclick=lbToggleReject;
$('#lbRemove').onclick=lbRemoveFromSeq;
$('#lbPosInput').addEventListener('mousedown',e=>e.stopPropagation());
$('#lbPosInput').addEventListener('click',e=>e.stopPropagation());
$('#lbPosInput').addEventListener('keydown',e=>{e.stopPropagation(); // impede setas/x/d de vazarem p/ o handler global
  if(e.key==='Enter'){e.preventDefault();const v=parseInt(e.target.value,10);if(v>0)lbMoveTo(v);}
  else if(e.key==='Escape'){e.preventDefault();lbShow();}});
$('#lb').addEventListener('click',e=>{if(e.target.id==='lb')lbClose();});
$('#exportCancel').onclick=()=>$('#exportModal').classList.remove('show');
$('#exportGo').onclick=doExport;
$('#exportPick').onclick=pickExportDir;
$('#exportDestReset').onclick=resetExportDir;
// segurar a flecha acelera a varredura; o clique só vale depois que ela termina (ver rcHold/rcArrow)
for(const [id,d] of [['#rcPrev',-1],['#rcNext',1]]){
  const b=$(id);
  b.addEventListener('mousedown',e=>{e.preventDefault(); rcHold(d);});
  b.addEventListener('click',()=>rcArrow(d));
}
addEventListener('mouseup',()=>{if(RC.hold){RC.hold=0; rcKick();}});
$('#rcExit').onclick=rcClose;
$('#rcFsBtn').onclick=rcFs;
$('#rcZoomBtn').onclick=()=>rcZoomSet(!RC.zoom);
$('#rcPlayBtn').onclick=rcPause;
$('#rcMute').onclick=()=>{MUS.muted=!MUS.muted;localStorage.setItem('rcMute',MUS.muted?'1':'0');musApplyVol();rcWake();};
$('#rcVol').oninput=e=>{MUS.vol=e.target.value/100;MUS.muted=false;
  localStorage.setItem('rcVol',MUS.vol);localStorage.setItem('rcMute','0');musApplyVol();};
/* ---- modal da música ---- */
$('#musPick').onclick=()=>$('#musFile').click();
$('#musFile').onchange=e=>{
  const f=e.target.files[0]; if(!f)return;
  ME.file=f; ME.start=0;
  $('#musName').textContent=f.name;
  $('#musRemove').style.display='';
  musPreview(URL.createObjectURL(f),0);
};
$('#musStart').oninput=e=>{
  ME.start=+e.target.value;
  $('#musStartLbl').textContent=fmtSecs(ME.start);
  const a=$('#musAudio'); if(a.src)a.currentTime=ME.start;   // arrastar já leva a prévia junto
};
$('#musPlay').onclick=()=>{
  const a=$('#musAudio'); if(!a.src)return;
  if(a.paused){a.currentTime=ME.start;a.volume=musVol()||.8;a.play().catch(()=>{});$('#musPlay').textContent='⏸ Parar';}
  else{a.pause();$('#musPlay').textContent='▶ Ouvir daqui';}
};
$('#musAudio').addEventListener('pause',()=>$('#musPlay').textContent='▶ Ouvir daqui');
$('#musSave').onclick=musSave;
$('#musCancel').onclick=musCloseModal;
$('#musRemove').onclick=musRemove;
$('#rc').addEventListener('mousemove',e=>{
  RC.u=e.clientX/innerWidth; RC.v=e.clientY/innerHeight; // só a lupa segue o cursor
  if(RC.inspect)rcKick();
  rcWake();
});
$('#rcStage').addEventListener('click',e=>{           // clique no centro: lupa no ponto clicado / volta
  if(RC.inspect)rcInspectOff(); else rcInspectOn(e.clientX,e.clientY);
});
addEventListener('resize',()=>{                       // a tela mudou: o enquadramento é todo em px
  if(!$('#rc').classList.contains('show')||!RC.slide)return;
  const f=RC.phase==='scan'?(RC.sy0-RC.sy)/(RC.sy0-RC.syEnd||1):0;  // repõe a varredura onde estava
  rcMeasure();
  if(RC.zoom&&RC.scannable)rcSetup(f); else if(RC.phase==='scan')RC.phase='out';
  rcKick();
});
document.addEventListener('fullscreenchange',()=>{ // em tela cheia a UI some de vez; ao sair, volta
  $('#rc').classList.toggle('fs',!!document.fullscreenElement);
  rcWake();
});
$('#rc').addEventListener('wheel',e=>{
  e.preventDefault();
  const dy=Math.abs(e.deltaY)>=Math.abs(e.deltaX)?e.deltaY:e.deltaX;
  if(RC.inspect){                                 // na lupa: a rodinha regula o nível do zoom
    RC.level=Math.max(1.2,Math.min(6,RC.level-dy*0.004));
    rcKick();
    return;
  }
  if(RC.phase==='scan'){                          // varrendo: a rodinha empurra a varredura à mão
    RC.sy=Math.max(RC.syEnd,Math.min(RC.syTop,RC.sy-dy*1.4));
    rcKick(); rcWake();
    return;
  }
  if(Math.abs(dy)<6)return;                       // parada a foto: a rodinha anda uma foto por vez
  const now=Date.now(); if(now<RC.wheelLock)return;
  RC.wheelLock=now+420;                           // trava: o trackpad dispara dezenas de eventos por gesto
  rcNav(dy>0?1:-1);
},{passive:false});
// laço de seleção: começa no vazio da grade (nos tiles, o pointerdown deles arrasta)
$('#content').addEventListener('pointerdown',e=>{
  if(e.button!==0||S.mode!=='sequence')return;
  // não iniciar o laço de seleção sobre tiles, a barra de ações, a paleta de stats ou qualquer controle
  if(e.target.closest('.tile')||e.target.closest('.cardBlock')||e.target.closest('.actionBar')||e.target.closest('.statsBar')||
     e.target.closest('button')||e.target.closest('select')||e.target.closest('input'))return;
  e.preventDefault();
  dndPend(e,'marquee');
});
document.querySelectorAll('#modeSeg button').forEach(b=>b.onclick=()=>{S.mode=b.dataset.mode;S.sel.clear();render();});
$('#zoom').oninput=e=>{S.thumb=+e.target.value;renderSequence();};
$('#statCancel').onclick=()=>$('#statModal').classList.remove('show');
$('#statSave').onclick=saveStatModal;
$('#statDelete').onclick=deleteStatDef;
$('#statName').addEventListener('keydown',e=>{e.stopPropagation();if(e.key==='Enter')saveStatModal();});
$('#statEmoji').addEventListener('keydown',e=>e.stopPropagation());
$('#textOverAdd').onclick=()=>addTextRow('over');
$('#textCardAdd').onclick=()=>addTextRow('card');
$('#textCardDel').onclick=()=>{ const im=S.images.find(x=>x.name===textEditName); if(im){ if(textEditMode==='cardBefore')im.cardBefore=[]; else im.cardAfter=[]; save(); } destroyVnEditors(); $('#textModal').classList.remove('show'); render(); };
$('#textDone').onclick=closeTextModal;
$('#vnSpeed').oninput=(e)=>{ setGlobalSpeed(+e.target.value); syncVnSpeed(); };
function currentTextIm(){ return S.images.find(x=>x.name===textEditName); }
$('#cenaFx').onchange=(e)=>{const im=currentTextIm(); if(im){im.scene=im.scene||{}; im.scene.fx=e.target.value; save();}};
$('#cenaMood').onchange=(e)=>{const im=currentTextIm(); if(im){im.scene=im.scene||{}; im.scene.mood=e.target.value; save();}};
$('#cenaHold').onchange=(e)=>{const im=currentTextIm(); if(im){im.scene=im.scene||{}; im.scene.hold=+e.target.value; save();}};
$('#vnPreview').onclick=previewSkip;                 // clicar na prévia: pula/fecha
$('#vnPreviewClose').onclick=(e)=>{e.stopPropagation();closePreview();};
$('#vnPvBar').onclick=(e)=>e.stopPropagation();      // a barra não conta como clique de "passar texto"
$('#vnPvUndef').onclick=(e)=>{e.stopPropagation();pvMove(UN);};
$('#vnPvMove').onchange=(e)=>{const d=e.target.value; if(d)pvMove(d); e.target.value='';};
document.querySelectorAll('.modal').forEach(m=>m.addEventListener('click',e=>{
  if(e.target!==m)return;
  $('#musAudio').pause();               // clicar fora não pode deixar a prévia tocando sozinha
  m.classList.remove('show');}));

/* ---------- boot ---------- */
(async()=>{
  if(!window.showDirectoryPicker){
    $('#content').innerHTML=`<div class="center"><h2>Navegador não suportado</h2><p>Esta ferramenta usa a File System Access API. Abra no <b>Chrome</b> ou <b>Edge</b>.</p></div>`;
    $('#btnOpen').disabled=true; return;
  }
  emptyOpen();
  S.outDir=(await idbGet('outdir'))||null; // permissão só é pedida na hora de exportar
  const h=await idbGet('dir');
  if(h){$('#btnReopen').style.display='';toast('Pasta anterior encontrada — clique “Reabrir última”.');}
})();
