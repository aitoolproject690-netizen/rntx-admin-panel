(function(){
  const $id=id=>document.getElementById(id);
  const esc=value=>String(value??"").replace(/[&<>\"]/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[ch]));
  const escapeAttr=value=>String(value??"").replace(/\\/g,"\\\\").replace(/'/g,"\\'");
  const state={me:null,plans:[]};
  async function refreshState(){try{const d=await api("/api/me");if(d.user)state.me=d.user;}catch{}}
  function isReseller(){return state.me?.role==="reseller";}
  function maxDevices(){const n=isReseller()?Number(state.me.max_device_limit||2000):2000;return Number.isInteger(n)&&n>0?Math.min(2000,n):2000;}
  function selectedPlan(){const duration=$id("duration")?.value;return state.plans.find(p=>p.active&&p.duration===duration)||null;}
  function updateEstimation(){const input=$id("devices"),out=$id("licenseEstimation");if(!input||!out)return;if(!isReseller()){out.textContent="";return;}const devices=Number(input.value),max=maxDevices(),plan=selectedPlan();if(!Number.isInteger(devices)||devices<1||devices>max){out.textContent=`Enter a whole number from 1 to ${max} devices.`;return;}if(!plan){out.textContent="Select an active duration.";return;}const price=Number(plan.price)||0,total=price*devices;out.textContent=`Price: ₹${price.toLocaleString("en-IN")} / Device • Estimated deduction: ₹${total.toLocaleString("en-IN")}`;}
  function renderCreate(){const durations=[...new Set(state.plans.filter(x=>x.active).map(x=>x.duration))],oldDuration=$id("duration")?.value;$id("duration").innerHTML=durations.map(x=>{const p=state.plans.find(y=>y.active&&y.duration===x),label=isReseller()?`${esc(x)} — ₹${Number(p?.price||0).toLocaleString("en-IN")} / Device`:esc(x);return `<option value="${escapeAttr(x)}">${label}</option>`;}).join("");if(durations.includes(oldDuration))$id("duration").value=oldDuration;$id("devices").max=String(maxDevices());$id("duration").onchange=updateEstimation;$id("devices").oninput=updateEstimation;updateEstimation();}
  window.loadCreate=async function(){try{await refreshState();state.plans=await api("/api/plans");renderCreate();}catch(e){$id("copyMsg").textContent=e.message;}};
  window.renderCreateOptions=renderCreate;window.renderDeviceOptions=updateEstimation;
  window.createKey=async function(){try{await refreshState();state.plans=await api("/api/plans");const duration=$id("duration").value,devices=Number($id("devices").value),max=maxDevices(),plan=selectedPlan();if(!Number.isInteger(devices)||devices<1||devices>max){$id("copyMsg").textContent=`Device count must be a whole number between 1 and ${max}.`;return;}if(!plan){$id("copyMsg").textContent="Choose an active duration.";return;}const d=await api("/api/keys",{method:"POST",body:JSON.stringify({game:$id("game").value,duration,maxDevices:devices})}),keys=d.keys?.length?d.keys:[{key:d.key}];$id("newKey").classList.remove("hidden");$id("newKey").innerHTML=keys.map(item=>`<div class="copy-row"><code>${esc(item.key)}</code><button class="copy-button" onclick="copyKey('${escapeAttr(item.key)}',this)">COPY KEY</button></div>`).join("");$id("copyMsg").textContent="";toastCopyMessage(`License generated for ${devices} device${devices===1?"":"s"}.`);loadKeys();loadDash();}catch(e){$id("copyMsg").textContent=e.message;}};
  window.loadPricing=async function(){try{await refreshState();const rows=await api("/api/plans");state.plans=rows;$id("pricingBody").innerHTML=rows.map(t=>`<tr><td>${esc(t.duration)}</td><td>${state.me?.role==="admin"?`<input class="price-edit" id="plan-${t.id}" type="number" min="0" max="100000000" value="${t.price}">`:`₹${Number(t.price).toLocaleString("en-IN")}/Device`}</td>${state.me?.role==="admin"?`<td><button class="small" onclick="saveTier(${t.id})">SAVE</button></td>`:""}</tr>`).join("")||"<tr><td colspan=\"3\">No pricing plans found.</td></tr>";}catch(e){alert(e.message);}};
  window.saveTier=async function(id){try{await api("/api/plans/"+id,{method:"PATCH",body:JSON.stringify({price:Number($id("plan-"+id).value)})});await loadPricing();if(!$id("create").classList.contains("hidden"))await loadCreate();}catch(e){alert(e.message);}};
})();

// Reseller key controls: reseller can block/unblock only keys they own.
(function(){
  const escHtml=v=>String(v??"").replace(/[&<>\"]/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[ch]));
  window.loadKeys=async function(){
    try{
      const rows=await api("/api/keys?q="+encodeURIComponent(document.getElementById("search")?.value||""));
      document.getElementById("keysBody").innerHTML=rows.map(k=>{const blocked=k.status==="BLOCKED";const action=me?.role==="admin"?`<button class="small" onclick="toggleKey(${k.id},'${blocked?"UNUSED":"BLOCKED"}')">${blocked?"UNBLOCK":"BLOCK"}</button><button class="small danger" onclick="delKey(${k.id})">DELETE</button>`:me?.role==="reseller"?`<button class="small" onclick="toggleResellerKey(${k.id},'${blocked?"UNUSED":"BLOCKED"}')">${blocked?"UNBLOCK":"BLOCK"}</button>`:`<span class="muted-action">VIEW ONLY</span>`;return `<tr><td>${escHtml(k.license_key)}</td><td>${escHtml(k.game)}</td><td>${formatDate(k.expires_at)}</td><td><span class="pill">${escHtml(k.status)}</span></td><td>${k.devices_used}/${k.max_devices}</td><td>${action}</td></tr>`;}).join("")||"<tr><td colspan=\"6\">No generated keys yet.</td></tr>";
    }catch(e){document.getElementById("keysBody").innerHTML=`<tr><td colspan=\"6\">${escHtml(e.message)}</td></tr>`;}
  };
  window.toggleResellerKey=async function(id,status){if(me?.role!=="reseller")return;if(!confirm(`Confirm ${status==="BLOCKED"?"block":"unblock"} this license key?`))return;try{await api("/api/keys/"+id,{method:"PATCH",body:JSON.stringify({status})});await loadKeys();await loadDash();}catch(e){alert(e.message);}};
})();
