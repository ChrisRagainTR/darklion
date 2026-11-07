(function(){
  'use strict';
  window.DarkLionFirm={name:'Your firm',appName:'DarkLion',appStoreUrl:''};
  window.loadPortalFirm=async function(token){
    // Signed in by the portal session cookie; a Bearer header only when the page holds a token.
    const headers=token?{Authorization:'Bearer '+token}:(window.PortalSession?window.PortalSession.headers():{});
    const response=await fetch('/portal/preferences',{headers});
    if(!response.ok)return;
    const p=await response.json();window.DarkLionFirm=p;document.title=p.name+' · Client Portal';
    document.documentElement.style.setProperty('--gold',p.primaryColor);
    if(p.portalIconUrl){
      for(const link of document.querySelectorAll('link[rel="icon"],link[rel="apple-touch-icon"]')){link.href=p.portalIconUrl;link.removeAttribute('type');}
      for(const image of document.querySelectorAll('.side-brand img:not(.side-wordmark),.client-portal-screen-gate-logo')){image.src=p.portalIconUrl;image.alt=p.name;image.hidden=false;}
    }
    if(p.appName==='DarkLion'){
      for(const image of document.querySelectorAll(p.portalIconUrl ? '.side-wordmark' : '.side-wordmark,.client-portal-screen-gate-logo')){
        const label=document.createElement('span');label.textContent=p.name;label.style.cssText='font-size:20px;color:var(--gold);font-weight:700;';image.replaceWith(label);
      }
      for(const image of document.querySelectorAll('.side-brand img'))image.hidden=!p.portalIconUrl;
    }
    for(const link of document.querySelectorAll('.client-portal-app-store-badge-link')){
      link.hidden=!p.appStoreUrl;if(p.appStoreUrl){link.href=p.appStoreUrl;link.setAttribute('aria-label','Download '+p.appName);}
    }
    window.dispatchEvent(new Event('firm-branding-ready'));
  };
})();
