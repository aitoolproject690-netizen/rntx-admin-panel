(function(){
  const $id=id=>document.getElementById(id);

  function customMax(){
    const accountMax=window.me?.role==="reseller"?Number(window.me.max_device_limit||2000):2000;
    return Math.min(2000, Number.isInteger(accountMax)&&accountMax>0?accountMax:2000);
  }

  function renderDeviceOptionsCustom(preferred){
    const duration=$id("duration")?.value;
    if(!duration||!$id("devices"))return;
    const max=customMax();
    const options=(window.pricingTiers||[])
      .filter(x=>x.active&&x.duration===duration&&Number(x.device_limit)<=max)
      .sort((a,b)=>Number(a.device_limit)-Number(b.device_limit));

    $id("devices").innerHTML=options.map(x=>`<option value="${x.device_limit}">${x.device_limit} device${Number(x.device_limit)===1?"":"s"} — ₹${Number(x.price).toLocaleString("en-IN")}</option>`).join("")+
      `<option value="__CUSTOM__">Custom Devices</option>`;

    if(preferred!==undefined&&preferred!==null&&String(preferred)!==""&&options.some(x=>String(x.device_limit)===String(preferred))){
      $id("devices").value=String(preferred);
    }else if(String(preferred)==="__CUSTOM__"){
      $id("devices").value="__CUSTOM__";
    }
    syncCustomDeviceUI();
  }

  function syncCustomDeviceUI(){
    const select=$id("devices"), wrap=$id("customDevicesWrap"), input=$id("customDevices");
    if(!select||!wrap||!input)return;
    const custom=select.value==="__CUSTOM__";
    wrap.classList.toggle("hidden",!custom);
    input.max=String(customMax());
    input.oninput=updateCustomDevicePrice;
    updateCustomDevicePrice();
  }

  function updateCustomDevicePrice(){
    const select=$id("devices"), input=$id("customDevices"), msg=$id("customDevicePrice");
    if(!select||!input||!msg||select.value!=="__CUSTOM__")return;
    const count=Number(input.value);
    const max=customMax();
    if(!Number.isInteger(count)||count<1||count>max){
      msg.textContent=`Enter a whole number from 1 to ${max} devices.`;
      return;
    }
    const duration=$id("duration")?.value;
    const tier=(window.pricingTiers||[]).find(x=>x.active&&x.duration===duration&&Number(x.device_limit)===count);
    if(window.me?.role==="reseller"){
      msg.textContent=tier?`Configured reseller price: ₹${Number(tier.price).toLocaleString("en-IN")}`:`No price configured for ${count} devices. Admin must add this custom price in Pricing.`;
    }else{
      msg.textContent=`Custom device count: ${count}. Admin license generation does not deduct reseller wallet balance.`;
    }
  }

  window.renderCreateOptions=function(){
    const durations=[...new Set((window.pricingTiers||[]).filter(x=>x.active).map(x=>x.duration))];
    const oldDuration=$id("duration")?.value;
    const oldDevices=$id("devices")?.value;
    $id("duration").innerHTML=durations.map(x=>`<option>${esc(x)}</option>`).join("");
    if(durations.includes(oldDuration))$id("duration").value=oldDuration;
    $id("duration").onchange=function(){renderDeviceOptionsCustom();};
    renderDeviceOptionsCustom(oldDevices);
  };

  window.renderDeviceOptions=renderDeviceOptionsCustom;

  window.createKey=async function(){
    try{
      const duration=$id("duration").value;
      const custom=$id("devices").value==="__CUSTOM__";
      const devices=custom?Number($id("customDevices").value):Number($id("devices").value);
      const max=customMax();
      if(!Number.isInteger(devices)||devices<1||devices>max){
        $id("copyMsg").textContent=`Device count must be a whole number between 1 and ${max}.`;
        return;
      }
      if(custom&&window.me?.role==="reseller"){
        const tier=(window.pricingTiers||[]).find(x=>x.active&&x.duration===duration&&Number(x.device_limit)===devices);
        if(!tier){
          $id("copyMsg").textContent=`No price is configured for ${devices} devices for ${duration}. Ask admin to add this custom price in Pricing.`;
          return;
        }
      }

      const body={game:$id("game").value,duration,maxDevices:devices};
      if(custom)body.customDevices=devices;
      const d=await api("/api/keys",{method:"POST",body:JSON.stringify(body)});
      const keys=d.keys?.length?d.keys:[{key:d.key}];
      $id("newKey").classList.remove("hidden");
      $id("newKey").innerHTML=keys.map(item=>`<div class="copy-row"><code>${esc(item.key)}</code><button class="copy-button" onclick="copyKey('${escapeAttr(item.key)}',this)">COPY KEY</button></div>`).join("");
      $id("copyMsg").textContent=custom?`License generated for ${devices} devices.`:"";
      toastCopyMessage("License generated successfully.");
      loadKeys();loadDash();
    }catch(e){$id("copyMsg").textContent=e.message}
  };

  window.loadPricing=async function(){
    try{
      const rows=await api("/api/pricing-tiers");
      window.pricingTiers=rows;
      $id("pricingBody").innerHTML=rows.map(t=>`<tr><td>${esc(t.duration)}</td><td>${t.device_limit}</td><td>${window.me.role==="admin"?`<input class="price-edit" id="tier-${t.id}" type="number" min="0" value="${t.price}">`:`₹${Number(t.price).toLocaleString("en-IN")}`}</td>${window.me.role==="admin"?`<td><button class="small" onclick="saveTier(${t.id})">SAVE</button></td>`:""}</tr>`).join("");
      if(window.me.role==="admin"){
        const durations=[...new Set(rows.filter(x=>x.active).map(x=>x.duration))];
        const select=$id("customTierDuration");
        const old=select.value;
        select.innerHTML=durations.map(x=>`<option>${esc(x)}</option>`).join("");
        if(durations.includes(old))select.value=old;
      }
    }catch(e){alert(e.message)}
  };

  window.saveCustomTier=async function(){
    const msg=$id("customTierMsg");
    try{
      const duration=$id("customTierDuration").value;
      const deviceLimit=Number($id("customTierDevices").value);
      const price=Number($id("customTierPrice").value);
      if(!Number.isInteger(deviceLimit)||deviceLimit<1||deviceLimit>2000)throw Error("Custom device count must be a whole number between 1 and 2000");
      if(!Number.isInteger(price)||price<0||price>100000000)throw Error("Price must be a whole number between ₹0 and ₹100,000,000");
      await api("/api/pricing-tiers/custom",{method:"POST",body:JSON.stringify({duration,deviceLimit,price})});
      msg.textContent=`Custom price saved: ${duration} / ${deviceLimit} devices = ₹${price.toLocaleString("en-IN")}`;
      await loadPricing();
      if(!$id("create").classList.contains("hidden"))await loadCreate();
    }catch(e){msg.textContent=e.message}
  };

  const originalApplyRoleUI=window.applyRoleUI;
  window.applyRoleUI=function(){
    if(originalApplyRoleUI)originalApplyRoleUI();
    const card=$id("customTierCard");
    if(card)card.classList.toggle("hidden",window.me?.role!=="admin");
  };

  const originalLoadCreate=window.loadCreate;
  window.loadCreate=async function(){
    try{
      window.pricingTiers=await api("/api/pricing-tiers");
      renderCreateOptionsCustom();
    }catch(e){$id("copyMsg").textContent=e.message}
  };
})();
