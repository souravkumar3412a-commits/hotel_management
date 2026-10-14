// ============================================================
// Eazzio Login Page — decorative animations
// ============================================================
// Everything here is purely decorative and driven by SAMPLE data that is
// never real hotel data (the cards are labelled "Sample preview" and are
// aria-hidden in the markup so screen readers skip them):
//   1. count-up on the sample "Today's revenue" figure
//   2. count-up on the "100%" stat
//   3. a rotating sample "activity" feed
//   4. gentle mouse parallax on the floating cards / golden dust
//   5. the "Explore features" cue that scrolls to the Key Modules section
// Anyone who asks their OS for reduced motion gets the finished numbers
// immediately and none of the movement.
(function(){
  'use strict';

  var reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  function animateCount(el, to, prefix, suffix, duration){
    var start = null;
    function step(ts){
      if(!start) start = ts;
      var p = Math.min((ts - start) / duration, 1);
      var eased = 1 - Math.pow(1 - p, 3); // ease-out cubic
      el.textContent = prefix + Math.round(to * eased).toLocaleString('en-IN') + suffix;
      if(p < 1) window.requestAnimationFrame(step);
    }
    window.requestAnimationFrame(step);
  }

  // ---------- 1 + 2: count-ups ----------
  function initCounters(){
    var revenue = document.getElementById('gatePreviewRevenue');
    if(revenue){
      if(reduceMotion){
        revenue.textContent = '\u20B948,200';
      } else {
        // Starts a little after the card has finished floating in
        // (see .gbp-float-rev's animation-delay in styles.css).
        window.setTimeout(function(){ animateCount(revenue, 48200, '\u20B9', '', 1500); }, 2500);
      }
    }
    document.querySelectorAll('#gateBrandPanel [data-count-to]').forEach(function(el){
      var to = parseFloat(el.getAttribute('data-count-to'));
      var suffix = el.getAttribute('data-suffix') || '';
      if(isNaN(to)) return;
      if(reduceMotion){ el.textContent = to + suffix; return; }
      el.textContent = '0' + suffix;
      window.setTimeout(function(){ animateCount(el, to, '', suffix, 1400); }, 1600);
    });
  }

  // ---------- 3: rotating sample activity feed ----------
  var FEED = [
    { tone:'',      title:'New booking \u00B7 Room 204',   sub:'Check-in today \u00B7 2 nights',
      icon:'<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/>' },
    { tone:'amber', title:'Table 6 \u00B7 Bill generated', sub:'\u20B91,240 paid via UPI',
      icon:'<path d="M5 3v7a2 2 0 0 0 4 0V3"/><path d="M7 3v18"/><path d="M17.5 3C15.5 4.4 14.5 6.8 14.5 9.5c0 1.6 1 2.6 3 2.6V21"/>' },
    { tone:'blue',  title:'Banquet hall booked',           sub:'Saturday \u00B7 7:00 PM \u00B7 120 guests',
      icon:'<path d="M2 20h20"/><path d="M4.5 17a7.5 7.5 0 0 1 15 0Z"/><path d="M12 9.5V7"/>' },
    { tone:'pink',  title:'Occupancy up 6%',               sub:'82% of rooms occupied',
      icon:'<polyline points="3 17 9 11 13 15 21 7"/><polyline points="15 7 21 7 21 13"/>' }
  ];

  function renderFeedItem(el, item, animate){
    el.innerHTML =
      '<span class="gff-ico ' + item.tone + '"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + item.icon + '</svg></span>' +
      '<span class="gff-txt"><b>' + item.title + '</b><small>' + item.sub + '</small></span>';
    if(animate){
      el.classList.remove('swap');
      void el.offsetWidth; // restart the CSS animation
      el.classList.add('swap');
    }
  }

  function initFeed(){
    var el = document.getElementById('gateFeedItem');
    if(!el) return;
    var i = 0;
    renderFeedItem(el, FEED[0], false);
    if(reduceMotion) return;
    var timer = null;
    function tick(){
      i = (i + 1) % FEED.length;
      renderFeedItem(el, FEED[i], true);
    }
    function start(){ if(!timer) timer = window.setInterval(tick, 3600); }
    function stop(){ if(timer){ window.clearInterval(timer); timer = null; } }
    // Don't burn CPU in a background tab.
    document.addEventListener('visibilitychange', function(){ if(document.hidden) stop(); else start(); });
    window.setTimeout(start, 4200);
  }

  // ---------- 4: mouse parallax ----------
  function initParallax(){
    var panel = document.getElementById('gateBrandPanel');
    if(!panel || reduceMotion) return;
    if(window.matchMedia && window.matchMedia('(hover: none)').matches) return; // touch devices
    var raf = null, nx = 0, ny = 0;
    function apply(){
      raf = null;
      panel.style.setProperty('--mx', nx.toFixed(3));
      panel.style.setProperty('--my', ny.toFixed(3));
    }
    window.addEventListener('mousemove', function(e){
      nx = (e.clientX / window.innerWidth - 0.5) * 2;
      ny = (e.clientY / window.innerHeight - 0.5) * 2;
      if(!raf) raf = window.requestAnimationFrame(apply);
    }, { passive: true });
  }

  // ---------- 5: "Explore features" cue ----------
  function initScrollCue(){
    var cue = document.getElementById('gbpScrollCue');
    if(!cue) return;
    cue.addEventListener('click', function(){
      var modules = document.getElementById('modulesSection');
      if(modules) modules.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
    });
  }

  function init(){
    initCounters();
    initFeed();
    initParallax();
    initScrollCue();
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();