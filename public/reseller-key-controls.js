(function(){
  function h(v){return String(v??"").replace(/[&<>\"]/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[ch]));}
  window.toggleResellerKey=async function(id,status){
    if(window.me?.role!=="reseller")return;
    if(!confirm(status==="BLOCKED"?"Confirm blocking this license key?":"Confirm unblocking this license key?"))return;
    try{await api("/api/keys/"+id,{method:"PATCH",body:JSON.stringify({status})});await window.loadKeys();}
    catch(e){alert(e.message||"Could not update license key");}
  };
  window.loadKeys=async function(){
    try{
      const rows=await api("/api/keys?q="+encodeURIComponent(document.getElementById("search")?.value||""));
      document.getElementById("keysBody").innerHTML=rows.map(k=>{
        const blocked=k.status==="BLOCKED";
        const action=window.me?.role==="reseller"
          ? `<button class="small" onclick="toggleResellerKey(${Number(k.id)},'${blocked?"UNUSED":"BLOCKED"}')">${blocked?"UNBLOCK":"BLOCK"}</button>`
          : window.me?.role==="admin"
            ? `<button class="small" onclick="toggleKey(${Number(k.id)},'${blocked?"UNUSED":"BLOCKED"}')">${blocked?"UNBLOCK":"BLOCK"}</button><button class="small danger" onclick="delKey(${Number(k.id)})">DELETE</button>`
            : `<span class="muted-action">VIEW ONLY</span>`;
        return `<tr><td>${h(k.license_key)}</td><td>${h(k.game)}</td><td>${formatDate(k.expires_at)}</td><td><span class="pill">${h(k.status)}</span></td><td>${Number(k.devices_used||0)}/${Number(k.max_devices||0)}</td><td>${action}</td></tr>`;
      }).join("")||"<tr><td colspan=6>No generated keys yet.</td></tr>";
    }catch(e){document.getElementById("keysBody").innerHTML=`<tr><td colspan=6>${h(e.message)}</td></tr>`;}
  };
})();
