(function(){
  'use strict';
  function scaleReference(){
    var app=document.getElementById('app');
    if(!app || !app.classList.contains('rntx-premium')) return;
    var scale=Math.min(1, window.innerWidth / 1536);
    app.style.setProperty('--rntx-reference-scale', String(scale));
    app.style.minHeight=(1024*scale)+'px';
  }
  function run(){scaleReference(); setTimeout(scaleReference,100); setTimeout(scaleReference,500);}
  window.addEventListener('resize',scaleReference,{passive:true});
  window.addEventListener('orientationchange',function(){setTimeout(scaleReference,80);},{passive:true});
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',run,{once:true}); else run();
})();
