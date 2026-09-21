// ============================================================
// Eazzio Voice Commands — Phase 1 (navigation + read-only search)
// ============================================================
// Architecture: Speech Recognition -> transcript -> local rule-based parser
// -> intent -> window.EazzioApp.switchTab()/search() (the SAME functions
// the sidebar and search box use) -> confirmation UI.
//
// No data-changing commands in this phase (no checkout/cancel/create) —
// those need a confirmation-modal design pass of their own and are a
// deliberate follow-up, not an oversight.
//
// No external API, no server round-trip for understanding a command —
// everything here runs in the browser for free. Only requires the
// browser's built-in SpeechRecognition (Chrome desktop/Android; not
// available on iOS Safari or older browsers — handled gracefully below).
(function(){
  'use strict';

  var SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;

  // ---------- command registry ----------
  // Each command: a regex (matched against the lowercased transcript) and
  // a handler. Order matters — more specific patterns are listed first so
  // they win over generic ones (e.g. "show room 204" before "show rooms").
  var COMMANDS = [
    // Dashboard
    { intent:'GET_DASHBOARD', pattern:/\b(open|show|go to)\s+dashboard\b|today'?s?\s+summary|hotel performance/, run: function(){
        EazzioApp.switchTab('dashboard');
        return 'Opening dashboard.';
      } },
    { intent:'GET_TODAY_REVENUE', pattern:/(today'?s?\s+revenue|how much (money|revenue) did we make|today'?s?\s+(income|earnings))/, run: function(){
        EazzioApp.switchTab('dashboard');
        return 'Opening today\'s revenue on the dashboard.';
      } },
    { intent:'GET_OCCUPANCY', pattern:/(today'?s?\s+occupancy|occupancy\s+(rate|today)|how many rooms are occupied|\boccupancy\b)/, run: function(){
        EazzioApp.switchTab('dashboard');
        return 'Opening today\'s occupancy on the dashboard.';
      } },

    // Rooms — specific room number first
    { intent:'FIND_ROOM', pattern:/(?:show|find|open)\s+room\s*(\d+)/, run: function(m){
        return searchAndGo(m[1], 'room ' + m[1]);
      } },
    { intent:'GET_AVAILABLE_ROOMS', pattern:/available rooms/, run: function(){
        EazzioApp.switchTab('room-availability');
        return 'Opening available rooms.';
      } },
    { intent:'GET_OCCUPIED_ROOMS', pattern:/occupied rooms|unavailable rooms/, run: function(){
        EazzioApp.switchTab('room-availability');
        return 'Opening room availability.';
      } },
    { intent:'OPEN_ROOMS', pattern:/\b(open|show)\s+rooms?\b/, run: function(){
        EazzioApp.switchTab('room-availability');
        return 'Opening Room Management.';
      } },

    // Bookings
    { intent:'FIND_BOOKING', pattern:/(?:find|show)\s+booking\s*(?:number|#)?\s*(\S+)/, run: function(m){
        return searchAndGo(m[1], 'booking ' + m[1]);
      } },
    { intent:'GET_TODAY_BOOKINGS', pattern:/today'?s?\s+bookings|today'?s?\s+check-?ins?/, run: function(){
        EazzioApp.switchTab('room-availability');
        return 'Opening today\'s bookings.';
      } },
    { intent:'GET_TODAY_CHECKOUTS', pattern:/today'?s?\s+check-?outs?/, run: function(){
        EazzioApp.switchTab('room-availability');
        return 'Opening today\'s check-outs.';
      } },
    { intent:'GET_CANCELLED_BOOKINGS', pattern:/cancelled bookings/, run: function(){
        EazzioApp.switchTab('room-history');
        return 'Opening booking history.';
      } },

    // Payments / invoices
    { intent:'FIND_INVOICE', pattern:/(?:find|show)\s+invoice\s*(\S+)/, run: function(m){
        return searchAndGo(m[1], 'invoice ' + m[1]);
      } },
    { intent:'GET_PENDING_PAYMENTS', pattern:/pending payments|unpaid invoices|haven'?t paid/, run: function(){
        EazzioApp.switchTab('room-availability');
        return 'Opening room availability — pending balances are flagged there and in your notifications.';
      } },
    { intent:'GET_RECENT_PAYMENTS', pattern:/recent (transactions|payments)|today'?s?\s+payments/, run: function(){
        EazzioApp.switchTab('history');
        return 'Opening invoice history.';
      } },

    // Restaurant
    { intent:'GET_TOP_FOOD', pattern:/top selling (food|items)|best selling (food|items)/, run: function(){
        EazzioApp.switchTab('analysis');
        return 'Opening sales analysis for top selling items.';
      } },
    { intent:'GET_RESTAURANT_SALES', pattern:/restaurant sales|restaurant revenue|today'?s?\s+orders/, run: function(){
        EazzioApp.switchTab('analysis');
        return 'Opening restaurant sales analysis.';
      } },
    { intent:'OPEN_RESTAURANT', pattern:/\bopen\s+restaurant\b/, run: function(){
        EazzioApp.switchTab('table-setup');
        return 'Opening Restaurant Management.';
      } },

    // Banquet
    { intent:'GET_BANQUET_EVENTS', pattern:/(today'?s?\s+events|upcoming events|banquet bookings)/, run: function(){
        EazzioApp.switchTab('banquet-availability');
        return 'Opening banquet events.';
      } },
    { intent:'OPEN_BANQUET', pattern:/\bopen\s+banquet\b/, run: function(){
        EazzioApp.switchTab('banquet-availability');
        return 'Opening Banquet Management.';
      } },

    // Customers / staff — search by name
    { intent:'SEARCH_CUSTOMER', pattern:/(?:find|show|search)(?:\s+for)?\s+([a-z][a-z\s]{2,30})$/, run: function(m){
        var name = m[1].trim();
        return searchAndGo(name, name);
      } },

    // Reports
    { intent:'OPEN_REPORTS', pattern:/open (revenue|occupancy|restaurant|banquet)?\s*report|monthly revenue/, run: function(){
        EazzioApp.switchTab('analysis');
        return 'Opening reports.';
      } },

    // Staff / setup
    { intent:'OPEN_STAFF', pattern:/\b(open|show)\s+staff\b/, run: function(){
        EazzioApp.switchTab('staff');
        return 'Opening Staff Management.';
      } },
    { intent:'OPEN_SETUP', pattern:/\b(open|show)\s+setup\b|hotel (details|settings)/, run: function(){
        EazzioApp.switchTab('setup');
        return 'Opening hotel setup.';
      } },
    { intent:'OPEN_AI', pattern:/\b(open|show)\s+ai\b|ai assistant/, run: function(){
        EazzioApp.switchTab('ai-assistant');
        return 'Opening the AI Assistant.';
      } }
  ];

  // Runs a search and either navigates straight there (single match) or
  // opens the search UI pre-filled (multiple or zero matches) so the admin
  // can pick — this is the "ask to clarify instead of guessing" behavior
  // the spec calls for, reusing the existing search overlay rather than
  // building a separate disambiguation UI.
  function searchAndGo(query, spokenLabel){
    var results = EazzioApp.search(query);
    if(results.length === 1){
      results[0].go();
      return 'Opening ' + results[0].label + '.';
    }
    EazzioApp.openSearchUI(query);
    if(results.length === 0) return 'I couldn\'t find "' + spokenLabel + '" — showing search so you can check spelling.';
    return 'Found a few matches for "' + spokenLabel + '" — showing them so you can pick.';
  }

  function matchCommand(transcript){
    var lower = transcript.toLowerCase().trim().replace(/[.!?]+$/, '');
    for(var i = 0; i < COMMANDS.length; i++){
      var m = lower.match(COMMANDS[i].pattern);
      if(m) return { command: COMMANDS[i], match: m };
    }
    return null;
  }

  function handleTranscript(transcript){
    setStatus('processing', 'Heard: "' + transcript + '" — understanding…');
    var found = matchCommand(transcript);
    if(!found){
      setStatus('error', 'Heard: "' + transcript + '" — didn\'t recognize that command. Try "show today\'s revenue" or "find [name]".');
      window.setTimeout(clearStatus, 5000);
      return;
    }
    var resultText;
    try {
      resultText = found.command.run(found.match);
    } catch(e){
      resultText = 'Something went wrong running that command.';
    }
    setStatus('success', resultText || 'Done.');
    window.setTimeout(clearStatus, 2600);
  }

  // ---------- UI state (mic button + status pill) ----------
  var micBtn, pill;
  function setStatus(kind, text){
    if(!pill) return;
    pill.className = 'voice-status-pill ' + kind;
    pill.textContent = text;
    pill.style.display = '';
  }
  function clearStatus(){
    if(!pill) return;
    pill.style.display = 'none';
  }

  function initVoiceUI(){
    micBtn = document.getElementById('voiceMicBtn');
    pill = document.getElementById('voiceStatusPill');
    if(!micBtn) return;

    if(!SpeechRecognitionCtor){
      // Graceful degradation: keep the button visible (matches the spec's
      // request for a visible fallback) but clicking it explains the
      // limitation instead of silently doing nothing.
      micBtn.addEventListener('click', function(){
        window.EazzioApp.showToast('Voice commands aren\'t supported in this browser. Please use Chrome, or type your search instead.', 'error');
      });
      return;
    }

    var recognition = new SpeechRecognitionCtor();
    recognition.lang = 'en-IN';
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    var listening = false;

    recognition.onstart = function(){
      listening = true;
      micBtn.classList.add('listening');
      setStatus('listening', 'Listening…');
    };
    recognition.onresult = function(e){
      var transcript = e.results[0][0].transcript;
      handleTranscript(transcript);
    };
    recognition.onerror = function(e){
      listening = false;
      micBtn.classList.remove('listening');
      if(e.error === 'not-allowed' || e.error === 'permission-denied'){
        setStatus('error', 'Microphone access is required. Please enable it in your browser settings.');
      } else if(e.error === 'no-speech'){
        setStatus('error', 'No command detected. Please try again.');
      } else {
        setStatus('error', 'Voice recognition had a problem. Please try again.');
      }
      window.setTimeout(clearStatus, 3200);
    };
    recognition.onend = function(){
      listening = false;
      micBtn.classList.remove('listening');
    };

    micBtn.addEventListener('click', function(){
      if(!window.EazzioApp.isVoiceEnabled()){
        window.EazzioApp.showToast('Voice commands are a Premium feature. Upgrade your plan to unlock them.', 'error');
        return;
      }
      if(listening){ recognition.stop(); return; }
      try { recognition.start(); }
      catch(e){ /* already-started guard — harmless if double-clicked fast */ }
    });
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', initVoiceUI);
  } else {
    initVoiceUI();
  }
})();