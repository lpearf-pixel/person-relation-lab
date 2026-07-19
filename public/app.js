const roots = document.querySelector('#roots');
const files = document.querySelector('#files');
const result = document.querySelector('#result');
const labels = {possible_partner_association:'疑似伴侣关联（待人工核验）',household_association:'家庭关联',organization_association:'单位关联',generic_association:'一般关联'};
async function refresh(){
  roots.textContent='扫描中…'; files.innerHTML='';
  try { const data=await fetch('/api/v1/imports/status').then(r=>r.json()); roots.innerHTML=data.roots.length?data.roots.map(x=>`<code>${escapeHtml(x)}</code>`).join(''):'<p>尚未配置目录，请修改 .env 中的 IMPORT_DIR。</p>'; files.innerHTML=data.files.map(f=>`<div class="file"><span>${escapeHtml(f.path)}</span><small>${(f.size/1048576).toFixed(1)} MB · ${escapeHtml(f.state)}</small></div>`).join(''); }
  catch { roots.textContent='无法读取目录状态'; }
}
document.querySelector('#refresh').addEventListener('click',refresh);
document.querySelector('#query').addEventListener('submit',async event=>{ event.preventDefault(); const form=new FormData(event.target); const response=await fetch('/api/v1/relations/query',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({personA:form.get('personA'),personB:form.get('personB')})}); const data=await response.json(); result.hidden=false; if(!response.ok){result.innerHTML=`<p>${data.error==='relationship_not_found'?'未找到关系证据':'请求无效'}</p>`;return;} result.innerHTML=`<h3>${escapeHtml(labels[data.relationType]||data.relationType)}</h3><p>置信度 ${(data.confidence*100).toFixed(0)}% · 资料完整度 ${(data.completeness*100).toFixed(0)}%</p><ul>${data.evidence.map(x=>`<li>${escapeHtml(x)}</li>`).join('')}</ul><p class="warning">${escapeHtml(data.disclaimer)}</p>`; });
function escapeHtml(value){return String(value).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
refresh();
