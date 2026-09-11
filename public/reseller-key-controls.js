(function(){
  function html(v){return String(v??"").replace(/[&<>\"]/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[ch]));}
  window.toggleResellerKey=async function(id,status){
    if(window.me?.role!=="reseller")return;
    if(!confirm(status==="BLOCKED"?"Confirm blocking this license key?":"Confirm unblocking this license key?"))return;
    try{
      await api("/api/keys/"+id,{method:"PATCH",body:JSON.stringify({status})});
      if(typeof loadKeys==="function")await loadKeys();
    }catch(e){alert(e.message||"Could not update license key");}
  };
  const originalLoadKeys=window.loadKeys;
  window.loadKeys=async function(){
    await originalLoadKeys();
    if(window.me?.role!=="reseller")return;
    const body=document.getElementById("keysBody");
    if(!body)return;
    body.querySelectorAll("tr").forEach(tr=>{
      const cells=tr.querySelectorAll("td");
      if(cells.length<6)return;
      const status=(cells[3]?.textContent||"").trim().toUpperCase();
      const keyId=cells[0]?.dataset?.keyId;
      if(!keyId)return;
      cells[5].innerHTML=`<button class="small" onclick="toggleResellerKey(${Number(keyId)},'${status==='BLOCKED'?'UNUSED':'BLOCKED'}')">${status==='BLOCKED'?'UNBLOCK':'BLOCK'}</button>`;
    });
  };
})();
