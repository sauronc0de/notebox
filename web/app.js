const $ = id => document.getElementById(id);
const state = { view: 'daily', day: new Date(), editing: null, refresh: 0, groups: [], groupEditing: null, selectNewGroup: false };
const localDate = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const prettyDate = d => d.toLocaleDateString('ca-ES', { day:'numeric', month:'long', year:'numeric' });
const request = async (path, options) => {
  const response = await fetch(path, options);
  if (!response.ok) { const data = await response.json().catch(() => ({})); throw Error(data.error || `HTTP ${response.status}`); }
  return response.status === 204 ? null : response.json();
};
const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
const icons = new Set(['folder','briefcase','home','cpu','star','book','lightbulb','gaming','football','barbell','food','gift','cat']);
function iconSvg(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg','use');
  use.setAttribute('href','#'+(icons.has(name) ? name : 'folder'));
  svg.append(use); return svg;
}
function card(note) {
  const item = el('button','card'); item.type = 'button'; item.addEventListener('click', () => openEditor(note));
  const head = el('div','card-top');
  if (note.group_icon) head.append(iconSvg(note.group_icon));
  head.append(el('strong','',note.title)); if (note.pinned) head.append(el('span','pin','✦ Fixada')); item.append(head);
  if (note.description) item.append(el('span','desc',note.description));
  const meta = el('div','meta'); if (note.group_name) meta.append(el('span','pill group-pill',note.group_name));
  if (note.date) meta.append(el('span','pill',note.date));
  note.tags.forEach(tag => meta.append(el('span','pill','#'+tag)));
  if (meta.childNodes.length) item.append(meta);
  return item;
}
function draw(id, notes, empty) { const box=$(id); box.replaceChildren(...(notes.length ? notes.map(card) : [el('p','empty',empty)])); }
async function refresh() {
  const token = ++state.refresh;
  try {
    if (state.view === 'daily') {
      const day = localDate(state.day);
      $('day-label').textContent = prettyDate(state.day); $('date-heading').textContent = prettyDate(state.day);
      const [pinned,dated] = await Promise.all([request('/api/notes?pinned=true'),request('/api/notes?date='+day)]);
      if (token !== state.refresh) return;
      draw('pinned-list', pinned, 'Cap nota fixada');
      draw('daily-list', dated.filter(note => !note.pinned), 'Encara no hi ha notes per a aquest dia.');
    } else {
      const query = new URLSearchParams();
      for (const [id,key] of [['search','search'],['tag-filter','tag'],['group-filter','group'],['date-filter','date'],['has-date','has_date'],['sort','sort']]) {
        if ($(id).value.trim()) query.set(key,$(id).value.trim());
      }
      if ($('pinned-filter').checked) query.set('pinned','true');
      const notes = await request('/api/notes?'+query);
      if (token !== state.refresh) return;
      draw('all-list', notes, 'No s’han trobat notes.');
    }
  } catch (err) { if (token === state.refresh) { if (state.view === 'daily') draw('pinned-list', [], ''); draw(state.view === 'daily' ? 'daily-list' : 'all-list',[],`Error: ${err.message}`); } }
}
function selectView(view) {
  state.view = view;
  $('daily-view').hidden = view !== 'daily'; $('all-view').hidden = view !== 'all';
  $('page-title').textContent = view === 'daily' ? 'DAILY' : 'ALL NOTES';
  document.querySelectorAll('.nav').forEach(button => button.classList.toggle('active',button.dataset.view === view));
  refresh();
}
async function metadata() {
  try {
    const [tags,groups] = await Promise.all([request('/api/tags'),request('/api/groups')]);
    state.groups = groups;
    renderGroups();
    const selected = $('note-group').value;
    const tagFilter = $('tag-filter').value;
    const groupFilter = $('group-filter').value;
    $('tag-filter').replaceChildren(new Option('Tots els tags',''),...tags.map(t=>new Option('#'+t.name,t.name)));
    $('tag-suggestions').replaceChildren(...tags.map(t=>{ const o=document.createElement('option'); o.value=t.name; return o; }));
    $('group-filter').replaceChildren(new Option('Tots els grups',''),...groups.map(g=>new Option(g.name,g.name)));
    $('note-group').replaceChildren(new Option('Sense grup',''),...groups.map(g=>new Option(g.name,g.id)),new Option('＋ Crea un grup…','new'));
    $('note-group').value=selected;
    $('tag-filter').value=tagFilter;
    $('group-filter').value=groupFilter;
  } catch(err) { console.error(err); }
}
function openEditor(note=null) {
  state.editing = note;
  $('note-form').reset(); $('form-error').textContent='';
  $('editor-title').textContent = note ? 'Edita la nota' : 'Nova nota'; $('delete').hidden = !note;
  $('title').value = note?.title || ''; $('description').value=note?.description || '';
  // Creating a note never assigns a date implicitly; null remains null when editing.
  $('note-date').value = note?.date ?? '';
  $('note-group').value = note?.group_id ?? '';
  $('note-tags').value = note?.tags.join(', ') || ''; $('note-pinned').checked = !!note?.pinned;
  $('editor').showModal(); $('title').focus();
}
$('new').onclick=()=>openEditor();
$('quick-new').onclick=()=>openEditor();
$('set-day').onclick=()=>{ $('note-date').value = localDate(state.day); };
$('clear-date').onclick=()=>{ $('note-date').value = ''; };
function changeDay(offset) {
  const day = new Date(state.day);
  day.setDate(day.getDate()+offset);
  state.day = day;
  refresh();
}
// A horizontal touch gesture on Daily navigates; vertical scrolling remains native.
let swipe = null;
$('daily-view').addEventListener('touchstart', e => {
  if (e.touches.length !== 1 || $('editor').open || $('group-dialog').open) return;
  const t=e.touches[0]; swipe={x:t.clientX,y:t.clientY,time:Date.now()};
}, {passive:true});
$('daily-view').addEventListener('touchcancel',()=>{swipe=null;});
$('daily-view').addEventListener('touchend',e => {
  if (!swipe || e.changedTouches.length !== 1) return;
  const t=e.changedTouches[0], dx=t.clientX-swipe.x, dy=t.clientY-swipe.y;
  if (Math.abs(dx)>65 && Math.abs(dx)>Math.abs(dy)*1.4 && Date.now()-swipe.time<900) {
    changeDay(dx<0 ? 1 : -1);
    // Prevent a tap/click on a note card after swiping it.
    swipe.time=Date.now(); swipe.moved=true;
  } else swipe=null;
}, {passive:true});
$('daily-view').addEventListener('click',e=>{
  if (swipe?.moved && Date.now()-swipe.time<500) { e.preventDefault(); e.stopPropagation(); swipe=null; }
},true);
$('close').onclick=()=>$('editor').close();
$('prev').onclick=()=>changeDay(-1);
$('next').onclick=()=>changeDay(1);
$('today').onclick=()=>{state.day=new Date();refresh();};
document.querySelectorAll('.nav').forEach(button=>button.onclick=()=>selectView(button.dataset.view));
function renderGroups() {
  $('group-list').replaceChildren(...state.groups.map(group => {
    const button=el('button','group-row'); button.type='button';
    button.append(iconSvg(group.icon),el('span','',group.name),el('span','', 'Edita →'));
    button.onclick=()=>{
      state.groupEditing=group.id;
      $('group-form-title').textContent='Edita el grup';
      $('save-group').textContent='Desa els canvis';
      $('cancel-group').hidden=false;
      $('group-name').value=group.name; $('group-icon').value=group.icon;
      updateIconPreview(); $('group-name').focus();
    };
    return button;
  }));
  if (!state.groups.length) $('group-list').append(el('p','empty','Encara no hi ha grups.'));
}
function updateIconPreview() { $('icon-preview').replaceChildren(iconSvg($('group-icon').value)); }
$('group-icon').addEventListener('change',updateIconPreview);
function resetGroupForm() {
  state.groupEditing=null;
  $('group-form').reset(); updateIconPreview(); $('group-error').textContent='';
  $('group-form-title').textContent='Crea un grup';
  $('save-group').textContent='Crea el grup'; $('cancel-group').hidden=true;
}
function openGroups(selectNew=false) {
  state.selectNewGroup=selectNew;
  resetGroupForm(); renderGroups();
  $('group-dialog').showModal();
}
$('manage-groups').onclick=()=>openGroups();
$('edit-groups').onclick=()=>openGroups();
$('note-group').onchange=()=>{ if ($('note-group').value === 'new') { $('note-group').value=''; openGroups(true); } };
$('cancel-group').onclick=resetGroupForm;
$('close-group').onclick=()=>$('group-dialog').close();
$('group-form').onsubmit=async event=>{
  event.preventDefault();
  try {
    const wasEditing=state.groupEditing;
    const group=await request(wasEditing ? `/api/groups/${wasEditing}` : '/api/groups', {
      method:wasEditing ? 'PUT' : 'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({name:$('group-name').value.trim(),icon:$('group-icon').value})
    });
    await metadata(); resetGroupForm();
    if (!wasEditing && state.selectNewGroup) { $('note-group').value=group.id; $('group-dialog').close(); }
    refresh();
  } catch(err) { $('group-error').textContent=err.message; }
};
$('note-form').onsubmit=async event=>{
  event.preventDefault();
  const note={title:$('title').value.trim(),description:$('description').value,date:$('note-date').value || null,
    group_id:$('note-group').value ? Number($('note-group').value) : null,pinned:$('note-pinned').checked,
    tags:[...new Set($('note-tags').value.split(',').map(x=>x.trim()).filter(Boolean))]};
  try { await request(state.editing ? `/api/notes/${state.editing.id}` : '/api/notes',
    {method:state.editing ? 'PUT':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(note)});
    $('editor').close(); await metadata(); refresh();
  } catch(err) { $('form-error').textContent=err.message; }
};
$('delete').onclick=async()=>{ if (!state.editing || !confirm('Vols eliminar aquesta nota?')) return;
  try { await request(`/api/notes/${state.editing.id}`,{method:'DELETE'}); $('editor').close(); await metadata(); refresh(); }
  catch(err) { $('form-error').textContent=err.message; }
};
let timer; for (const id of ['search','tag-filter','group-filter','date-filter','has-date','pinned-filter','sort']) {
  $(id).addEventListener(id==='search'?'input':'change',()=>{clearTimeout(timer);timer=setTimeout(refresh,id==='search'?180:0);});
}
metadata(); selectView('daily');
