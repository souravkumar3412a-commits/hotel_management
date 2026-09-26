// ============================================================
// Eazzio Login Page — decorative animations
// ============================================================
// Animates the little "Live" revenue counter on the login screen's brand
// panel. This is purely decorative sample data to give a first-time visitor
// an immediate feel for the product — it is never real hotel data and is
// marked aria-hidden in the markup so screen readers skip it.
(function(){
  'use strict';

  function animateCount(el, to, prefix, duration){
    var start = null;
    function step(ts){
      if(!start) start = ts;
      var p = Math.min((ts - start) / duration, 1);
      var eased = 1 - Math.pow(1 - p, 3); // ease-out cubic
      el.textContent = prefix + Math.round(to * eased).toLocaleString('en-IN');
      if(p < 1) window.requestAnimationFrame(step);
    }
    window.requestAnimationFrame(step);
  }

  function init(){
    var el = document.getElementById('gatePreviewRevenue');
    if(!el) return;
    // Respect reduced-motion: just show the final number, no count-up.
    if(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches){
      el.textContent = '₹48,200';
      return;
    }
    // Starts a little after the card itself has finished animating in
    // (see .gbp-preview-card's animation-delay in styles.css).
    window.setTimeout(function(){ animateCount(el, 48200, '₹', 1400); }, 950);
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();