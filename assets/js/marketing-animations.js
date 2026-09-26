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
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Cursor-tracking spotlight glow on the Key Modules / Pricing cards — sets
  // --mx/--my to the pointer's position inside each card; styles.css turns
  // that into a soft radial highlight that only shows on hover. This is
  // directly tied to the user's own pointer movement (not autoplaying), so
  // it runs regardless of the reduced-motion setting below.
  document.querySelectorAll('.gi-module, .gi-plan-card').forEach(function(card){
    card.addEventListener('mousemove', function(e){
      var r = card.getBoundingClientRect();
      card.style.setProperty('--mx', (e.clientX - r.left) + 'px');
      card.style.setProperty('--my', (e.clientY - r.top) + 'px');
    });
  });

  if(!targets.length) return;
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