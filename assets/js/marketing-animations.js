// ============================================================
// Eazzio Marketing Page — scroll-reveal animations
// ============================================================
// Fades/slides each ".reveal" element in the Key Modules, Pricing, Support
// and final-CTA sections into view the first time it scrolls into the
// viewport. Purely decorative — no app data involved. Runs after app.js
// (see the <script> order in index.html) so the Key Modules / Pricing
// cards, which app.js injects into the page, already exist to observe.
(function(){
  'use strict';

  var targets = document.querySelectorAll('.reveal');
  if(!targets.length) return;

  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if(reduceMotion || !('IntersectionObserver' in window)){
    targets.forEach(function(el){ el.classList.add('in-view'); });
    return;
  }

  var io = new IntersectionObserver(function(entries){
    entries.forEach(function(entry){
      if(entry.isIntersecting){
        entry.target.classList.add('in-view');
        io.unobserve(entry.target);
      }
    });
  }, { threshold: 0.15, rootMargin: '0px 0px -60px 0px' });

  targets.forEach(function(el){ io.observe(el); });
})();