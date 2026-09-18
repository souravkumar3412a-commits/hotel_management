(function(){
  "use strict";

  var DEFAULT_RESTAURANT = {
    name:"", phone:"", email:"", address:"", gstin:"", logo:"", stamp:"", signature:"", taxRate:5, currency:"₹",
    invoicePrefix:"INV", footer:"Thank you for choosing us! We hope to host you again."
  };

  var state = {
    restaurant: Object.assign({}, DEFAULT_RESTAURANT),
    menu: [],
    deletedMenu: [],
    invoices: [],
    promoCodes: [],
    activeInvoice: null,
    invoiceSeq: 0,
    admins: [],         // [{ id, email, salt, hash, createdAt }]
    staff: [],          // [{ id, staffId, name, department, salt, hash, createdAt }]
    session: null,       // { role:'admin', adminId, email } or { role:'staff', staffId, name }
    // ---- table-based billing ----
    tableCount: 4,      // set by Admin in Setup; Staff sees exactly this many tables
    tables: {},          // { '1': { status, customerName, customerPhone, items, appliedPromo, paymentMethod }, ... } — each table has its own independent bill
    currentTableId: null, // which table Staff currently has open
    // ---- room management: Admin configures inventory (Setup); Staff books rooms ----
    roomFloors: [],      // [{ floor, count }] — set by Admin in Room Management > Setup
    roomCategories: [],  // [{ id, name }] — set by Admin
    rooms: [],            // [{ id, roomNo, floor, categoryId, bedType, ac, maxAdults, maxChildren, price, amenities, extraBedAllowed, extraBedPrice, outOfOrder, status:'available'|'occupied', booking:null|{guestName,guestPhone,checkIn,checkOut,invoiceId,createdByStaffId,createdAt} }]
    roomInvoices: [],      // server-backed room booking invoices — see renderRoomHistory()
    subscription: null,    // this admin's subscription row — see renderSubscriptionBadge()
    restaurantInvoices: [], // server-backed restaurant invoices — see renderHistory()
    // ---- banquet management: Admin configures halls (Setup); Staff (banquet dept) books them ----
    banquetHalls: [],     // [{ id, name, capacity, facilities:[], outOfOrder, pricing:{hour:{enabled,price}, day:{enabled,price}, week:{enabled,price}} }]
    banquetBookings: [],   // [{ id, bookingCode, hallId, customerName, customerPhone, guestCount, pricingBasis, unitPrice, durationCount, startISO, endISO, totalAmount, status:'booked'|'completed'|'cancelled', invoiceId, createdByStaffId, createdByName, createdAt }]
    allRoomBookings: []    // every room booking regardless of status — see renderTodayKpis()/renderAnalyticsCharts() for occupancy + check-in/out stats
  };

  function newTableOrder(){
    return { status:'available', customerName:'', customerPhone:'', items:[], appliedPromo:null, paymentMethod:'Cash' };
  }
  // Makes sure every table number from 1..tableCount has an order object (existing ones are left untouched).
  function ensureTables(){
    var n = state.tableCount || 0;
    for(var i = 1; i <= n; i++){
      var k = String(i);
      if(!state.tables[k]) state.tables[k] = newTableOrder();
    }
  }
  function getTable(id){
    var k = String(id);
    if(!state.tables[k]) state.tables[k] = newTableOrder();
    return state.tables[k];
  }
  // The order/customer/promo/payment currently on screen always belongs to state.currentTableId.
  function currentTable(){
    if(!state.currentTableId) return null;
    return getTable(state.currentTableId);
  }
  function computeTableStatus(t){
    return (t.customerName || t.customerPhone || (t.items && t.items.length > 0)) ? 'active' : 'available';
  }
  // Call after any edit to the current table's customer info / items / promo / payment method:
  // recomputes its status, saves it (debounced), and refreshes its sidebar indicator — without touching any other table.
  function syncCurrentTable(){
    var t = currentTable();
    if(!t) return;
    t.status = computeTableStatus(t);
    scheduleTableSave(state.currentTableId);
    updateTableNavBadges();
  }
  function updateTableNavBadges(){
    document.querySelectorAll('[data-table-badge]').forEach(function(el){
      var t = state.tables[el.getAttribute('data-table-badge')];
      el.classList.toggle('active', !!(t && t.status === 'active'));
    });
    renderTableStatusGrid();
  }
  // Admin-facing grid on the Table Setup page — shows every table as empty or occupied at a glance.
  function renderTableStatusGrid(){
    var wrap = document.getElementById('tableStatusGrid');
    if(!wrap) return;
    ensureTables();
    var n = state.tableCount || 0;
    if(n === 0){
      wrap.innerHTML = '<p class="hint" style="margin:0;">No tables set up yet — add a table count above.</p>';
      return;
    }
    var html = '';
    for(var i = 1; i <= n; i++){
      var t = state.tables[String(i)];
      var occupied = !!(t && t.status === 'active');
      html += '<div class="table-status-chip'+(occupied ? ' occupied' : '')+'">'
        + '<span class="tsc-num">Table '+i+'</span>'
        + '<span class="tsc-dot"></span>'
        + '<span class="tsc-label">'+(occupied ? 'Occupied' : 'Empty')+'</span>'
        + '</div>';
    }
    wrap.innerHTML = html;
  }

  // ---------- icon set (consistent stroke-style, used across nav + KPIs) ----------
  var ICONS = {
    dashboard:'<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>',
    setup:'<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></svg>',
    menu:'<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 2v7a1.5 1.5 0 0 0 1.5 1.5h0A1.5 1.5 0 0 0 10 9V2"/><path d="M8.5 10.5V22"/><path d="M17 2c-1.7 0-3 1.8-3 5s1.3 5 3 5v10"/></svg>',
    trash:'<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
    promo:'<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m20.59 13.41-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82Z"/><circle cx="7" cy="7" r="1.4" fill="currentColor" stroke="none"/></svg>',
    history:'<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/></svg>',
    analysis:'<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>',
    staff:'<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    billing:'<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>',
    room:'<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4v16"/><path d="M2 8h18a2 2 0 0 1 2 2v10"/><path d="M2 17h20"/><path d="M6 8V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>',
    banquet:'<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="22" x2="21" y2="22"/><line x1="6" y1="18" x2="6" y2="11"/><line x1="10" y1="18" x2="10" y2="11"/><line x1="14" y1="18" x2="14" y2="11"/><line x1="18" y1="18" x2="18" y2="11"/><polygon points="12 2 20 7 4 7"/></svg>',
    sales:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12"/><path d="M6 8h12"/><path d="m6 13 8.5 8"/><path d="M6 13h3"/><path d="M9 13c6.667 0 6.667-10 0-10"/></svg>',
    orders:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>',
    invoices:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><polyline points="14 2 14 8 20 8"/></svg>',
    users:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>',
    dish:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M7 2v7a1.5 1.5 0 0 0 1.5 1.5h0A1.5 1.5 0 0 0 10 9V2"/><path d="M8.5 10.5V22"/><path d="M17 2c-1.7 0-3 1.8-3 5s1.3 5 3 5v10"/></svg>',
    avg:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    up:'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>',
    down:'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>',
    check:'<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    xcirc:'<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
    info:'<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
    ai:'<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v3M12 18v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M3 12h3M18 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/><circle cx="12" cy="12" r="3.2"/></svg>'
  };

  var ADMIN_TABS = [
    { key:'dashboard', label:'Dashboard', num:'01', icon:'dashboard' },
    { key:'room-group', label:'Room Management', num:'02', icon:'room', children:[
        { key:'room-setup', label:'Setup' },
        { key:'room-availability', label:'Availability' },
        { key:'room-history', label:'History' }
      ] },
    { key:'banquet-group', label:'Banquet Management', num:'03', icon:'banquet', children:[
        { key:'banquet-setup', label:'Setup' },
        { key:'banquet-availability', label:'Availability' },
        { key:'banquet-history', label:'History' }
      ] },
    { key:'restaurant-group', label:'Restaurant Management', num:'04', icon:'menu', children:[
        { key:'menu-group', label:'Menu', children:[
            { key:'menu', label:'Add new item' },
            { key:'menu-trash', label:'Retrieve deleted item' }
          ] },
        { key:'promos', label:'Promo Codes' },
        { key:'analysis', label:'Sales Analysis' },
        { key:'table-setup', label:'Table Setup' },
        { key:'history', label:'History' },
        { key:'restaurant-setup', label:'Setup' }
      ] },
    { key:'staff', label:'Staff Mgmt', num:'05', icon:'staff' },
    { key:'ai-assistant', label:'AI Assistant', num:'06', icon:'ai' },
    { key:'setup', label:'Setup', num:'07', icon:'setup' }
  ];
  var STAFF_TABS_FALLBACK = [
    { key:'billing', label:'Billing', num:'01', icon:'billing' }
  ];
  // Maps a top-level ADMIN_TABS group key to the department it belongs to.
  // Groups not listed here (dashboard, staff, setup) are always visible —
  // they aren't tied to any one paid department.
  var TAB_GROUP_DEPARTMENT = { 'room-group':'room', 'banquet-group':'banquet', 'restaurant-group':'restaurant' };
  // Same idea, but for plan FEATURES (Voice, AI) rather than departments —
  // only the Premium plan carries either right now.
  var TAB_GROUP_FEATURE = { 'ai-assistant':'ai' };
  // Admin's sidebar only shows the department groups AND feature-gated tabs
  // their PLAN covers. Falls back to showing everything if state.subscription
  // hasn't loaded yet, so the nav never renders empty during the brief
  // window right after login before GET /subscription resolves.
  function visibleAdminTabs(){
    var allowedDepts = (state.subscription && state.subscription.departments) || ['room','banquet','restaurant'];
    var allowedFeats = (state.subscription && state.subscription.features) || [];
    return ADMIN_TABS.filter(function(t){
      var dept = TAB_GROUP_DEPARTMENT[t.key];
      if(dept) return allowedDepts.indexOf(dept) !== -1;
      var feat = TAB_GROUP_FEATURE[t.key];
      if(feat) return allowedFeats.indexOf(feat) !== -1;
      return true;
    });
  }
  // Staff's sidebar is built from the tables Admin configured (see Setup > Restaurant tables).
  // Falls back to a single generic "Billing" tab if Admin hasn't set any tables yet.
  function buildStaffTableTabs(){
    ensureTables();
    var n = state.tableCount || 0;
    var arr = [];
    for(var i = 1; i <= n; i++){
      arr.push({ key:'table-'+i, label:'Table '+i, num:String(i).padStart(2,'0'), icon:'billing', isTable:true, tableId:i });
    }
    return arr.length ? arr : STAFF_TABS_FALLBACK;
  }
  var ROOM_STAFF_TABS = [
    { key:'room-booking', label:'Room Management', num:'01', icon:'billing' },
    { key:'room-history', label:'History', num:'02', icon:'history' }
  ];
  var BANQUET_STAFF_TABS = [
    { key:'banquet-booking', label:'Banquet Booking', num:'01', icon:'billing' },
    { key:'banquet-history', label:'History', num:'02', icon:'history' }
  ];
  // Routes a logged-in staff member to the tabs for their assigned department.
  // Uses state.session.department — set directly from the login response
  // (their JWT), not looked up in state.staff, since GET /api/staff is
  // admin-only and is never populated during a staff session.
  function buildStaffTabsForSession(){
    var dept = state.session.department;
    if(dept === 'room') return ROOM_STAFF_TABS;
    if(dept === 'banquet') return BANQUET_STAFF_TABS;
    var tableTabs = buildStaffTableTabs();
    return tableTabs.concat([{ key:'history', label:'History', num:String(tableTabs.length + 1).padStart(2,'0'), icon:'history' }]);
  }
  var SECTION_META = {
    dashboard:{crumb:'Overview', title:'Dashboard'},
    'ai-assistant':{crumb:'Admin', title:'AI Assistant'},
    setup:{crumb:'Admin', title:'Hotel details'},
    menu:{crumb:'Admin / Restaurant', title:'Add new item'},
    'menu-trash':{crumb:'Admin / Restaurant', title:'Deleted items'},
    promos:{crumb:'Admin / Restaurant', title:'Promo codes'},
    history:{crumb:'Admin / Restaurant', title:'Invoice history'},
    analysis:{crumb:'Admin / Restaurant', title:'Sales analysis'},
    'table-setup':{crumb:'Admin / Restaurant', title:'Table setup'},
    'restaurant-setup':{crumb:'Admin / Restaurant', title:'Restaurant settings'},
    staff:{crumb:'Admin', title:'Staff management'},
    billing:{crumb:'Staff', title:'New bill'},
    'room-setup':{crumb:'Admin / Room Management', title:'Room setup'},
    'room-availability':{crumb:'Admin / Room Management', title:'Room availability'},
    'room-history':{crumb:'Admin / Room Management', title:'Booking history'},
    'room-booking':{crumb:'Staff / Room Management', title:'Room booking'},
    'banquet-setup':{crumb:'Admin / Banquet Management', title:'Banquet setup'},
    'banquet-availability':{crumb:'Admin / Banquet Management', title:'Banquet availability'},
    'banquet-history':{crumb:'Admin / Banquet Management', title:'Booking history'},
    'banquet-booking':{crumb:'Staff / Banquet Management', title:'Banquet booking'}
  };

  // ---------- storage helpers (browser localStorage, prefixed to avoid clashes) ----------
  var STORAGE_PREFIX = 'invoice-desk:';

  // ---------- theme (dark mode) ----------
  function applyTheme(theme){
    document.documentElement.setAttribute('data-theme', theme);
    var sw = document.getElementById('themeSwitch');
    if(sw) sw.classList.toggle('on', theme === 'dark');
  }
  var currentTheme = 'light';
  try{ currentTheme = window.localStorage.getItem(STORAGE_PREFIX + 'theme') || 'light'; }catch(e){}
  applyTheme(currentTheme);
  function toggleTheme(){
    currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
    applyTheme(currentTheme);
    try{ window.localStorage.setItem(STORAGE_PREFIX + 'theme', currentTheme); }catch(e){}
  }
  function storageGet(key){
    return new Promise(function(resolve){
      try{ resolve(window.localStorage.getItem(STORAGE_PREFIX + key)); }
      catch(e){ console.error('Storage read failed for', key, e); resolve(null); }
    });
  }
  function storageSet(key, value){
    return new Promise(function(resolve){
      try{ window.localStorage.setItem(STORAGE_PREFIX + key, value); resolve(true); }
      catch(e){
        console.error('Storage write failed for', key, e);
        showToast('Unable to save — your browser storage may be full or disabled.', 'error');
        resolve(null);
      }
    });
  }

  function loadAll(){
    return Promise.all([
      storageGet('admin-accounts'),   // global — every admin login
      storageGet('staff-accounts'),   // global — every staff login (tagged with adminId per record)
      storageGet('session'),
      storageGet('admin-account')     // legacy single-admin store, used only for migration
    ]).then(function(r){
      if(r[0]){ try{ state.admins = JSON.parse(r[0]); }catch(e){ state.admins = []; } }
      if(r[1]){ try{ state.staff = JSON.parse(r[1]); }catch(e){} }
      if(r[2]){ try{ state.session = JSON.parse(r[2]); }catch(e){} }

      var legacyAdminTask = Promise.resolve();
      if(r[3]){
        try{
          var legacy = JSON.parse(r[3]);
          if(legacy && legacy.email){
            var already = state.admins.some(function(a){
              return a.email && a.email.toLowerCase() === legacy.email.toLowerCase();
            });
            if(!already){
              state.admins.push({
                id: uid(),
                email: legacy.email,
                salt: legacy.salt,
                hash: legacy.hash,
                createdAt: legacy.createdAt || new Date().toISOString()
              });
              legacyAdminTask = persistAdmins();
            }
          }
        }catch(e){}
      }
      return legacyAdminTask;
    }).then(migrateStaffAdminIdsIfNeeded)
      .then(migrateLegacyTenantDataIfNeeded);
  }

  // Every admin account is a separate "tenant" — its own restaurant profile, menu,
  // invoices, promo codes and invoice numbering. Only admin logins and staff logins
  // (admin-accounts / staff-accounts / session) are shared/global; everything else
  // below is stored under a key suffixed with the owning admin's id.
  function tenantId(){ return state.session ? state.session.adminId : null; }
  function tKey(base){ return base + ':' + tenantId(); }
  function persistRestaurant(){ return storageSet(tKey('restaurant-info'), JSON.stringify(state.restaurant)); }
  function persistMenu(){ return storageSet(tKey('menu-items'), JSON.stringify(state.menu)); }
  function persistDeletedMenu(){ return storageSet(tKey('deleted-menu-items'), JSON.stringify(state.deletedMenu)); }
  function persistInvoices(){ return storageSet(tKey('invoices'), JSON.stringify(state.invoices)); }
  function persistInvoiceSeq(){ return storageSet(tKey('invoice-seq'), String(state.invoiceSeq)); }
  function persistAdmins(){ return storageSet('admin-accounts', JSON.stringify(state.admins)); }
  function persistStaff(){ return storageSet('staff-accounts', JSON.stringify(state.staff)); }
  function persistPromoCodes(){ return storageSet(tKey('promo-codes'), JSON.stringify(state.promoCodes)); }
  function persistTableConfig(){ return storageSet(tKey('table-count'), String(state.tableCount)); }
  function persistTables(){ return storageSet(tKey('tables-data'), JSON.stringify(state.tables)); }
  function persistRoomFloors(){ return storageSet(tKey('room-floors'), JSON.stringify(state.roomFloors)); }
  function persistRoomCategories(){ return storageSet(tKey('room-categories'), JSON.stringify(state.roomCategories)); }
  function persistRooms(){ return storageSet(tKey('rooms-data'), JSON.stringify(state.rooms)); }
  function persistBanquetHalls(){ return storageSet(tKey('banquet-halls'), JSON.stringify(state.banquetHalls)); }
  function persistBanquetBookings(){ return storageSet(tKey('banquet-bookings'), JSON.stringify(state.banquetBookings)); }
  function persistSession(){
    return state.session ? storageSet('session', JSON.stringify(state.session)) : storageSet('session', '');
  }
  function currentTenantStaff(){
    var id = tenantId();
    return state.staff.filter(function(s){ return s.adminId === id; });
  }
  function resetTenantState(){
    state.restaurant = Object.assign({}, DEFAULT_RESTAURANT);
    state.menu = [];
    state.deletedMenu = [];
    state.invoices = [];
    state.invoiceSeq = 0;
    state.promoCodes = [];
    state.activeInvoice = null;
    state.tableCount = 4;
    state.tables = {};
    state.currentTableId = null;
    state.roomFloors = [];
    state.roomCategories = [];
    state.rooms = [];
    state.banquetHalls = [];
    state.banquetBookings = [];
    state.allRoomBookings = [];
  }
  // Loads the restaurant data that belongs to the given admin id into state.
  // Called right after a successful login/signup (and when restoring a saved session)
  // so each admin only ever sees their own restaurant.
  function loadTenantData(id){
    resetTenantState();
    if(!id) return Promise.resolve();
    return Promise.all([
      storageGet('restaurant-info:' + id),
      storageGet('menu-items:' + id),
      storageGet('invoices:' + id),
      storageGet('invoice-seq:' + id),
      storageGet('promo-codes:' + id),
      storageGet('deleted-menu-items:' + id),
      storageGet('table-count:' + id),
      storageGet('tables-data:' + id),
      storageGet('room-floors:' + id),
      storageGet('room-categories:' + id),
      storageGet('rooms-data:' + id),
      storageGet('banquet-halls:' + id),
      storageGet('banquet-bookings:' + id)
    ]).then(function(r){
      if(r[0]){ try{ state.restaurant = Object.assign({}, DEFAULT_RESTAURANT, JSON.parse(r[0])); }catch(e){} }
      if(r[1]){ try{ state.menu = JSON.parse(r[1]); }catch(e){} }
      if(r[2]){ try{ state.invoices = JSON.parse(r[2]); }catch(e){} }
      if(r[4]){ try{ state.promoCodes = JSON.parse(r[4]); }catch(e){} }
      if(r[5]){ try{ state.deletedMenu = JSON.parse(r[5]); }catch(e){} }
      if(r[6] !== null && r[6] !== undefined && r[6] !== ''){ state.tableCount = parseInt(r[6], 10) || 0; }
      if(r[7]){ try{ state.tables = JSON.parse(r[7]); }catch(e){ state.tables = {}; } }
      if(r[8]){ try{ state.roomFloors = JSON.parse(r[8]); }catch(e){ state.roomFloors = []; } }
      if(r[9]){ try{ state.roomCategories = JSON.parse(r[9]); }catch(e){ state.roomCategories = []; } }
      if(r[10]){ try{ state.rooms = JSON.parse(r[10]); }catch(e){ state.rooms = []; } }
      if(r[11]){ try{ state.banquetHalls = JSON.parse(r[11]); }catch(e){ state.banquetHalls = []; } }
      if(r[12]){ try{ state.banquetBookings = JSON.parse(r[12]); }catch(e){ state.banquetBookings = []; } }
      ensureTables();
      var seqTask;
      if(r[3]){
        state.invoiceSeq = parseInt(r[3], 10) || 0;
      } else {
        state.invoiceSeq = state.invoices.length;
        seqTask = persistInvoiceSeq();
      }
      return Promise.resolve(seqTask).then(repairBanquetBookingTotalsIfNeeded)
        .then(function(){ return fetchRoomSetupFromServer().catch(ignorePlanAccessError); })
        .then(fetchRestaurantSettingsFromServer)
        .then(function(){ return fetchMenuFromServer().catch(ignorePlanAccessError); });
    });
  }
  // Room/Restaurant setup are gated by the admin's subscription plan (see
  // backend rbac.js). A brand-new signup (subscription inactive) or an admin
  // whose plan doesn't include that department will get a 402/403 here —
  // that's expected, not a real failure, and must NOT stop login itself.
  // The paywall (shown right after loadTenantData resolves) is what actually
  // blocks access; this just leaves state.rooms/state.menu empty instead of
  // rejecting the whole login promise chain. Anything else (network/500)
  // still surfaces as a real error.
  function ignorePlanAccessError(e){
    if(e && (e.status === 402 || e.status === 403)) return;
    throw e;
  }
  // Only admins (who see everything) and Room-department staff are allowed to
  // call the room-setup endpoints — matches the backend's requireDepartment('room').
  function canAccessRoomModule(){
    return !!state.session && (state.session.role === 'admin' || state.session.department === 'room');
  }
  function mapServerFloor(f){ return { id: f.id, floor: parseInt(f.floor, 10), count: f.room_count }; }
  function mapServerCategory(c){ return { id: c.id, name: c.name }; }
  function mapServerRoom(r){
    return {
      id: r.id, roomNo: parseInt(r.room_no, 10), floor: parseInt(r.floor, 10), categoryId: r.category_id,
      bedType: r.bed_type, ac: !!r.ac, maxAdults: r.max_adults, maxChildren: r.max_children,
      price: parseFloat(r.price), amenities: r.amenities || [], extraBedAllowed: r.extra_bed_allowed,
      extraBedPrice: parseFloat(r.extra_bed_price || 0), outOfOrder: r.out_of_order,
      status: r.booking_id ? 'occupied' : 'available',
      booking: r.booking_id ? { id: r.booking_id, guestName: r.guest_name, guestPhone: r.guest_phone, checkIn: r.check_in, checkOut: r.check_out, invoiceId: r.invoice_id, advanceAmount: parseFloat(r.advance_amount)||0, balancePaid: !!r.balance_paid } : null
    };
  }
  // Pulls floors/categories/rooms fresh from the cloud database. Call this after
  // login and after any change, so every device shows the same room inventory.
  function fetchRoomSetupFromServer(){
    if(!canAccessRoomModule()) return Promise.resolve();
    return Promise.all([api.getRoomFloors(), api.getRoomCategories(), api.getRooms()]).then(function(r){
      state.roomFloors = r[0].map(mapServerFloor);
      state.roomCategories = r[1].map(mapServerCategory);
      state.rooms = r[2].map(mapServerRoom);
    });
  }
  // Only admins and Banquet-department staff may call the banquet endpoints
  // (matches the backend's requireDepartment('banquet')).
  function canAccessBanquetModule(){
    return !!state.session && (state.session.role === 'admin' || state.session.department === 'banquet');
  }
  function mapServerHall(h){
    return { id: h.id, name: h.name, capacity: h.capacity, outOfOrder: h.out_of_order, facilities: h.facilities || [], pricing: h.pricing || { hour:{enabled:false,price:0}, day:{enabled:false,price:0}, week:{enabled:false,price:0} } };
  }
  function mapServerBanquetBooking(b){
    return {
      id: b.id, bookingCode: b.booking_code, hallId: b.hall_id,
      customerName: b.customer_name, customerPhone: b.customer_phone,
      guestCount: b.guest_count, eventType: b.event_type, foodPackage: b.food_package, decorationPackage: b.decoration_package,
      pricingBasis: b.pricing_basis, unitPrice: parseFloat(b.unit_price),
      durationCount: parseFloat(b.duration_count), startISO: b.start_at, endISO: b.end_at,
      totalAmount: parseFloat(b.total_amount), status: b.status, invoiceId: b.invoice_id,
      advanceAmount: parseFloat(b.advance_amount) || 0, advancePaymentMethod: b.advance_payment_method,
      balancePaid: !!b.balance_paid, balancePaidAt: b.balance_paid_at,
      createdByStaffId: b.created_by_staff_id, createdByName: b.created_by_name, createdAt: b.created_at
    };
  }
  // Pulls halls fresh from the cloud database.
  function fetchBanquetHallsFromServer(){
    if(!canAccessBanquetModule()) return Promise.resolve();
    return api.getBanquetHalls().then(function(rows){ state.banquetHalls = rows.map(mapServerHall); });
  }
  // Pulls bookings fresh from the cloud database — call before rendering
  // History, the staff bookings list, or checking for scheduling conflicts.
  function fetchBanquetBookingsFromServer(){
    if(!canAccessBanquetModule()) return Promise.resolve();
    return api.getBanquetBookings().then(function(rows){ state.banquetBookings = rows.map(mapServerBanquetBooking); });
  }
  // Hotel identity, tax settings, and table count are stored server-side in
  // restaurant_settings (table_count as its own column; everything else — name,
  // logo, tax rate, invoice prefix, etc. — inside the `extra` JSON field, so no
  // schema migration was needed for it). Every role fetches this (not just
  // Restaurant staff) because Room and Banquet invoices use this branding too —
  // the backend allows any authenticated user to read it for exactly that reason.
  function fetchRestaurantSettingsFromServer(){
    if(!state.session) return Promise.resolve();
    return api.getRestaurantSettings().then(function(row){
      if(!row) return;
      state.tableCount = row.table_count;
      state.restaurant = Object.assign({}, DEFAULT_RESTAURANT, row.extra || {});
    });
  }
  // Maps one row from GET /api/restaurant/tables into the shape the UI already
  // expects (see newTableOrder()). appliedPromo is stored server-side as just the
  // code — this reconstructs the full object the UI needs from state.promoCodes.
  function mapServerTable(row){
    var promo = row.applied_promo ? state.promoCodes.find(function(p){ return p.code === row.applied_promo; }) : null;
    return {
      status: row.status, customerName: row.customer_name || '', customerPhone: row.customer_phone || '',
      items: row.items || [], appliedPromo: promo || null, paymentMethod: row.payment_method || 'Cash'
    };
  }
  function fetchTablesFromServer(){
    if(!canAccessRestaurantModule()) return Promise.resolve();
    return api.getTables().then(function(rows){
      var byNo = {};
      rows.forEach(function(r){ byNo[String(r.table_no)] = mapServerTable(r); });
      state.tables = byNo;
      ensureTables();
    });
  }
  // Live order edits (adding a dish, typing the customer's name, applying a promo)
  // save to the server on a short debounce per table, so rapid clicks/keystrokes
  // don't fire a network request each time, but nothing is left unsaved for long.
  var tableSaveTimers = {};
  function pushTableToServer(tableId){
    var t = state.tables[String(tableId)];
    if(!t) return Promise.resolve();
    return api.saveTable(tableId, {
      status: t.status, customerName: t.customerName, customerPhone: t.customerPhone,
      items: t.items, appliedPromo: t.appliedPromo ? t.appliedPromo.code : null, paymentMethod: t.paymentMethod
    }).catch(function(e){ showToast('Could not save table: ' + e.message, 'error'); });
  }
  function scheduleTableSave(tableId){
    clearTimeout(tableSaveTimers[tableId]);
    tableSaveTimers[tableId] = setTimeout(function(){ pushTableToServer(tableId); }, 700);
  }
  // One-time migration: staff accounts created before multi-tenant support have no
  // owning admin — assign them to the first admin account so existing logins keep working.
  function migrateStaffAdminIdsIfNeeded(){
    if(state.admins.length === 0 || state.staff.length === 0) return Promise.resolve();
    var targetId = state.admins[0].id;
    var changed = false;
    state.staff.forEach(function(s){ if(!s.adminId){ s.adminId = targetId; changed = true; } });
    return changed ? persistStaff() : Promise.resolve();
  }
  // One-time migration: data saved before multi-tenant support lived under un-suffixed
  // keys shared by everyone — hand that existing data to the first admin account so
  // nothing is lost, without affecting any admin created after this update.
  function migrateLegacyTenantDataIfNeeded(){
    if(state.admins.length === 0) return Promise.resolve();
    var targetId = state.admins[0].id;
    return storageGet('restaurant-info:' + targetId).then(function(already){
      if(already !== null) return; // this tenant already has its own scoped data
      return Promise.all([
        storageGet('restaurant-info'), storageGet('menu-items'), storageGet('invoices'),
        storageGet('invoice-seq'), storageGet('promo-codes'), storageGet('deleted-menu-items')
      ]).then(function(r){
        var hasLegacyData = r.some(function(v){ return v !== null; });
        if(!hasLegacyData) return;
        var tasks = [];
        if(r[0] !== null) tasks.push(storageSet('restaurant-info:' + targetId, r[0]));
        if(r[1] !== null) tasks.push(storageSet('menu-items:' + targetId, r[1]));
        if(r[2] !== null) tasks.push(storageSet('invoices:' + targetId, r[2]));
        if(r[3] !== null) tasks.push(storageSet('invoice-seq:' + targetId, r[3]));
        if(r[4] !== null) tasks.push(storageSet('promo-codes:' + targetId, r[4]));
        if(r[5] !== null) tasks.push(storageSet('deleted-menu-items:' + targetId, r[5]));
        return Promise.all(tasks);
      });
    });
  }

  // ---------- utils ----------
  function uid(){ return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,8); }
  function money(n){
    n = Math.round((n + Number.EPSILON) * 100) / 100;
    return state.restaurant.currency + n.toFixed(2);
  }
  // Comma-grouped rupee display for the subscription paywall specifically
  // (₹9,440 instead of money()'s ₹9440.00) — invoices/receipts elsewhere
  // keep using money() unchanged so nothing there is affected.
  function moneyINR(n){
    n = Math.round(n + Number.EPSILON);
    return '₹' + n.toLocaleString('en-IN');
  }
  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, function(c){
      return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];
    });
  }
  // Exports an array of plain objects to a downloadable .xlsx file, using
  // the column order/labels given in `columns` (falls back to the object's
  // own keys if omitted). Used by every "Export to Excel" button across
  // Staff, Room History, Banquet History, and Restaurant History.
  function exportRowsToExcel(filenameBase, rows, columns){
    if(typeof XLSX === 'undefined'){
      showToast('Export library failed to load — check your internet connection and try again.', 'error');
      return;
    }
    if(!rows || rows.length === 0){
      showToast('Nothing to export yet.', 'info');
      return;
    }
    var data = rows.map(function(row){
      if(!columns) return row;
      var out = {};
      columns.forEach(function(col){ out[col.label] = row[col.key]; });
      return out;
    });
    var sheet = XLSX.utils.json_to_sheet(data);
    var book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, 'Sheet1');
    var stamp = localDateStr(new Date());
    XLSX.writeFile(book, filenameBase + '_' + stamp + '.xlsx');
  }
  // Masks an ID proof number for display on invoices — only the last 4 characters
  // stay visible, everything else (except existing spaces) becomes X. The full
  // number is still kept in the booking record for staff/admin reference.
  function maskIdProof(idNumber){
    var clean = String(idNumber || '').trim();
    if(clean.length === 0) return '';
    if(clean.length <= 4) return clean.replace(/\S/g, 'X');
    var head = clean.slice(0, -4).replace(/\S/g, 'X');
    var tail = clean.slice(-4);
    return head + tail;
  }
  function showToast(msg, type){
    type = type || 'success';
    var wrap = document.getElementById('toastWrap');
    var t = document.createElement('div');
    t.className = 'toast ' + type;
    var icoSvg = type === 'error' ? ICONS.xcirc : (type === 'info' ? ICONS.info : ICONS.check);
    t.innerHTML = '<span class="t-ico">'+icoSvg+'</span><span>'+escapeHtml(msg)+'</span>';
    wrap.appendChild(t);
    requestAnimationFrame(function(){ t.classList.add('show'); });
    setTimeout(function(){
      t.classList.remove('show');
      setTimeout(function(){ t.remove(); }, 260);
    }, 2600);
  }
  function randomSalt(){
    var arr = new Uint8Array(16);
    if(window.crypto && window.crypto.getRandomValues){ window.crypto.getRandomValues(arr); }
    else{ for(var i=0;i<16;i++){ arr[i] = Math.floor(Math.random()*256); } }
    return Array.from(arr).map(function(b){ return b.toString(16).padStart(2,'0'); }).join('');
  }
  function hashPassword(password, salt){
    return new Promise(function(resolve){
      var input = salt + ':' + password;
      if(window.crypto && window.crypto.subtle){
        var enc = new TextEncoder().encode(input);
        window.crypto.subtle.digest('SHA-256', enc).then(function(buf){
          resolve(Array.from(new Uint8Array(buf)).map(function(b){ return b.toString(16).padStart(2,'0'); }).join(''));
        }).catch(function(){ resolve(fallbackHash(input)); });
      } else {
        resolve(fallbackHash(input));
      }
    });
  }
  function fallbackHash(str){
    var hash = 0;
    for(var i=0;i<str.length;i++){ hash = (hash<<5)-hash+str.charCodeAt(i); hash |= 0; }
    return 'fb-' + Math.abs(hash).toString(16);
  }
  function isValidEmail(email){ return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }

  function bindEnterToSubmit(inputIds, buttonId){
    inputIds.forEach(function(id){
      var el = document.getElementById(id);
      if(!el) return;
      el.addEventListener('keydown', function(e){
        if(e.key === 'Enter'){
          e.preventDefault();
          var btn = document.getElementById(buttonId);
          if(btn) btn.click();
        }
      });
    });
  }

  // password visibility toggles (auth + modals)
  document.querySelectorAll('[data-toggle-pw]').forEach(function(btn){
    btn.addEventListener('click', function(){
      var input = document.getElementById(btn.dataset.togglePw);
      if(!input) return;
      var isPw = input.type === 'password';
      input.type = isPw ? 'text' : 'password';
      btn.style.opacity = isPw ? '1' : '.6';
    });
  });

  // ================= AUTH GATE =================
  // Only two panels now (adminAuth / staffAuth) — kept as a name->panel toggle
  // since a couple of other flows (logout, session-restore) just want to
  // reset back to the admin login view via resetGateToDefault() below.
  var gatePanels = document.querySelectorAll('.gate-panel');
  function showGatePanel(name){
    gatePanels.forEach(function(p){ p.classList.toggle('active', p.dataset.gate === name); });
  }

  function showAdminSignupPanel(){
    document.getElementById('signupError').classList.remove('show');
    document.getElementById('loginError').classList.remove('show');
    document.getElementById('adminAuthSignup').style.display = 'block';
    document.getElementById('adminAuthLogin').style.display = 'none';
  }
  function showAdminLoginPanel(){
    document.getElementById('signupError').classList.remove('show');
    document.getElementById('loginError').classList.remove('show');
    document.getElementById('adminAuthSignup').style.display = 'none';
    document.getElementById('adminAuthLogin').style.display = 'block';
  }
  document.getElementById('showAdminLogin').addEventListener('click', showAdminLoginPanel);
  document.getElementById('showAdminSignup').addEventListener('click', showAdminSignupPanel);

  // Admin Login / Staff Login tabs — sit at the top of the single gate card
  // and swap which role's fields are shown, instead of the old separate
  // "choose a role" screen.
  var gateTabs = document.querySelectorAll('.gate-tab');
  var gateRolePanels = document.querySelectorAll('.gate-role-panel');
  function setGateTab(role){
    gateTabs.forEach(function(t){ t.classList.toggle('active', t.dataset.roleTab === role); });
    gateRolePanels.forEach(function(p){ p.classList.toggle('active', p.dataset.rolePanel === role); });
    if(role === 'staff'){
      document.getElementById('staffLoginError').classList.remove('show');
    }
  }
  document.getElementById('tabAdmin').addEventListener('click', function(){ setGateTab('admin'); });
  document.getElementById('tabStaff').addEventListener('click', function(){ setGateTab('staff'); });

  // Used by logout / failed-session-restore to land back on a clean,
  // logged-out gate screen (Admin tab, login view — not signup).
  function resetGateToDefault(){
    setGateTab('admin');
    showAdminLoginPanel();
    document.getElementById('loginError').classList.remove('show');
    document.getElementById('staffLoginError').classList.remove('show');
  }

  function gateForgotNotice(){
    showToast('Self-service password reset isn\'t available yet — please contact support to reset your password.', 'info');
  }
  document.getElementById('adminForgotBtn').addEventListener('click', gateForgotNotice);
  document.getElementById('staffForgotBtn').addEventListener('click', gateForgotNotice);

  // Security reassurance banner above the gate screen — dismissible, and
  // stays dismissed on this browser once closed.
  (function(){
    var BANNER_KEY = 'hotel-desk:security-banner-dismissed';
    var banner = document.getElementById('gateSecurityBanner');
    var dismissed = false;
    try { dismissed = window.localStorage.getItem(BANNER_KEY) === '1'; } catch(e){}
    if(dismissed) banner.style.display = 'none';
    document.getElementById('gateSecurityBannerClose').addEventListener('click', function(){
      banner.style.display = 'none';
      try { window.localStorage.setItem(BANNER_KEY, '1'); } catch(e){}
    });
  })();

  // Top nav info links on the gate screen — a proper modal with real,
  // honest content about what's actually in the product (no fake demo,
  // no promises of pages that don't exist).
  var gateInfoContent = {
    modules: {
      title: 'Key modules',
      sub: 'Everything a hotel needs to run day to day, in one dashboard.',
      body:
        '<div class="gi-module-list">' +
        moduleRow('M3 21V8l9-5 9 5v13,M9 21v-7h6v7', 'Room booking', 'Floors, categories, inventory, check-in/checkout and guest lookup across departments.') +
        moduleRow('M3 21h18,M5 21V7l7-4 7 4v14,M9 21v-9,M15 21v-9', 'Banquet hall booking', 'Halls, pricing by hour/day/week, and a live booking calendar.') +
        moduleRow('M3 2v7c0 1.1.9 2 2 2h2a2 2 0 0 0 2-2V2,M7 2v20,M17 2v9c-2 0-3 1-3 3v8', 'Restaurant management', 'Menu, live table billing, promo codes and order tracking.') +
        moduleRow('M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2,M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z', 'Staff management', 'One account per department, with role-based access to only what they need.') +
        moduleRow('M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z,M14 2v6h6', 'Invoicing & reports', 'Sequential GST-ready invoices, PDF sharing, and daily sales breakdowns.') +
        '</div>'
    },
    pricing: {
      title: 'Pricing',
      sub: 'Pick only the departments you need — upgrade to full access any time later.',
      body:
        '<div class="gi-plan-list">'
        + giPlanCard('Room + Banquet', '₹9,440', '₹8,000 + 18% GST', ['Room management', 'Banquet management'])
        + giPlanCard('Restaurant Only', '₹7,080', '₹6,000 + 18% GST', ['Restaurant management'])
        + giPlanCard('All Departments', '₹14,160', '₹12,000 + 18% GST', ['Room management', 'Banquet management', 'Restaurant management'], true)
        + '</div>'
        + '<div class="gi-module-list" style="margin-top:20px;">'
        + moduleRow('M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2,M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z', 'Staff accounts', 'One per department included in your plan')
        + moduleRow('M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z,M14 2v6h6', 'Invoicing, PDFs & reports', 'Included on every plan')
        + '</div>'
        + '<p class="gi-cta">Free to create — <a id="giCreateAccount">create an admin account</a>, then choose a plan from your dashboard.</p>'
    }
  };
  function giPlanCard(name, total, breakdown, departments, featured){
    return '<div class="gi-plan-card' + (featured ? ' featured' : '') + '">'
      + (featured ? '<span class="gi-plan-badge">Full access</span>' : '')
      + '<div class="gi-plan-card-top"><b>' + name + '</b><span class="gi-plan-card-price">' + total + '<small>/yr</small></span></div>'
      + '<div class="gi-plan-card-breakdown">' + breakdown + '</div>'
      + '<div class="gi-plan-card-depts">' + departments.join(' + ') + '</div>'
      + '</div>';
  }
  function moduleRow(iconPaths, title, desc){
    var paths = iconPaths.split(',').map(function(d){ return '<path d="' + d + '"/>'; }).join('');
    return '<div class="gi-module"><span class="gf-ico"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + paths + '</svg></span><span><b>' + title + '</b><span>' + desc + '</span></span></div>';
  }
  var gateInfoScrim = document.getElementById('gateInfoScrim');
  function openGateInfo(key){
    var data = gateInfoContent[key];
    document.getElementById('gateInfoContent').innerHTML =
      '<h3 class="gi-title">' + data.title + '</h3><p class="gi-sub">' + data.sub + '</p>' + data.body;
    gateInfoScrim.classList.add('show');
    var createLink = document.getElementById('giCreateAccount');
    if(createLink){
      createLink.addEventListener('click', function(){
        closeGateInfo();
        setGateTab('admin');
        showAdminSignupPanel();
        document.getElementById('signupFirstName').focus();
      });
    }
  }
  function closeGateInfo(){ gateInfoScrim.classList.remove('show'); }
  document.getElementById('gtnModulesBtn').addEventListener('click', function(){ openGateInfo('modules'); });
  document.getElementById('gtnPricingBtn').addEventListener('click', function(){ openGateInfo('pricing'); });
  document.getElementById('gateInfoClose').addEventListener('click', closeGateInfo);
  gateInfoScrim.addEventListener('click', function(e){ if(e.target === gateInfoScrim) closeGateInfo(); });
  document.addEventListener('keydown', function(e){ if(e.key === 'Escape') closeGateInfo(); });

  function setBtnLoading(btn, loading, loadingLabel, normalLabel){
    if(loading){
      btn.dataset.label = btn.dataset.label || normalLabel || btn.textContent.trim();
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>' + escapeHtml(loadingLabel || 'Working…');
    } else {
      btn.disabled = false;
      btn.textContent = normalLabel || btn.dataset.label || btn.textContent;
    }
  }

  document.getElementById('signupBtn').addEventListener('click', function(){
    var btn = this;
    var firstName = document.getElementById('signupFirstName').value.trim();
    var lastName = document.getElementById('signupLastName').value.trim();
    var email = document.getElementById('signupEmail').value.trim().toLowerCase();
    var pw = document.getElementById('signupPassword').value;
    var pw2 = document.getElementById('signupConfirm').value;
    var err = document.getElementById('signupError');

    if(!firstName){ err.textContent = 'Enter your first name.'; err.classList.add('show'); return; }
    if(!lastName){ err.textContent = 'Enter your last name.'; err.classList.add('show'); return; }
    if(!isValidEmail(email)){ err.textContent = 'Enter a valid email address.'; err.classList.add('show'); return; }
    if(pw.length < 6){ err.textContent = 'Password must be at least 6 characters.'; err.classList.add('show'); return; }
    if(pw !== pw2){ err.textContent = 'Passwords do not match.'; err.classList.add('show'); return; }
    err.classList.remove('show');

    setBtnLoading(btn, true, 'Creating account…');
    api.adminSignup(firstName, lastName, email, pw).then(function(user){
      state.session = { role:'admin', adminId: user.adminId, email: user.email, firstName: user.firstName, lastName: user.lastName, photo: user.photo || null };
      resetTenantState(); // brand-new admin — starts with a completely fresh restaurant, not anyone else's data
      setBtnLoading(btn, false, null, 'Create account & continue');
      showToast('Admin account created');
      document.getElementById('signupFirstName').value = '';
      document.getElementById('signupLastName').value = '';
      document.getElementById('signupEmail').value = '';
      document.getElementById('signupPassword').value = '';
      document.getElementById('signupConfirm').value = '';
      proceedAfterLogin();
    }).catch(function(e){
      setBtnLoading(btn, false, null, 'Create account & continue');
      err.textContent = e.message; err.classList.add('show');
    });
  });

  document.getElementById('loginBtn').addEventListener('click', function(){
    var btn = this;
    var email = document.getElementById('loginEmail').value.trim().toLowerCase();
    var pw = document.getElementById('loginPassword').value;
    var err = document.getElementById('loginError');

    var remember = document.getElementById('loginRemember').checked;
    setBtnLoading(btn, true, 'Signing in…');
    api.adminLogin(email, pw, remember).then(function(user){
      err.classList.remove('show');
      state.session = { role:'admin', adminId: user.adminId, email: user.email, firstName: user.firstName, lastName: user.lastName, photo: user.photo || null };
      return loadTenantData(user.adminId);
    }).then(function(){
      setBtnLoading(btn, false, null, 'Log in');
      proceedAfterLogin();
    }).catch(function(e){
      setBtnLoading(btn, false, null, 'Log in');
      err.textContent = e.message; err.classList.add('show');
    });
  });

  // ---------- "Continue with Google" (admin only) ----------
  // Set this to the OAuth Client ID from Google Cloud Console (see README) —
  // it's not a secret, it's meant to be public in frontend code.
  var GOOGLE_CLIENT_ID = '516202983818-1il4sbfers16cuee2i46v4harn7an026.apps.googleusercontent.com';

  var googleTokenClient = null;
  function getGoogleTokenClient(){
    if(!GOOGLE_CLIENT_ID || GOOGLE_CLIENT_ID.indexOf('PASTE_YOUR') === 0){
      showToast('Google sign-in isn\'t configured yet — add your Client ID in index.html.', 'error');
      return null;
    }
    if(typeof google === 'undefined' || !google.accounts){
      showToast('Google sign-in is still loading — try again in a moment.', 'error');
      return null;
    }
    if(!googleTokenClient){
      googleTokenClient = google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CLIENT_ID,
        scope: 'openid email profile',
        callback: handleGoogleToken
      });
    }
    return googleTokenClient;
  }
  var googleAuthBtn = null; // whichever Google button was clicked, so we can reset its loading state
  function handleGoogleToken(tokenResponse){
    if(!tokenResponse || tokenResponse.error){
      if(googleAuthBtn) setBtnLoading(googleAuthBtn, false, null, 'Continue with Google');
      if(tokenResponse && tokenResponse.error !== 'popup_closed' && tokenResponse.error !== 'access_denied'){
        showToast('Google sign-in failed. Please try again.', 'error');
      }
      return;
    }
    api.adminGoogleLogin(tokenResponse.access_token).then(function(user){
      state.session = { role:'admin', adminId: user.adminId, email: user.email, firstName: user.firstName, lastName: user.lastName, photo: user.photo || null };
      return loadTenantData(user.adminId);
    }).then(function(){
      if(googleAuthBtn) setBtnLoading(googleAuthBtn, false, null, 'Continue with Google');
      proceedAfterLogin();
    }).catch(function(e){
      if(googleAuthBtn) setBtnLoading(googleAuthBtn, false, null, 'Continue with Google');
      showToast(e.message, 'error');
    });
  }
  function startGoogleSignIn(btn){
    var client = getGoogleTokenClient();
    if(!client) return;
    googleAuthBtn = btn;
    setBtnLoading(btn, true, 'Opening Google…');
    client.requestAccessToken();
  }
  document.getElementById('googleSignupBtn').addEventListener('click', function(){ startGoogleSignIn(this); });
  document.getElementById('googleLoginBtn').addEventListener('click', function(){ startGoogleSignIn(this); });

  document.getElementById('staffLoginBtn').addEventListener('click', function(){
    var btn = this;
    var staffId = document.getElementById('staffLoginId').value.trim();
    var pw = document.getElementById('staffLoginPassword').value;
    var err = document.getElementById('staffLoginError');

    var remember = document.getElementById('staffLoginRemember').checked;
    setBtnLoading(btn, true, 'Signing in…');
    api.staffLogin(staffId, pw, remember).then(function(user){
      err.classList.remove('show');
      state.session = { role:'staff', staffId: user.staffId, name: user.name, department: user.department, adminId: user.adminId, photo: user.photo || null };
      return loadTenantData(user.adminId);
    }).then(function(){
      setBtnLoading(btn, false, null, 'Log in');
      enterApp();
    }).catch(function(e){
      setBtnLoading(btn, false, null, 'Log in');
      err.textContent = e.message; err.classList.add('show');
    });
  });

  bindEnterToSubmit(['signupFirstName','signupLastName','signupEmail','signupPassword','signupConfirm'], 'signupBtn');
  bindEnterToSubmit(['loginEmail','loginPassword'], 'loginBtn');
  bindEnterToSubmit(['staffLoginId','staffLoginPassword'], 'staffLoginBtn');

  function exitApp(){
    state.session = null;
    api.logout();
    document.getElementById('appLayout').classList.remove('show');
    document.getElementById('gateScreen').style.display = 'flex';
    resetGateToDefault();
    document.getElementById('loginEmail').value = '';
    document.getElementById('loginPassword').value = '';
    document.getElementById('staffLoginId').value = '';
    document.getElementById('staffLoginPassword').value = '';
  }
  document.getElementById('logoutBtn').addEventListener('click', function(){
    if(api.isDemoMode()) endDashboardDemo(); else exitApp();
  });

  // ================= DASHBOARD DEMO =================
  // A fully sandboxed walkthrough — signs the visitor straight into a fake
  // admin account with sample data (see api.js's DEMO_* constants), no real
  // account or subscription involved. api.js intercepts every network call
  // while this is active: reads return the sample data, writes are rejected
  // with a friendly message — so nothing here can ever touch real data.
  var DEMO_DURATION_SECONDS = 100;
  var demoCountdownInterval = null;
  function startDashboardDemo(){
    api.enterDemoMode();
    resetTenantState();
    state.session = { role:'admin', demo:true, adminId:'demo', email:'demo@eazzio.app', firstName:'Demo', lastName:'Admin', photo:null };
    loadTenantData('demo').then(function(){
      proceedAfterLogin();
      var banner = document.getElementById('demoBanner');
      var timerEl = document.getElementById('demoBannerTimer');
      banner.style.display = 'flex';
      var remaining = DEMO_DURATION_SECONDS;
      function tick(){
        var m = Math.floor(remaining / 60), s = remaining % 60;
        timerEl.textContent = m + ':' + String(s).padStart(2, '0');
        if(remaining <= 0){
          endDashboardDemo();
          return;
        }
        remaining--;
      }
      tick();
      demoCountdownInterval = setInterval(tick, 1000);
    }).catch(function(e){
      api.exitDemoMode();
      showToast('Could not start the demo: ' + e.message, 'error');
    });
  }
  function endDashboardDemo(){
    if(demoCountdownInterval){ clearInterval(demoCountdownInterval); demoCountdownInterval = null; }
    api.exitDemoMode();
    document.getElementById('demoBanner').style.display = 'none';
    exitApp();
    showToast('Demo ended — create your own free account to keep going.', 'info');
  }
  document.getElementById('gtnDemoBtn').addEventListener('click', startDashboardDemo);
  document.getElementById('demoBannerExit').addEventListener('click', endDashboardDemo);

  // ================= CONFIRM MODAL (replaces window.confirm) =================
  var confirmScrim = document.getElementById('confirmModalScrim');
  var confirmOkBtn = document.getElementById('confirmModalOk');
  var confirmPendingCb = null;
  function openConfirm(opts){
    document.getElementById('confirmModalTitle').textContent = opts.title || 'Are you sure?';
    document.getElementById('confirmModalDesc').innerHTML = opts.desc || 'This action cannot be undone.';
    confirmOkBtn.textContent = opts.confirmLabel || 'Confirm';
    confirmPendingCb = opts.onConfirm || null;
    confirmScrim.classList.add('show');
  }
  function closeConfirm(){ confirmScrim.classList.remove('show'); confirmPendingCb = null; }
  document.getElementById('confirmModalCancel').addEventListener('click', closeConfirm);
  confirmScrim.addEventListener('click', function(e){ if(e.target === confirmScrim) closeConfirm(); });
  confirmOkBtn.addEventListener('click', function(){
    var cb = confirmPendingCb;
    closeConfirm();
    if(cb) cb();
  });

  // generic small modal helpers (staff / promo)
  function wireModal(scrimId, closeIds, onOpenFocusId){
    var scrim = document.getElementById(scrimId);
    closeIds.forEach(function(id){
      var el = document.getElementById(id);
      if(el) el.addEventListener('click', function(){ scrim.classList.remove('show'); });
    });
    scrim.addEventListener('click', function(e){ if(e.target === scrim) scrim.classList.remove('show'); });
    return scrim;
  }
  var staffModalScrim = wireModal('staffModalScrim', ['staffModalClose','staffModalCancel']);
  var promoModalScrim = wireModal('promoModalScrim', ['promoModalClose','promoModalCancel']);
  var editNameModalScrim = wireModal('editNameModalScrim', ['editNameModalClose','editNameModalCancel']);
  var DEPARTMENTS = [
    { key:'room', label:'Room Management' },
    { key:'banquet', label:'Banquet Management' },
    { key:'restaurant', label:'Restaurant Management' }
  ];
  var DEFAULT_AMENITIES = ['Wi-Fi','TV','Attached Bathroom','Hot Water','Refrigerator','Wardrobe','Balcony','Room Service','Geyser','Telephone','Desk'];
  // How many staff accounts (and which departments) this tenant is allowed
  // depends on their subscription plan now, not a flat 3. Falls back to all
  // 3 if state.subscription hasn't loaded yet (shouldn't normally happen,
  // since the paywall gates entry until it has).
  function planDepartments(){
    return (state.subscription && state.subscription.departments) || DEPARTMENTS.map(function(d){ return d.key; });
  }
  function MAX_STAFF_ACCOUNTS_NOW(){ return planDepartments().length; }
  var MAX_STAFF_ACCOUNTS = DEPARTMENTS.length; // kept for any stray reference; prefer MAX_STAFF_ACCOUNTS_NOW()
  function departmentLabel(key){
    var d = DEPARTMENTS.find(function(x){ return x.key === key; });
    return d ? d.label : (key || '—');
  }
  function openDepartments(tenantStaff){
    var taken = {};
    tenantStaff.forEach(function(s){ taken[s.department] = true; });
    var allowed = planDepartments();
    return DEPARTMENTS.filter(function(d){ return !taken[d.key] && allowed.indexOf(d.key) !== -1; });
  }
  // Same "already taken" filtering as openDepartments(), but keeps
  // currentDept selectable even though it's technically taken — by the
  // staff member being edited themselves.
  function populateDepartmentSelect(selectEl, currentDept){
    var taken = {};
    currentTenantStaff().forEach(function(s){ if(s.department !== currentDept) taken[s.department] = true; });
    var allowed = planDepartments();
    var available = DEPARTMENTS.filter(function(d){ return (!taken[d.key] && allowed.indexOf(d.key) !== -1) || d.key === currentDept; });
    selectEl.innerHTML = available.map(function(d){ return '<option value="'+d.key+'"'+(d.key===currentDept?' selected':'')+'>'+d.label+'</option>'; }).join('');
  }
  document.getElementById('openStaffModalBtn').addEventListener('click', function(){
    var tenantStaff = currentTenantStaff();
    var available = openDepartments(tenantStaff);
    if(available.length === 0){
      showToast('All departments are staffed — remove one to add another.', 'error');
      return;
    }
    var deptSelect = document.getElementById('staffDepartment');
    deptSelect.innerHTML = available.map(function(d){ return '<option value="'+d.key+'">'+d.label+'</option>'; }).join('');
    document.getElementById('staffError').classList.remove('show');
    staffModalScrim.classList.add('show');
    document.getElementById('staffName').focus();
  });
  document.getElementById('openPromoModalBtn').addEventListener('click', function(){
    document.getElementById('promoAddError').classList.remove('show');
    promoModalScrim.classList.add('show');
    document.getElementById('promoCode').focus();
  });
  document.getElementById('editNameBtn').addEventListener('click', function(e){
    e.stopPropagation();
    var isAdmin = state.session.role === 'admin';
    var account = getCurrentAccount();
    document.getElementById('editNameAdminFields').style.display = isAdmin ? 'grid' : 'none';
    document.getElementById('editNameStaffField').style.display = isAdmin ? 'none' : 'block';
    document.getElementById('editNameError').classList.remove('show');
    if(isAdmin){
      document.getElementById('editFirstName').value = (account && account.firstName) || '';
      document.getElementById('editLastName').value = (account && account.lastName) || '';
    } else {
      document.getElementById('editStaffName').value = (account && account.name) || '';
    }
    editNameModalScrim.classList.add('show');
    document.getElementById(isAdmin ? 'editFirstName' : 'editStaffName').focus();
  });
  document.getElementById('saveNameBtn').addEventListener('click', function(){
    var btn = this;
    var isAdmin = state.session.role === 'admin';
    var err = document.getElementById('editNameError');

    var savePromise;
    if(isAdmin){
      var firstName = document.getElementById('editFirstName').value.trim();
      var lastName = document.getElementById('editLastName').value.trim();
      if(!firstName){ err.textContent = 'Enter a first name.'; err.classList.add('show'); return; }
      if(!lastName){ err.textContent = 'Enter a last name.'; err.classList.add('show'); return; }
      err.classList.remove('show');
      savePromise = api.updateAdminProfile(firstName, lastName, state.session.photo || null);
    } else {
      var staffName = document.getElementById('editStaffName').value.trim();
      if(!staffName){ err.textContent = 'Enter a name.'; err.classList.add('show'); return; }
      err.classList.remove('show');
      savePromise = api.updateStaffProfile(staffName, state.session.photo || null);
    }
    setBtnLoading(btn, true, 'Saving…');
    savePromise.then(function(updated){
      state.session.firstName = updated.firstName;
      state.session.lastName = updated.lastName;
      state.session.name = updated.name;
      state.session.photo = updated.photo || null;
      setBtnLoading(btn, false, null, 'Save');
      editNameModalScrim.classList.remove('show');
      showToast('Name updated');
      renderSessionPill();
    }).catch(function(e){
      setBtnLoading(btn, false, null, 'Save');
      err.textContent = e.message; err.classList.add('show');
    });
  });

  // ================= TABS =================
  // Puts the given table's saved order on screen (customer info, items, promo, payment method)
  // WITHOUT touching any other table's data. Only reading/writing state.tables[id].
  function selectTable(id){
    state.currentTableId = String(id);
    renderSelectedTableUI();
    // Refresh from the server in the background — if the user has already
    // switched to a different table by the time this resolves, ignore it.
    fetchTablesFromServer().then(function(){
      if(state.currentTableId === String(id)) renderSelectedTableUI();
    }).catch(function(){});
  }
  function renderSelectedTableUI(){
    var id = state.currentTableId;
    var t = getTable(id);
    document.getElementById('custName').value = t.customerName || '';
    document.getElementById('custPhone').value = t.customerPhone || '';
    document.querySelectorAll('.pm-btn').forEach(function(b){ b.classList.toggle('active', b.dataset.method === (t.paymentMethod || 'Cash')); });
    document.getElementById('billingError').classList.remove('show');
    document.getElementById('promoError').classList.remove('show');
    document.getElementById('promoCodeInput').value = '';
    var titleEl = document.getElementById('billingHeadTitle');
    var eyebrowEl = document.getElementById('billingHeadEyebrow');
    if(titleEl) titleEl.textContent = 'Table ' + id + ' — ' + (t.status === 'active' ? 'Active order' : 'New bill');
    if(eyebrowEl) eyebrowEl.textContent = 'Staff · Table ' + id;
    renderTicket();
  }
  function switchTab(name){
    document.querySelectorAll('.nav-tab').forEach(function(b){ b.classList.toggle('active', b.dataset.tab === name); });
    document.querySelectorAll('.nav-group').forEach(function(g){
      var isActiveGroup = !!g.querySelector('.nav-tab.active');
      g.classList.toggle('active', isActiveGroup);
      if(isActiveGroup) g.classList.add('expanded');
    });
    var tableMatch = /^table-(\d+)$/.exec(name);
    var sectionKey = tableMatch ? 'billing' : name;
    document.querySelectorAll('.section').forEach(function(s){ s.classList.toggle('active', s.dataset.section === sectionKey); });
    var meta = tableMatch ? { crumb:'Staff', title:'Table ' + tableMatch[1] } : SECTION_META[name];
    if(meta && state.session.role === 'staff' && meta.crumb && meta.crumb.indexOf('Admin') === 0){
      meta = { crumb: meta.crumb.replace('Admin', 'Staff'), title: meta.title };
    }
    if(meta){
      document.getElementById('topbarCrumb').textContent = meta.crumb;
      document.getElementById('topbarTitle').textContent = meta.title;
    }
    if(tableMatch) selectTable(tableMatch[1]);
    closeMobileSidebar();
    if(name === 'dashboard') renderDashboard();
    if(name === 'ai-assistant') scrollAiChatToBottom();
    if(name === 'analysis') renderSalesAnalysis();
    if(name === 'room-booking'){ renderRoomTicket(); renderRoomBookingPage(); }
    if(name === 'room-setup') renderRoomSetup();
    if(name === 'room-availability') renderRoomAvailability();
    if(name === 'room-history') renderRoomHistory();
    if(name === 'banquet-setup') renderBanquetSetup();
    if(name === 'banquet-availability') renderBanquetAvailability();
    if(name === 'banquet-history') renderBanquetHistory();
    if(name === 'banquet-booking') renderBanquetBookingPage();
    if(name === 'table-setup'){ fetchTablesFromServer().then(renderTableStatusGrid); renderTableStatusGrid(); }
  }
  function renderNavChildren(children){
    var html = '';
    children.forEach(function(c){
      if(c.children){
        html += '<div class="nav-group nested">'
          + '<button type="button" class="nav-group-label" data-group-toggle><span class="lbl">'+c.label+'</span><span class="chev"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></span></button>'
          + renderNavChildren(c.children)
          + '</div>';
      } else {
        html += '<button class="nav-tab nav-subtab" data-tab="'+c.key+'">'+c.label+'</button>';
      }
    });
    return html;
  }
  function renderNav(){
    var tabs = state.session.role === 'admin' ? visibleAdminTabs() : buildStaffTabsForSession();
    var wrap = document.getElementById('navTabs');
    var html = '';
    tabs.forEach(function(t, i){
      if(t.children){
        html += '<div class="nav-group">'
          + '<button type="button" class="nav-group-label" data-group-toggle><span class="ico">'+ICONS[t.icon]+'</span><span class="lbl">'+t.label+'</span><span class="chev"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></span></button>'
          + renderNavChildren(t.children)
          + '</div>';
      } else {
        html += '<button class="nav-tab'+(i===0?' active':'')+'" data-tab="'+t.key+'"><span class="ico">'+ICONS[t.icon]+'</span><span class="lbl">'+t.label+'</span>'
          + (t.isTable ? '<span class="table-status-dot" data-table-badge="'+t.tableId+'" title="Active / available"></span>' : '')
          + '</button>';
      }
    });
    wrap.innerHTML = html;
    wrap.querySelectorAll('.nav-tab').forEach(function(b){
      b.addEventListener('click', function(){ switchTab(b.dataset.tab); });
    });
    wrap.querySelectorAll('[data-group-toggle]').forEach(function(b){
      b.addEventListener('click', function(){
        b.closest('.nav-group').classList.toggle('expanded');
      });
    });
    switchTab(tabs[0].children ? tabs[0].children[0].key : tabs[0].key);
    updateTableNavBadges();
  }

  function getCurrentAccount(){
    if(!state.session) return null;
    return { firstName: state.session.firstName, lastName: state.session.lastName, name: state.session.name, email: state.session.email, photo: state.session.photo };
  }
  // Removed persistCurrentAccount() — name/photo now save via the API
  // (see saveNameBtn, profilePhotoInput, removePhotoBtn handlers below).
  function avatarInnerHtml(photo, initial){
    return photo ? '<img src="'+photo+'" alt="Profile photo">' : escapeHtml(initial);
  }
  function renderSessionPill(){
    var isAdmin = state.session.role === 'admin';
    var account = getCurrentAccount();
    var fullName = '';
    if(isAdmin && account && (account.firstName || account.lastName)){
      fullName = ((account.firstName||'') + ' ' + (account.lastName||'')).trim();
    } else if(!isAdmin && account && account.name){
      fullName = account.name;
    }
    var label = fullName || (isAdmin ? (state.session.email || 'Admin') : (state.session.name || state.session.staffId));
    var initial = (label || 'A').trim().charAt(0).toUpperCase() || 'A';
    var photo = account && account.photo ? account.photo : null;
    document.getElementById('profileAvatar').innerHTML = avatarInnerHtml(photo, initial);
    document.getElementById('profileAvatarLg').innerHTML = avatarInnerHtml(photo, initial);
    document.getElementById('profileRoleLabel').textContent = fullName ? fullName.split(' ')[0] : (isAdmin ? 'Admin' : 'Staff');
    document.getElementById('profileDropName').textContent = label;
    document.getElementById('profileDropRole').textContent = isAdmin ? (account && account.email ? account.email : 'Administrator') : 'Staff member';
    document.getElementById('removePhotoBtn').style.display = photo ? 'inline' : 'none';
  }
  document.getElementById('profileBtn').addEventListener('click', function(e){
    e.stopPropagation();
    document.getElementById('profileDropdown').classList.toggle('show');
  });
  document.addEventListener('click', function(){ document.getElementById('profileDropdown').classList.remove('show'); });
  document.getElementById('notifBtn').addEventListener('click', function(e){
    e.stopPropagation();
    var dropdown = document.getElementById('notifDropdown');
    dropdown.classList.toggle('show');
    if(dropdown.classList.contains('show')){
      var updatedEl = document.getElementById('notifUpdatedAt');
      if(updatedEl && typeof relativeTimeLabel === 'function') updatedEl.textContent = relativeTimeLabel(notifLastUpdated);
    }
  });
  document.addEventListener('click', function(){ document.getElementById('notifDropdown').classList.remove('show'); });
  document.getElementById('themeToggleRow').addEventListener('click', function(e){
    e.stopPropagation();
    toggleTheme();
  });

  // ---------- global search ----------
  var SEARCH_ICONS = {
    page:'<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/></svg>',
    room:'<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21V8l9-5 9 5v13"/><path d="M9 21v-7h6v7"/></svg>',
    staff:'<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
    menu:'<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2v7c0 1.1.9 2 2 2h2a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M17 2v9c-2 0-3 1-3 3v8"/></svg>',
    hall:'<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18"/><path d="M5 21V7l7-4 7 4v14"/><line x1="9" y1="21" x2="9" y2="12"/><line x1="15" y1="21" x2="15" y2="12"/></svg>',
    promo:'<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m20.59 13.41-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82Z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>',
    invoice:'<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>'
  };
  function flattenTabsForSearch(list, out){
    out = out || [];
    (list || []).forEach(function(t){
      if(t.children) flattenTabsForSearch(t.children, out);
      else out.push(t);
    });
    return out;
  }
  function buildSearchGroups(query){
    var q = query.trim().toLowerCase();
    if(!q) return [];
    var groups = [];
    var isAdmin = state.session && state.session.role === 'admin';
    var tabs = isAdmin ? visibleAdminTabs() : (state.session ? buildStaffTabsForSession() : []);
    var pageHits = flattenTabsForSearch(tabs).filter(function(t){
      return t.label.toLowerCase().indexOf(q) !== -1;
    }).slice(0, 6).map(function(t){
      return { icon:'page', label:t.label, sub:'Page', go:function(){ switchTab(t.key); } };
    });
    if(pageHits.length) groups.push({ label:'Pages', items:pageHits });

    if(isAdmin){
      var roomHits = (state.rooms || []).filter(function(r){
        var guest = r.booking ? (r.booking.guestName || '') : '';
        return String(r.roomNo).indexOf(q) !== -1 || guest.toLowerCase().indexOf(q) !== -1;
      }).slice(0, 6).map(function(r){
        return { icon:'room', label:'Room ' + r.roomNo, sub: r.booking ? ('Occupied · ' + r.booking.guestName) : 'Available', go:function(){ switchTab('room-availability'); } };
      });
      if(roomHits.length) groups.push({ label:'Rooms', items:roomHits });

      var staffHits = (state.staff || []).filter(function(s){
        return (s.name || '').toLowerCase().indexOf(q) !== -1 || (s.staffId || '').toLowerCase().indexOf(q) !== -1 || (s.department || '').toLowerCase().indexOf(q) !== -1;
      }).slice(0, 6).map(function(s){
        return { icon:'staff', label:s.name, sub:(s.department ? s.department.charAt(0).toUpperCase() + s.department.slice(1) + ' · ' : '') + s.staffId, go:function(){ switchTab('staff'); } };
      });
      if(staffHits.length) groups.push({ label:'Staff', items:staffHits });

      var menuHits = (state.menu || []).filter(function(m){
        return !m.deletedAt && ((m.name || '').toLowerCase().indexOf(q) !== -1 || (m.category || '').toLowerCase().indexOf(q) !== -1);
      }).slice(0, 6).map(function(m){
        return { icon:'menu', label:m.name, sub:m.category || 'Menu item', go:function(){ switchTab('menu'); } };
      });
      if(menuHits.length) groups.push({ label:'Menu items', items:menuHits });

      var hallHits = (state.banquetHalls || []).filter(function(h){
        return (h.name || '').toLowerCase().indexOf(q) !== -1;
      }).slice(0, 6).map(function(h){
        return { icon:'hall', label:h.name, sub:'Banquet hall', go:function(){ switchTab('banquet-availability'); } };
      });
      if(hallHits.length) groups.push({ label:'Banquet halls', items:hallHits });

      var promoHits = (state.promoCodes || []).filter(function(p){
        return (p.code || '').toLowerCase().indexOf(q) !== -1;
      }).slice(0, 6).map(function(p){
        return { icon:'promo', label:p.code, sub:'Promo code', go:function(){ switchTab('promos'); } };
      });
      if(promoHits.length) groups.push({ label:'Promo codes', items:promoHits });

      var invHits = (state.invoices || []).filter(function(i){
        return (i.invoiceNo || '').toLowerCase().indexOf(q) !== -1 || (i.customerName || '').toLowerCase().indexOf(q) !== -1;
      }).slice(0, 6).map(function(i){
        return { icon:'invoice', label:i.invoiceNo, sub:i.customerName || 'Invoice', go:function(){ switchTab('history'); } };
      });
      if(invHits.length) groups.push({ label:'Invoices', items:invHits });
    }
    return groups;
  }
  function renderSearchResults(query){
    var wrap = document.getElementById('globalSearchResults');
    var groups = buildSearchGroups(query);
    if(!query.trim()){
      wrap.innerHTML = '';
      wrap.classList.remove('show');
      return;
    }
    if(!groups.length){
      wrap.innerHTML = '<p class="search-empty">No matches for "' + escapeHtml(query.trim()) + '"</p>';
      wrap.classList.add('show');
      return;
    }
    var html = '';
    groups.forEach(function(g){
      html += '<p class="search-group-label">' + escapeHtml(g.label) + '</p>';
      g.items.forEach(function(it, i){
        html += '<button type="button" class="search-result-item" data-gidx="' + groups.indexOf(g) + '" data-iidx="' + i + '">'
          + '<span class="sri-ico">' + (SEARCH_ICONS[it.icon] || SEARCH_ICONS.page) + '</span>'
          + '<span class="sri-label">' + escapeHtml(it.label) + '</span>'
          + '<span class="sri-sub">' + escapeHtml(it.sub) + '</span>'
          + '</button>';
      });
    });
    wrap.innerHTML = html;
    wrap.classList.add('show');
    Array.prototype.forEach.call(wrap.querySelectorAll('.search-result-item'), function(btn, idx){
      btn.addEventListener('click', function(){
        var g = groups[parseInt(btn.dataset.gidx, 10)];
        var it = g.items[parseInt(btn.dataset.iidx, 10)];
        it.go();
        closeGlobalSearch();
      });
    });
  }
  function closeGlobalSearch(){
    var input = document.getElementById('globalSearchInput');
    var wrap = document.getElementById('globalSearchResults');
    input.value = '';
    document.getElementById('topbarSearchBox').classList.remove('has-value');
    wrap.innerHTML = '';
    wrap.classList.remove('show');
    document.getElementById('topbarSearch').classList.remove('mobile-open');
  }
  var globalSearchInput = document.getElementById('globalSearchInput');
  globalSearchInput.addEventListener('input', function(){
    document.getElementById('topbarSearchBox').classList.toggle('has-value', !!this.value);
    renderSearchResults(this.value);
  });
  globalSearchInput.addEventListener('focus', function(){
    if(this.value.trim()) renderSearchResults(this.value);
  });
  globalSearchInput.addEventListener('click', function(e){ e.stopPropagation(); });
  document.getElementById('globalSearchResults').addEventListener('click', function(e){ e.stopPropagation(); });
  document.getElementById('globalSearchClear').addEventListener('click', function(e){
    e.stopPropagation();
    closeGlobalSearch();
    globalSearchInput.focus();
  });
  document.getElementById('searchToggleBtn').addEventListener('click', function(e){
    e.stopPropagation();
    document.getElementById('topbarSearch').classList.add('mobile-open');
    globalSearchInput.focus();
  });
  document.addEventListener('click', function(){ closeGlobalSearch(); });
  document.addEventListener('keydown', function(e){
    var isCombo = (e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K');
    if(isCombo){
      e.preventDefault();
      document.getElementById('topbarSearch').classList.add('mobile-open');
      globalSearchInput.focus();
      globalSearchInput.select();
      return;
    }
    if(e.key === 'Escape' && document.activeElement === globalSearchInput){
      closeGlobalSearch();
      globalSearchInput.blur();
    }
  });

  // ---------- profile photo ----------
  var profilePhotoInput = document.getElementById('profilePhotoInput');
  document.getElementById('pdAvatarWrap').addEventListener('click', function(e){
    e.stopPropagation();
    profilePhotoInput.click();
  });
  profilePhotoInput.addEventListener('click', function(e){ e.stopPropagation(); });
  profilePhotoInput.addEventListener('change', function(){
    var file = profilePhotoInput.files && profilePhotoInput.files[0];
    profilePhotoInput.value = '';
    if(!file) return;
    if(!file.type || file.type.indexOf('image/') !== 0){ showToast('Please choose an image file.', 'error'); return; }
    if(file.size > 8 * 1024 * 1024){ showToast('That image is too large — choose one under 8MB.', 'error'); return; }
    var reader = new FileReader();
    reader.onload = function(){
      var img = new Image();
      img.onload = function(){
        var size = 160;
        var canvas = document.createElement('canvas');
        canvas.width = size; canvas.height = size;
        var ctx = canvas.getContext('2d');
        var side = Math.min(img.width, img.height);
        var sx = (img.width - side) / 2, sy = (img.height - side) / 2;
        ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
        var dataUrl = canvas.toDataURL('image/jpeg', 0.86);
        var isAdmin = state.session.role === 'admin';
        var savePromise = isAdmin
          ? api.updateAdminProfile(state.session.firstName, state.session.lastName, dataUrl)
          : api.updateStaffProfile(state.session.name, dataUrl);
        savePromise.then(function(updated){
          state.session.photo = updated.photo || null;
          showToast('Profile photo updated');
          renderSessionPill();
        }).catch(function(e){ showToast(e.message, 'error'); });
      };
      img.onerror = function(){ showToast('Could not read that image — try a different file.', 'error'); };
      img.src = reader.result;
    };
    reader.onerror = function(){ showToast('Could not read that image — try a different file.', 'error'); };
    reader.readAsDataURL(file);
  });
  document.getElementById('removePhotoBtn').addEventListener('click', function(e){
    e.stopPropagation();
    if(!state.session.photo) return;
    var isAdmin = state.session.role === 'admin';
    var savePromise = isAdmin
      ? api.updateAdminProfile(state.session.firstName, state.session.lastName, null)
      : api.updateStaffProfile(state.session.name, null);
    savePromise.then(function(updated){
      state.session.photo = updated.photo || null;
      showToast('Profile photo removed');
      renderSessionPill();
    }).catch(function(e){ showToast(e.message, 'error'); });
  });

  // mobile sidebar drawer
  function openMobileSidebar(){
    document.getElementById('sidebarEl').classList.add('mobile-open');
    document.getElementById('sidebarScrim').classList.add('show');
  }
  function closeMobileSidebar(){
    document.getElementById('sidebarEl').classList.remove('mobile-open');
    document.getElementById('sidebarScrim').classList.remove('show');
  }
  document.getElementById('hamburgerBtn').addEventListener('click', openMobileSidebar);
  document.getElementById('sidebarScrim').addEventListener('click', closeMobileSidebar);

  // ================= SUBSCRIPTION PAYWALL (Admin only) =================
  // Called after every successful login/signup/session-restore, in place of
  // calling enterApp() directly. Staff go straight in, unaffected — this only
  // gates the Admin role. The check always hits the server (never trusts
  // anything cached locally), so it can't be bypassed by editing localStorage.
  function proceedAfterLogin(){
    if(!state.session || state.session.role !== 'admin'){
      enterApp();
      return;
    }
    api.getSubscription().then(function(sub){
      if(sub && sub.status === 'active'){
        state.subscription = sub;
        enterApp();
      } else {
        showSubscriptionGate(sub);
      }
    }).catch(function(){
      // Can't confirm status — fail closed (show the paywall) rather than
      // risk letting someone into the dashboard on a network hiccup.
      showSubscriptionGate(null);
    });
  }
  // Shows a small pill in the topbar (Admin only) with subscription status
  // and renewal date, so it's never a surprise when the paywall reappears.
  function renderSubscriptionBadge(){
    var badge = document.getElementById('subBadge');
    if(!badge) return;
    if(!state.session || state.session.role !== 'admin' || !state.subscription || state.subscription.status !== 'active'){
      badge.style.display = 'none';
      return;
    }
    var expiry = state.subscription.expiry_date ? new Date(state.subscription.expiry_date) : null;
    var dateStr = expiry ? expiry.toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' }) : '—';
    var daysLeft = expiry ? Math.ceil((expiry - new Date()) / 86400000) : null;
    badge.classList.remove('warn', 'danger');
    if(daysLeft !== null && daysLeft <= 14){ badge.classList.add('warn'); }
    badge.innerHTML = '<span class="sb-text">Subscription active · Renews ' + dateStr + '</span>';
    badge.title = daysLeft !== null && daysLeft <= 14
      ? 'Renews ' + dateStr + ' — ' + daysLeft + ' day' + (daysLeft===1?'':'s') + ' left'
      : 'Active — renews ' + dateStr;
    badge.style.display = 'flex';
  }
  document.getElementById('subBadge').addEventListener('click', function(){
    if(!state.subscription) return;
    openSubscriptionDetails();
  });
  // ---------- admin notifications (computed live, nothing stored server-side) ----------
  // Recomputed from scratch every refresh — today's check-ins/check-outs,
  // today's banquet events, bookings with an outstanding balance, and a
  // subscription renewal warning. Admin-only; staff never see this bell.
  var notifIntervalStarted = false;
  var notifLastUpdated = null;
  var notifPreviousTexts = null; // null = no baseline yet, so we never desktop-alert on the very first load
  function relativeTimeLabel(date){
    if(!date) return '';
    var mins = Math.round((Date.now() - date.getTime()) / 60000);
    if(mins < 1) return 'Updated just now';
    if(mins === 1) return 'Updated 1 min ago';
    if(mins < 60) return 'Updated ' + mins + ' mins ago';
    return 'Updated at ' + date.getHours() + ':' + String(date.getMinutes()).padStart(2,'0');
  }
  function refreshNotifications(manual){
    if(!state.session || state.session.role !== 'admin') return Promise.resolve();
    var refreshBtn = document.getElementById('notifRefreshBtn');
    if(manual && refreshBtn) refreshBtn.classList.add('spinning');
    var planDepts = (state.subscription && state.subscription.departments) || ['room','banquet','restaurant'];
    var fetchRoom = planDepts.indexOf('room') !== -1 ? api.getRoomBookings().catch(function(){ return []; }) : Promise.resolve([]);
    var fetchBanquet = planDepts.indexOf('banquet') !== -1 ? api.getBanquetBookings().catch(function(){ return []; }) : Promise.resolve([]);
    return Promise.all([fetchRoom, fetchBanquet]).then(function(results){
      var roomBookings = results[0] || [], banquetBookings = results[1] || [];
      var today = localDateStr(new Date());
      var items = [];

      var checkInsToday = roomBookings.filter(function(b){ return b.check_in && localDateStr(new Date(b.check_in)) === today; });
      if(checkInsToday.length) items.push({ icon:'room', text: checkInsToday.length + ' room check-in' + (checkInsToday.length===1?'':'s') + ' today', tab:'room-availability' });

      var checkOutsDue = roomBookings.filter(function(b){ return b.status === 'active' && b.check_out && localDateStr(new Date(b.check_out)) === today; });
      if(checkOutsDue.length) items.push({ icon:'room', text: checkOutsDue.length + ' room check-out' + (checkOutsDue.length===1?'':'s') + ' due today', tab:'room-availability' });

      var pendingRoomBalance = roomBookings.filter(function(b){ return b.status === 'active' && !b.balance_paid && Number(b.advance_amount) > 0; });
      if(pendingRoomBalance.length) items.push({ icon:'billing', text: pendingRoomBalance.length + ' room guest' + (pendingRoomBalance.length===1?'':'s') + ' with a balance due', tab:'room-availability', warn:true });

      var banquetToday = banquetBookings.filter(function(b){ return b.status !== 'cancelled' && b.start_at && localDateStr(new Date(b.start_at)) === today; });
      if(banquetToday.length) items.push({ icon:'banquet', text: banquetToday.length + ' banquet event' + (banquetToday.length===1?'':'s') + ' today', tab:'banquet-availability' });

      var pendingBanquetBalance = banquetBookings.filter(function(b){ return b.status !== 'cancelled' && !b.balance_paid && Number(b.advance_amount) > 0; });
      if(pendingBanquetBalance.length) items.push({ icon:'billing', text: pendingBanquetBalance.length + ' banquet booking' + (pendingBanquetBalance.length===1?'':'s') + ' with a balance due', tab:'banquet-availability', warn:true });

      var sub = state.subscription;
      if(sub && sub.status === 'active' && sub.expiry_date){
        var daysLeft = Math.ceil((new Date(sub.expiry_date) - new Date()) / 86400000);
        if(daysLeft <= 14) items.push({ icon:'warn', text: 'Subscription renews in ' + daysLeft + ' day' + (daysLeft===1?'':'s'), action:'subscription', warn:true });
      }

      // Desktop alert only for items that are genuinely NEW since the last
      // poll — never on the very first load (that would dump every existing
      // alert on someone the moment they enable it), and never re-alert for
      // something that was already showing last time.
      if(window.Notification && Notification.permission === 'granted' && notifPreviousTexts !== null){
        var newTexts = items.map(function(i){ return i.text; }).filter(function(t){ return notifPreviousTexts.indexOf(t) === -1; });
        newTexts.forEach(function(t){
          try { new Notification('Eazzio — Hotel Management', { body: t, tag: t }); } catch(e){}
        });
      }
      notifPreviousTexts = items.map(function(i){ return i.text; });
      notifLastUpdated = new Date();
      renderNotificationList(items);
      if(manual && refreshBtn) refreshBtn.classList.remove('spinning');
    });
  }
  function renderNotifFooter(){
    var footer = document.getElementById('notifFooter');
    if(!window.Notification){ footer.innerHTML = ''; return; }
    if(Notification.permission === 'granted'){
      footer.innerHTML = '<span class="muted">🔔 Desktop alerts are on</span>';
    } else if(Notification.permission === 'denied'){
      footer.innerHTML = '<span class="muted">Desktop alerts are blocked in your browser settings.</span>';
    } else {
      footer.innerHTML = '<button type="button" id="notifEnableDesktopBtn">Enable desktop alerts</button>';
      var btn = document.getElementById('notifEnableDesktopBtn');
      if(btn) btn.addEventListener('click', function(e){
        e.stopPropagation();
        Notification.requestPermission().then(function(){ renderNotifFooter(); });
      });
    }
  }
  function renderNotificationList(items){
    var dot = document.getElementById('notifDot');
    var list = document.getElementById('notifList');
    var updatedEl = document.getElementById('notifUpdatedAt');
    if(updatedEl) updatedEl.textContent = relativeTimeLabel(notifLastUpdated);
    renderNotifFooter();
    if(items.length === 0){
      dot.style.display = 'none';
      list.innerHTML = '<div class="notif-empty">You\'re all caught up.</div>';
      return;
    }
    dot.style.display = 'flex';
    dot.textContent = String(items.length);
    var warnSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
    list.innerHTML = items.map(function(item, idx){
      var iconSvg = item.icon === 'warn' ? warnSvg : (ICONS[item.icon] || warnSvg);
      return '<button type="button" class="notif-row" data-notif-idx="' + idx + '">'
        + '<span class="notif-row-icon' + (item.warn ? ' warn' : '') + '">' + iconSvg + '</span>'
        + '<span class="notif-row-text">' + escapeHtml(item.text) + '</span>'
        + '</button>';
    }).join('');
    list.querySelectorAll('[data-notif-idx]').forEach(function(btn){
      btn.addEventListener('click', function(){
        var item = items[parseInt(btn.dataset.notifIdx, 10)];
        document.getElementById('notifDropdown').classList.remove('show');
        if(item.action === 'subscription'){ openSubscriptionDetails(); }
        else if(item.tab){ switchTab(item.tab); }
      });
    });
  }
  document.getElementById('notifRefreshBtn').addEventListener('click', function(e){
    e.stopPropagation();
    refreshNotifications(true);
  });
  function startNotificationPolling(){
    if(notifIntervalStarted) return;
    notifIntervalStarted = true;
    setInterval(refreshNotifications, 60000); // every minute — this is a convenience bell, not a live feed
  }

  // ---------- AI Hotel Assistant (Premium) ----------
  // Conversation lives only in this array for the current browser session —
  // never persisted, matches the spec ("session-level memory, no permanent
  // storage of conversations"). Cleared on logout via resetTenantState-style
  // reset isn't needed since a full page reload already clears it.
  var aiChatHistory = [];
  var aiChatPending = false;
  function scrollAiChatToBottom(){
    var wrap = document.getElementById('aiChatMessages');
    if(wrap) wrap.scrollTop = wrap.scrollHeight;
  }
  function appendAiMessage(role, text, metrics){
    var wrap = document.getElementById('aiChatMessages');
    var empty = document.getElementById('aiChatEmpty');
    if(empty) empty.style.display = 'none';
    var el = document.createElement('div');
    el.className = 'ai-msg ' + role;
    el.textContent = text;
    if(metrics && metrics.length){
      var metricsWrap = document.createElement('div');
      metricsWrap.className = 'ai-msg-metrics';
      metrics.forEach(function(m){
        var chip = document.createElement('div');
        chip.className = 'ai-msg-metric';
        chip.innerHTML = '<b>' + escapeHtml(String(m.value)) + '</b>' + escapeHtml(m.label);
        metricsWrap.appendChild(chip);
      });
      el.appendChild(metricsWrap);
    }
    wrap.appendChild(el);
    scrollAiChatToBottom();
    return el;
  }
  function sendAiMessage(text){
    text = (text || '').trim();
    if(!text || aiChatPending) return;
    var input = document.getElementById('aiChatInput');
    var sendBtn = document.getElementById('aiChatSendBtn');
    var errEl = document.getElementById('aiChatError');
    errEl.classList.remove('show');
    appendAiMessage('user', text);
    input.value = '';
    aiChatPending = true;
    sendBtn.disabled = true;
    var pendingEl = appendAiMessage('assistant pending', 'Thinking…');
    api.askAiAssistant(text, aiChatHistory).then(function(res){
      pendingEl.remove();
      if(!res || !res.success){
        errEl.textContent = (res && res.error) || 'Something went wrong. Please try again.';
        errEl.classList.add('show');
        return;
      }
      appendAiMessage('assistant', res.answer, res.metrics);
      aiChatHistory.push({ role:'user', text: text });
      aiChatHistory.push({ role:'assistant', text: res.answer });
    }).catch(function(e){
      pendingEl.remove();
      errEl.textContent = e.message || 'Something went wrong. Please try again.';
      errEl.classList.add('show');
    }).finally(function(){
      aiChatPending = false;
      sendBtn.disabled = false;
    });
  }
  document.getElementById('aiChatSendBtn').addEventListener('click', function(){
    sendAiMessage(document.getElementById('aiChatInput').value);
  });
  document.getElementById('aiChatInput').addEventListener('keydown', function(e){
    if(e.key === 'Enter'){ e.preventDefault(); sendAiMessage(this.value); }
  });
  document.querySelectorAll('[data-ai-q]').forEach(function(chip){
    chip.addEventListener('click', function(){ sendAiMessage(chip.getAttribute('data-ai-q')); });
  });

  function openSubscriptionDetails(){
    var sub = state.subscription;
    var body = document.getElementById('subDetailsBody');
    var renewBtn = document.getElementById('subDetailsRenewBtn');
    if(!sub){
      body.innerHTML = '<p class="hint" style="margin:0;">No subscription found yet.</p>';
      renewBtn.style.display = 'none';
      document.getElementById('subDetailsScrim').classList.add('show');
      return;
    }
    var start = sub.start_date ? new Date(sub.start_date) : null;
    var expiry = sub.expiry_date ? new Date(sub.expiry_date) : null;
    var fmt = function(d){ return d ? d.toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' }) : '—'; };
    var isActive = sub.status === 'active';
    var isExpired = sub.status === 'expired' || (isActive && expiry && expiry < new Date());
    var statusLabel = isExpired ? 'Expired' : (sub.status === 'pending' ? 'Payment pending' : (isActive ? 'Active' : 'Not subscribed'));
    var statusClass = isExpired ? 'danger' : (sub.status === 'pending' ? 'warn' : (isActive ? 'success' : 'info'));
    var daysLeft = (isActive && !isExpired && expiry) ? Math.ceil((expiry - new Date()) / 86400000) : null;

    var payMethod = sub.payment_provider === 'razorpay' ? 'Razorpay'
      : sub.payment_provider === 'promo' ? 'Promo code (no charge)'
      : sub.payment_provider ? sub.payment_provider : '—';

    var rows = [];
    rows.push(['Status', '<span class="badge ' + statusClass + '">' + statusLabel + '</span>']);
    rows.push(['Plan', escapeHtml(sub.planLabel || sub.plan_name || 'Standard Plan')]);
    rows.push(['Departments', escapeHtml((sub.departments || []).map(departmentLabel).join(', ') || '—')]);
    rows.push(['Amount', money(Number(sub.baseAmount != null ? sub.baseAmount : sub.amount)) + ' + ' + Math.round((sub.gstRate||0)*100) + '% GST (' + money(sub.gstAmount||0) + ') = <b>' + money(sub.totalAmount||sub.amount) + '</b>']);
    if(start) rows.push(['Subscribed since', fmt(start)]);
    if(isActive && expiry) rows.push([isExpired ? 'Expired on' : 'Renews on', fmt(expiry) + (daysLeft !== null ? ' <span style="color:var(--text-muted);font-size:12px;">(' + daysLeft + ' day' + (daysLeft===1?'':'s') + ' left)</span>' : '')]);
    rows.push(['Payment method', escapeHtml(payMethod)]);
    if(sub.payment_id) rows.push(['Payment ID', '<span style="font-family:\'IBM Plex Mono\',monospace;font-size:12.5px;">' + escapeHtml(sub.payment_id) + '</span>']);
    if(sub.promo_code_used) rows.push(['Promo code used', '<span style="font-family:\'IBM Plex Mono\',monospace;font-size:12.5px;">' + escapeHtml(sub.promo_code_used) + '</span>']);

    body.innerHTML = rows.map(function(r){
      return '<div class="sd-row"><span class="sd-label">' + r[0] + '</span><span class="sd-value">' + r[1] + '</span></div>';
    }).join('')
    + (isActive && !isExpired
        ? '<p class="hint" style="margin:16px 0 0;">This is your only active subscription record — a fresh history of past renewals will start building here from your next renewal onward.</p>'
        : '');

    var canUpgrade = isActive && !isExpired && (sub.departments || []).length < 3;
    renewBtn.textContent = (!isActive || isExpired) ? 'Renew Now' : 'Upgrade Plan';
    renewBtn.style.display = (!isActive || isExpired || canUpgrade) ? 'inline-flex' : 'none';
    document.getElementById('subDetailsScrim').classList.add('show');
  }
  document.getElementById('subDetailsClose').addEventListener('click', function(){
    document.getElementById('subDetailsScrim').classList.remove('show');
  });
  document.getElementById('subDetailsDone').addEventListener('click', function(){
    document.getElementById('subDetailsScrim').classList.remove('show');
  });
  document.getElementById('subDetailsRenewBtn').addEventListener('click', function(){
    document.getElementById('subDetailsScrim').classList.remove('show');
    showSubscriptionGate(state.subscription);
  });
  function signOutToLogin(){
    state.session = null;
    api.logout();
    document.getElementById('subscriptionGate').classList.remove('show');
    document.getElementById('appLayout').classList.remove('show');
    document.getElementById('gateScreen').style.display = 'flex';
    resetGateToDefault();
    document.getElementById('loginEmail').value = '';
    document.getElementById('loginPassword').value = '';
    document.getElementById('staffLoginId').value = '';
    document.getElementById('staffLoginPassword').value = '';
  }
  // ---------- plan picker state (paywall) ----------
  var subGatePlans = [];        // [{planType,name,departments,baseAmount,gstAmount,totalAmount}, ...] from GET /subscription/plans
  var selectedPlanType = null;  // which card is currently selected
  var subGateIsUpgrade = false; // true when the admin already has an active plan and this is an upgrade, not a fresh subscribe

  function planIsUpgradeOver(currentDepartments, candidateDepartments, currentFeatures, candidateFeatures){
    currentFeatures = currentFeatures || []; candidateFeatures = candidateFeatures || [];
    var deptsCovered = currentDepartments.every(function(d){ return candidateDepartments.indexOf(d) !== -1; });
    var featsCovered = currentFeatures.every(function(f){ return candidateFeatures.indexOf(f) !== -1; });
    var addsDept = candidateDepartments.some(function(d){ return currentDepartments.indexOf(d) === -1; });
    var addsFeat = candidateFeatures.some(function(f){ return currentFeatures.indexOf(f) === -1; });
    return deptsCovered && featsCovered && (addsDept || addsFeat);
  }
  function renderSubGatePlanCards(sub){
    var list = document.getElementById('subGatePlanList');
    var isActive = sub && sub.status === 'active';
    subGateIsUpgrade = !!isActive;
    var selectable = subGatePlans.filter(function(p){
      if(!isActive) return true; // fresh subscribe — all 4 tiers available
      return planIsUpgradeOver(sub.departments || [], p.departments, sub.features || [], p.features); // upgrade — only genuine upgrades
    });
    if(isActive && selectable.length === 0){
      list.innerHTML = '<p class="hint" style="margin:0 0 16px;">You already have full access — every department, Voice Commands, and the AI Assistant. Nothing left to upgrade.</p>';
      document.getElementById('subGateSubscribeBtn').style.display = 'none';
      document.getElementById('subGatePromoToggleBtn').style.display = 'none';
      document.getElementById('subGateGstLine').style.display = 'none';
      selectedPlanType = null;
      return;
    }
    document.getElementById('subGateSubscribeBtn').style.display = '';
    document.getElementById('subGatePromoToggleBtn').style.display = '';
    document.getElementById('subGateGstLine').style.display = '';
    if(!selectedPlanType || !selectable.some(function(p){ return p.planType === selectedPlanType; })){
      selectedPlanType = selectable[0] ? selectable[0].planType : null;
    }
    list.innerHTML = selectable.map(function(p){
      var deptLabels = p.departments.map(departmentLabel).join(' + ');
      var featLabels = (p.features || []).map(function(f){ return f === 'voice' ? '🎤 Voice Commands' : (f === 'ai' ? '🤖 AI Assistant' : f); });
      var isSel = p.planType === selectedPlanType;
      var isPremium = p.planType === 'premium';
      return '<div class="sub-gate-plan-card'+(isSel?' selected':'')+(isPremium?' premium':'')+'" data-plan-type="'+p.planType+'">'
        + (isPremium ? '<span class="sub-gate-plan-card-badge">Premium</span>' : '')
        + '<div class="sub-gate-plan-card-top"><span class="sub-gate-plan-card-name">'+escapeHtml(p.name)+'</span>'
        + '<span class="sub-gate-plan-card-price">'+moneyINR(p.totalAmount)+'/yr</span></div>'
        + '<div class="sub-gate-plan-card-depts">'+escapeHtml(deptLabels)+(featLabels.length ? ' + ' + escapeHtml(featLabels.join(' + ')) : '')+'</div>'
        + '</div>';
    }).join('');
    list.querySelectorAll('.sub-gate-plan-card').forEach(function(card){
      card.addEventListener('click', function(){
        selectedPlanType = card.getAttribute('data-plan-type');
        renderSubGatePlanCards(sub); // re-render to move the "selected" highlight
        updateSubGatePriceDisplay(sub);
      });
    });
    updateSubGatePriceDisplay(sub);
  }
  // Updates the price/GST line and the Subscribe/Upgrade button text for
  // whichever plan card is currently selected. On an upgrade, shows the
  // DIFFERENCE owed (target plan total minus what they already paid for
  // their current plan), matching exactly what the server will charge.
  function updateSubGatePriceDisplay(sub){
    var plan = subGatePlans.find(function(p){ return p.planType === selectedPlanType; });
    var btn = document.getElementById('subGateSubscribeBtn');
    if(!plan){ btn.textContent = 'Select a plan'; return; }
    var payable = plan.totalAmount;
    var label = 'Subscribe for ' + moneyINR(payable) + ' / Year';
    if(subGateIsUpgrade){
      payable = Math.max(0, plan.totalAmount - (sub.totalAmount || 0));
      label = 'Upgrade for ' + moneyINR(payable);
    }
    document.getElementById('subGateGstLine').innerHTML = subGateIsUpgrade
      ? 'Full plan is ' + moneyINR(plan.totalAmount) + '/yr (incl. GST) &nbsp;=&nbsp; <b>' + moneyINR(payable) + ' due now</b>'
      : moneyINR(plan.baseAmount) + ' + 18% GST (' + moneyINR(plan.gstAmount) + ') &nbsp;=&nbsp; <b>' + moneyINR(plan.totalAmount) + ' total</b>';
    btn.textContent = label;
    btn.setAttribute('data-payable', String(payable));
  }
  function showSubscriptionGate(sub){
    document.getElementById('gateScreen').style.display = 'none';
    document.getElementById('appLayout').classList.remove('show');
    appliedPromoCode = null;
    document.getElementById('subGatePromoInput').value = '';
    document.getElementById('subGatePromoWrap').style.display = 'none';
    var promoMsg = document.getElementById('subGatePromoMsg');
    promoMsg.className = 'sub-gate-promo-msg';
    promoMsg.textContent = '';
    var status = sub ? sub.status : 'inactive';
    var eyebrow = document.getElementById('subGateEyebrow');
    var title = document.getElementById('subGateTitle');
    var sub_ = document.getElementById('subGateSub');
    var note = document.getElementById('subGateNote');
    note.textContent = '';
    document.getElementById('subGateError').classList.remove('show');
    document.getElementById('subGatePlanList').innerHTML = '<p class="hint" style="margin:0 0 16px;">Loading plans…</p>';
    if(status === 'expired'){
      eyebrow.textContent = 'Subscription expired';
      title.textContent = 'Your subscription has expired';
      sub_.textContent = 'Renew your annual plan to get back into your dashboard — your data is safe and waiting for you.';
    } else if(status === 'pending'){
      eyebrow.textContent = 'Payment pending';
      title.textContent = 'Finish setting up your subscription';
      sub_.textContent = 'Your last subscription attempt didn\'t complete. Subscribe again to activate full access.';
    } else if(status === 'cancelled'){
      eyebrow.textContent = 'Subscription cancelled';
      title.textContent = 'Reactivate your subscription';
      sub_.textContent = 'Your subscription was cancelled. Subscribe again any time to regain access.';
    } else if(status === 'active'){
      eyebrow.textContent = 'Upgrade your plan';
      title.textContent = 'Add more departments';
      sub_.textContent = 'You\'re only charged the difference — your current expiry date stays the same.';
    } else {
      eyebrow.textContent = 'Subscription required';
      title.textContent = 'Choose your plan';
      sub_.textContent = 'Pick the departments you need — Room + Banquet, Restaurant only, or everything. You can upgrade to Full access any time later.';
    }
    document.getElementById('subscriptionGate').classList.add('show');
    api.getSubscriptionPlans().then(function(plans){
      subGatePlans = plans;
      renderSubGatePlanCards(sub);
    }).catch(function(){
      document.getElementById('subGatePlanList').innerHTML = '<p class="hint" style="margin:0 0 16px;color:var(--danger);">Could not load plans — check your connection and reopen this screen.</p>';
    });
  }
  // Set this to your Razorpay Key ID (the public one — safe in frontend code).
  // Find it in Razorpay Dashboard -> Settings -> API Keys. The Key SECRET goes
  // ONLY in the backend's .env file (RAZORPAY_KEY_SECRET) — never here.
  var RAZORPAY_KEY_ID = 'rzp_live_T30ux1vLXgkLFL';

  var appliedPromoCode = null;
  document.getElementById('subGatePromoToggleBtn').addEventListener('click', function(){
    var wrap = document.getElementById('subGatePromoWrap');
    var isOpen = wrap.style.display !== 'none';
    wrap.style.display = isOpen ? 'none' : 'block';
    if(!isOpen) document.getElementById('subGatePromoInput').focus();
  });
  document.getElementById('subGatePromoApplyBtn').addEventListener('click', function(){
    var btn = this;
    var input = document.getElementById('subGatePromoInput');
    var msg = document.getElementById('subGatePromoMsg');
    var subscribeBtn = document.getElementById('subGateSubscribeBtn');
    var code = input.value.trim();
    if(!code){ return; }
    if(!selectedPlanType){ msg.className = 'sub-gate-promo-msg bad'; msg.textContent = 'Select a plan first.'; return; }
    msg.className = 'sub-gate-promo-msg';
    msg.textContent = '';
    setBtnLoading(btn, true, '…');
    api.validateSubscriptionPromo(code, selectedPlanType).then(function(res){
      setBtnLoading(btn, false, null, 'Apply');
      appliedPromoCode = res.code;
      msg.className = 'sub-gate-promo-msg ok';
      var verb = subGateIsUpgrade ? 'Upgrade' : 'Subscribe';
      if(res.free){
        msg.textContent = '✓ Code applied — ' + res.discountPercent + '% off. This will be FREE.';
        subscribeBtn.textContent = verb + ' for Free';
      } else {
        msg.textContent = '✓ Code applied — ' + res.discountPercent + '% off. New total: ' + money(res.payableAmount);
        subscribeBtn.textContent = verb + ' for ' + money(res.payableAmount);
      }
    }).catch(function(e){
      setBtnLoading(btn, false, null, 'Apply');
      appliedPromoCode = null;
      updateSubGatePriceDisplay(state.subscription);
      msg.className = 'sub-gate-promo-msg bad';
      msg.textContent = e.message;
    });
  });

  // Shown right before the dashboard, after a payment is verified or a
  // 100%-off promo activates the subscription instantly.
  function showSubscriptionSuccess(sub){
    document.getElementById('subscriptionGate').classList.remove('show');
    var expiry = sub && sub.expiry_date ? new Date(sub.expiry_date) : null;
    var dateStr = expiry ? expiry.toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' }) : null;
    document.getElementById('subSuccessMsg').textContent = dateStr
      ? 'Welcome aboard — your ' + (sub.planLabel || sub.plan_name || 'subscription') + ' is now active until ' + dateStr + '.'
      : 'Welcome aboard — your subscription is now active.';
    document.getElementById('subSuccessGate').classList.add('show');
  }
  document.getElementById('subSuccessContinueBtn').addEventListener('click', function(){
    document.getElementById('subSuccessGate').classList.remove('show');
    if(state.session && state.session.role === 'admin'){ enterApp(); } else { proceedAfterLogin(); }
  });

  document.getElementById('subGateSubscribeBtn').addEventListener('click', function(){
    var btn = this;
    var err = document.getElementById('subGateError');
    var note = document.getElementById('subGateNote');
    err.classList.remove('show');
    note.textContent = '';
    if(!selectedPlanType){ err.textContent = 'Select a plan first.'; err.classList.add('show'); return; }
    var originalLabel = btn.textContent;
    setBtnLoading(btn, true, 'Please wait…');
    api.subscribeToPlan(selectedPlanType, appliedPromoCode).then(function(order){
      // A 100%-off promo code activates instantly — no payment to actually make.
      if(order.free){
        setBtnLoading(btn, false, null, originalLabel);
        state.subscription = order;
        showSubscriptionSuccess(order);
        return;
      }
      if(typeof Razorpay === 'undefined'){
        setBtnLoading(btn, false, null, originalLabel);
        err.textContent = 'Payment library failed to load — check your internet connection and try again.';
        err.classList.add('show');
        return;
      }
      setBtnLoading(btn, false, null, originalLabel);
      var rzp = new Razorpay({
        key: order.keyId || RAZORPAY_KEY_ID,
        amount: order.amountPaise,
        currency: order.currency,
        name: 'Hotel Management System',
        description: order.planLabel + (order.isUpgrade ? ' — plan upgrade' : ' — annual subscription'),
        order_id: order.orderId,
        theme: { color: '#d9a441' },
        handler: function(response){
          // Razorpay only calls this after the user actually completes payment.
          // We still don't trust it as "success" until the backend verifies
          // the signature — see api.verifySubscriptionPayment / POST /verify.
          note.textContent = 'Verifying payment…';
          api.verifySubscriptionPayment({
            razorpay_order_id: response.razorpay_order_id,
            razorpay_payment_id: response.razorpay_payment_id,
            razorpay_signature: response.razorpay_signature
          }).then(function(sub){
            note.textContent = '';
            state.subscription = sub;
            showSubscriptionSuccess(sub);
          }).catch(function(e){
            note.textContent = '';
            err.textContent = e.message || 'Payment could not be verified. Please contact support before retrying.';
            err.classList.add('show');
          });
        },
        modal: {
          ondismiss: function(){
            note.textContent = 'Payment window closed — no charge was made.';
          }
        }
      });
      rzp.on('payment.failed', function(resp){
        note.textContent = '';
        err.textContent = 'Payment failed: ' + (resp.error && resp.error.description ? resp.error.description : 'Please try again.');
        err.classList.add('show');
      });
      rzp.open();
    }).catch(function(e){
      setBtnLoading(btn, false, null, originalLabel);
      err.textContent = e.message; err.classList.add('show');
    });
  });
  document.getElementById('subGateCloseBtn').addEventListener('click', signOutToLogin);
  document.getElementById('subGateCancelBtn').addEventListener('click', signOutToLogin);

  function enterApp(){
    document.getElementById('gateScreen').style.display = 'none';
    document.getElementById('appLayout').classList.add('show');
    renderBrandHeader();
    renderSessionPill();
    renderSubscriptionBadge();
    renderNav();
    fillSetupForm();
    renderMenu();
    renderMenuTrash();
    renderItemPicker();
    renderTicket();
    renderHistory();
    renderSalesAnalysis();
    renderStaffList();
    renderPromoList();
    renderDashboard();
    initSidebarToggle();
    initDashboardClock();
    var notifMenu = document.getElementById('notifMenu');
    if(state.session && state.session.role === 'admin'){
      notifMenu.style.display = '';
      refreshNotifications();
      startNotificationPolling();
    } else {
      notifMenu.style.display = 'none';
    }
    document.getElementById('voiceMenu').style.display = window.EazzioApp.isVoiceEnabled() ? '' : 'none';
  }

  // ---------- sidebar collapse/expand ----------
  function initSidebarToggle(){
    var sidebar = document.getElementById('sidebarEl');
    var collapseBtn = document.getElementById('sidebarCollapseBtn');
    var collapsed = window.localStorage.getItem(STORAGE_PREFIX + 'sidebar-collapsed') === '1';
    function apply(){ sidebar.classList.toggle('collapsed', collapsed); }
    apply();
    collapseBtn.onclick = function(){
      collapsed = !collapsed;
      window.localStorage.setItem(STORAGE_PREFIX + 'sidebar-collapsed', collapsed ? '1' : '0');
      apply();
    };
  }

  // ---------- dashboard clock ----------
  // The "Tue, 01 Sept 2026 · 07:43 am" badge only ever got written once,
  // whenever the dashboard happened to re-render — so it froze at whatever
  // time that was and never ticked forward. This keeps it live.
  function updateDashboardClock(){
    var dateBadge = document.getElementById('dashDateBadge');
    if(!dateBadge) return;
    dateBadge.innerHTML = '<span class="db-ico">'+ICONS.history+'</span><span>'+new Date().toLocaleDateString('en-IN',{weekday:'short', day:'2-digit', month:'short', year:'numeric'})+' &nbsp;<b>'+new Date().toLocaleTimeString('en-IN',{hour:'2-digit', minute:'2-digit'})+'</b></span>';
  }
  var dashboardClockInterval = null;
  function initDashboardClock(){
    updateDashboardClock();
    if(dashboardClockInterval) clearInterval(dashboardClockInterval);
    dashboardClockInterval = setInterval(updateDashboardClock, 15000);
  }

  // ---------- brand header ----------
  function renderBrandHeader(){
    var name = state.restaurant.name || 'Your business';
    document.getElementById('brandName').textContent = name;
    var phoneEl = document.getElementById('profileDropPhone');
    if(phoneEl){
      var phone = state.restaurant.phone || '';
      if(phone){
        phoneEl.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg><span>'+escapeHtml(phone)+'</span>';
        phoneEl.style.display = 'flex';
      } else {
        phoneEl.style.display = 'none';
      }
    }
    var emblemIcon = document.getElementById('brandEmblemIcon');
    var emblemImg = document.getElementById('brandEmblemImg');
    if(state.restaurant.logo){
      emblemImg.src = state.restaurant.logo;
      emblemImg.style.display = '';
      emblemIcon.style.display = 'none';
    } else {
      emblemImg.style.display = 'none';
      emblemIcon.style.display = '';
    }
  }

  // ---------- setup ----------
  var setupFields = {
    name: document.getElementById('setName'), phone: document.getElementById('setPhone'),
    email: document.getElementById('setEmail'),
    address: document.getElementById('setAddress'), gstin: document.getElementById('setGstin'),
    taxRate: document.getElementById('setTax'), currency: document.getElementById('setCurrency'),
    invoicePrefix: document.getElementById('setInvoicePrefix'), footer: document.getElementById('setFooter')
  };
  var pendingLogo = undefined; // undefined = unchanged, null = removed, dataURL = new logo
  var pendingStamp = undefined; // same convention as pendingLogo
  var pendingSignature = undefined; // same convention as pendingLogo
  function renderLogoPreview(){
    var preview = document.getElementById('setupLogoPreview');
    var removeBtn = document.getElementById('removeLogoBtn');
    var current = pendingLogo === undefined ? state.restaurant.logo : pendingLogo;
    if(current){
      preview.innerHTML = '<img src="'+current+'" alt="" style="width:100%;height:100%;object-fit:cover;">';
      removeBtn.style.display = '';
    } else {
      preview.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>';
      removeBtn.style.display = 'none';
    }
  }
  function renderImageFieldPreview(previewId, removeBtnId, pendingValue, currentStateValue, placeholderSvg){
    var preview = document.getElementById(previewId);
    var removeBtn = document.getElementById(removeBtnId);
    var current = pendingValue === undefined ? currentStateValue : pendingValue;
    if(current){
      preview.innerHTML = '<img src="'+current+'" alt="" style="width:100%;height:100%;object-fit:contain;">';
      removeBtn.style.display = '';
    } else {
      preview.innerHTML = placeholderSvg;
      removeBtn.style.display = 'none';
    }
  }
  var STAMP_PLACEHOLDER_SVG = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9 12.5l2 2 4-4.5"/></svg>';
  var SIGNATURE_PLACEHOLDER_SVG = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 16c2-4 3 3 5 0s2-6 4-3 2 4 4 1 2-3 3-3"/></svg>';
  function renderStampPreview(){ renderImageFieldPreview('setupStampPreview', 'removeStampBtn', pendingStamp, state.restaurant.stamp, STAMP_PLACEHOLDER_SVG); }
  function renderSignaturePreview(){ renderImageFieldPreview('setupSignaturePreview', 'removeSignatureBtn', pendingSignature, state.restaurant.signature, SIGNATURE_PLACEHOLDER_SVG); }
  function bindImageUploadField(inputId, chooseBtnId, removeBtnId, maxSide, setPending, renderFn){
    document.getElementById(chooseBtnId).addEventListener('click', function(){
      document.getElementById(inputId).click();
    });
    document.getElementById(inputId).addEventListener('change', function(){
      var input = this;
      var file = input.files && input.files[0];
      input.value = '';
      if(!file) return;
      if(!file.type || file.type.indexOf('image/') !== 0){ showToast('Please choose an image file.', 'error'); return; }
      if(file.size > 5 * 1024 * 1024){ showToast('That image is too large — choose one under 5MB.', 'error'); return; }
      var reader = new FileReader();
      reader.onload = function(){
        var img = new Image();
        img.onload = function(){
          var scale = Math.min(1, maxSide / Math.max(img.width, img.height));
          var w = Math.round(img.width * scale), h = Math.round(img.height * scale);
          var canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          canvas.getContext('2d').drawImage(img, 0, 0, w, h);
          setPending(canvas.toDataURL('image/png'));
          renderFn();
        };
        img.onerror = function(){ showToast('Could not read that image — try a different file.', 'error'); };
        img.src = reader.result;
      };
      reader.onerror = function(){ showToast('Could not read that image — try a different file.', 'error'); };
      reader.readAsDataURL(file);
    });
    document.getElementById(removeBtnId).addEventListener('click', function(){
      setPending(null);
      renderFn();
    });
  }
  function fillSetupForm(){
    setupFields.name.value = state.restaurant.name;
    setupFields.phone.value = state.restaurant.phone;
    setupFields.email.value = state.restaurant.email;
    setupFields.address.value = state.restaurant.address;
    setupFields.gstin.value = state.restaurant.gstin;
    setupFields.taxRate.value = state.restaurant.taxRate;
    setupFields.currency.value = state.restaurant.currency;
    setupFields.invoicePrefix.value = state.restaurant.invoicePrefix;
    setupFields.footer.value = state.restaurant.footer;
    var tcInput = document.getElementById('setTableCount');
    if(tcInput) tcInput.value = state.tableCount;
    pendingLogo = undefined;
    renderLogoPreview();
    pendingStamp = undefined;
    renderStampPreview();
    pendingSignature = undefined;
    renderSignaturePreview();
  }
  bindImageUploadField('setupStampInput', 'chooseStampBtn', 'removeStampBtn', 360, function(v){ pendingStamp = v; }, renderStampPreview);
  bindImageUploadField('setupSignatureInput', 'chooseSignatureBtn', 'removeSignatureBtn', 360, function(v){ pendingSignature = v; }, renderSignaturePreview);
  document.getElementById('chooseLogoBtn').addEventListener('click', function(){
    document.getElementById('setupLogoInput').click();
  });
  document.getElementById('setupLogoInput').addEventListener('change', function(){
    var input = this;
    var file = input.files && input.files[0];
    input.value = '';
    if(!file) return;
    if(!file.type || file.type.indexOf('image/') !== 0){ showToast('Please choose an image file.', 'error'); return; }
    if(file.size > 5 * 1024 * 1024){ showToast('That image is too large — choose one under 5MB.', 'error'); return; }
    var reader = new FileReader();
    reader.onload = function(){
      var img = new Image();
      img.onload = function(){
        var maxSide = 360;
        var scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        var w = Math.round(img.width * scale), h = Math.round(img.height * scale);
        var canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        pendingLogo = canvas.toDataURL('image/png');
        renderLogoPreview();
      };
      img.onerror = function(){ showToast('Could not read that image — try a different file.', 'error'); };
      img.src = reader.result;
    };
    reader.onerror = function(){ showToast('Could not read that image — try a different file.', 'error'); };
    reader.readAsDataURL(file);
  });
  document.getElementById('removeLogoBtn').addEventListener('click', function(){
    pendingLogo = null;
    renderLogoPreview();
  });
  document.getElementById('saveSetupBtn').addEventListener('click', function(){
    var btn = this;
    var logoValue = pendingLogo === undefined ? state.restaurant.logo : (pendingLogo || '');
    var stampValue = pendingStamp === undefined ? state.restaurant.stamp : (pendingStamp || '');
    var signatureValue = pendingSignature === undefined ? state.restaurant.signature : (pendingSignature || '');
    var updated = Object.assign({}, state.restaurant, {
      name: setupFields.name.value.trim(), phone: setupFields.phone.value.trim(),
      email: setupFields.email.value.trim(),
      address: setupFields.address.value.trim(), gstin: setupFields.gstin.value.trim(),
      logo: logoValue, stamp: stampValue, signature: signatureValue
    });
    setBtnLoading(btn, true, 'Saving…');
    api.updateRestaurantSettings({ tableCount: state.tableCount, extra: updated }).then(function(){
      state.restaurant = updated;
      pendingLogo = undefined;
      pendingStamp = undefined;
      pendingSignature = undefined;
      setBtnLoading(btn, false, null, 'Save details');
      showToast('Hotel details saved');
      renderBrandHeader();
      renderTicket();
      renderLogoPreview();
      renderStampPreview();
      renderSignaturePreview();
      var note = document.getElementById('setupSavedNote');
      note.style.display = 'inline';
      setTimeout(function(){ note.style.display = 'none'; }, 2000);
    }).catch(function(e){
      setBtnLoading(btn, false, null, 'Save details');
      showToast(e.message, 'error');
    });
  });

  document.getElementById('saveRestaurantSetupBtn').addEventListener('click', function(){
    var btn = this;
    var updated = Object.assign({}, state.restaurant, {
      taxRate: parseFloat(setupFields.taxRate.value) || 0,
      currency: setupFields.currency.value.trim() || '₹',
      invoicePrefix: (setupFields.invoicePrefix.value.trim() || 'INV').toUpperCase(),
      footer: setupFields.footer.value.trim()
    });
    setBtnLoading(btn, true, 'Saving…');
    api.updateRestaurantSettings({ tableCount: state.tableCount, extra: updated }).then(function(){
      state.restaurant = updated;
      setBtnLoading(btn, false, null, 'Save settings');
      showToast('Restaurant settings saved');
      renderBrandHeader();
      renderTicket();
      var note = document.getElementById('restaurantSetupSavedNote');
      note.style.display = 'inline';
      setTimeout(function(){ note.style.display = 'none'; }, 2000);
    }).catch(function(e){
      setBtnLoading(btn, false, null, 'Save settings');
      showToast(e.message, 'error');
    });
  });

  // Only Admin can change how many tables exist — Staff only ever sees/selects among them.
  document.getElementById('saveTableCountBtn').addEventListener('click', function(){
    var raw = document.getElementById('setTableCount').value;
    var val = parseInt(raw, 10);
    if(raw === '' || isNaN(val) || val < 0){ showToast('Enter a valid number of tables (0 or more).', 'error'); return; }
    val = Math.min(val, 60);

    var applyTableCount = function(){
      state.tableCount = val;
      ensureTables();
      api.getRestaurantSettings().then(function(row){
        return api.updateRestaurantSettings({ tableCount: val, extra: (row && row.extra) || {} });
      }).then(function(){
        showToast('Table count updated — Staff will see ' + val + ' table' + (val === 1 ? '' : 's') + '.');
        document.getElementById('setTableCount').value = val;
        var note = document.getElementById('tableCountSavedNote');
        note.style.display = 'inline';
        setTimeout(function(){ note.style.display = 'none'; }, 2000);
        renderTableStatusGrid();
      }).catch(function(e){ showToast(e.message, 'error'); });
    };

    if(val < state.tableCount){
      var hiddenActive = [];
      for(var i = val + 1; i <= state.tableCount; i++){
        var existing = state.tables[String(i)];
        if(existing && existing.status === 'active') hiddenActive.push(i);
      }
      if(hiddenActive.length > 0){
        openConfirm({
          title: 'Reduce number of tables?',
          desc: 'Table'+(hiddenActive.length > 1 ? 's' : '')+' <b>'+hiddenActive.join(', ')+'</b> still ' + (hiddenActive.length > 1 ? 'have' : 'has') + ' an active order. ' + (hiddenActive.length > 1 ? 'They' : 'It') + ' will be hidden from Staff, but the order data is kept — raise the table count again to bring it back.',
          confirmLabel: 'Reduce anyway',
          onConfirm: applyTableCount
        });
        return;
      }
    }
    applyTableCount();
  });

  // ---------- menu ----------
  var menuEditingId = null;
  function categoriesOf(){
    var set = {};
    state.menu.forEach(function(i){ set[i.category || 'Other'] = true; });
    return Object.keys(set);
  }
  function renderCatList(){
    var dl = document.getElementById('catList');
    dl.innerHTML = categoriesOf().map(function(c){ return '<option value="'+escapeHtml(c)+'">'; }).join('');
  }
  var miCategoryInput = document.getElementById('miCategory');
  var miCategoryDropdown = document.getElementById('miCategoryDropdown');
  function renderCategoryDropdown(){
    var q = miCategoryInput.value.trim().toLowerCase();
    var cats = categoriesOf();
    var matches = cats;
    if(q){
      matches = cats.filter(function(c){ return c.toLowerCase().indexOf(q) > -1; });
      matches.sort(function(a,b){
        var aStarts = a.toLowerCase().indexOf(q) === 0 ? 0 : 1;
        var bStarts = b.toLowerCase().indexOf(q) === 0 ? 0 : 1;
        if(aStarts !== bStarts) return aStarts - bStarts;
        return a.localeCompare(b);
      });
    } else {
      matches = cats.slice().sort(function(a,b){ return a.localeCompare(b); });
    }
    if(matches.length === 0){
      miCategoryDropdown.innerHTML = '<div class="msd-empty">'+(q ? 'No matching category — "'+escapeHtml(miCategoryInput.value.trim())+'" will be added as new' : 'No categories yet — type to create one')+'</div>';
    } else {
      miCategoryDropdown.innerHTML = matches.map(function(c){
        return '<div class="msd-item" data-pick-cat="'+escapeHtml(c)+'"><span class="msd-name">'+escapeHtml(c)+'</span></div>';
      }).join('');
      miCategoryDropdown.querySelectorAll('[data-pick-cat]').forEach(function(el){
        el.addEventListener('click', function(){
          miCategoryInput.value = el.dataset.pickCat;
          miCategoryDropdown.classList.remove('show');
          document.getElementById('miPrice').focus();
        });
      });
    }
    miCategoryDropdown.classList.add('show');
  }
  miCategoryInput.addEventListener('focus', renderCategoryDropdown);
  miCategoryInput.addEventListener('input', renderCategoryDropdown);
  miCategoryInput.addEventListener('keydown', function(e){
    if(e.key === 'Enter'){
      var first = miCategoryDropdown.querySelector('[data-pick-cat]');
      if(first && miCategoryInput.value.trim()){ miCategoryInput.value = first.dataset.pickCat; }
      miCategoryDropdown.classList.remove('show');
      e.preventDefault();
    } else if(e.key === 'Escape'){
      miCategoryDropdown.classList.remove('show');
    }
  });
  document.addEventListener('click', function(e){
    if(!e.target.closest('#miCategory') && !e.target.closest('#miCategoryDropdown')){
      miCategoryDropdown.classList.remove('show');
    }
  });
  function emptyState(icon, title, desc, actionHtml){
    return '<div class="empty-state"><div class="es-ico">'+icon+'</div><p class="big">'+escapeHtml(title)+'</p><p>'+escapeHtml(desc)+'</p>'+(actionHtml||'')+'</div>';
  }
  // Only admins and Restaurant-department staff may call the restaurant endpoints
  // (matches the backend's requireDepartment('restaurant')).
  function canAccessRestaurantModule(){
    return !!state.session && (state.session.role === 'admin' || state.session.department === 'restaurant');
  }
  function mapServerMenuItem(m){ return { id: m.id, name: m.name, category: m.category, price: parseFloat(m.price), isVeg: m.is_veg, deletedAt: m.deleted_at, available: m.available !== false }; }
  function fetchMenuFromServer(){
    if(!canAccessRestaurantModule()) return Promise.resolve();
    return api.getMenu().then(function(rows){ state.menu = rows.map(mapServerMenuItem); });
  }
  // Deleted-item trash is Admin-only server-side (matches requireAdmin on that route).
  function fetchDeletedMenuFromServer(){
    if(state.session.role !== 'admin') return Promise.resolve();
    return api.getDeletedMenu().then(function(rows){ state.deletedMenu = rows.map(mapServerMenuItem); });
  }
  function mapServerPromo(p){
    return { id: p.id, code: p.code, discountType: p.discount_type, discountValue: parseFloat(p.discount_value), expiryDate: p.expiry_date, maxUses: p.max_uses, usedCount: p.used_count, createdAt: p.created_at };
  }
  function fetchPromoCodesFromServer(){
    if(!canAccessRestaurantModule()) return Promise.resolve();
    return api.getPromoCodes().then(function(rows){ state.promoCodes = rows.map(mapServerPromo); });
  }
  function renderMenu(){
    return fetchMenuFromServer().then(function(){ renderMenuFromCache(); }).catch(function(e){
      var wrap = document.getElementById('menuGroups');
      if(wrap) wrap.innerHTML = '<p class="error-text show">'+escapeHtml(e.message)+'</p>';
    });
  }
  function renderMenuFromCache(){
    renderCatList();
    var wrap = document.getElementById('menuGroups');
    if(state.menu.length === 0){
      wrap.innerHTML = emptyState(ICONS.dish, 'No dishes yet', 'Add your first menu item above to get started.');
    } else {
      var groups = {};
      state.menu.forEach(function(item){
        var cat = item.category || 'Other';
        groups[cat] = groups[cat] || [];
        groups[cat].push(item);
      });
      var html = '';
      Object.keys(groups).sort().forEach(function(cat){
        html += '<div class="menu-group"><h3>'+escapeHtml(cat)+'</h3>';
        groups[cat].forEach(function(item){
          if(menuEditingId === item.id){
            html += '<div class="menu-item-row editing">'
              + '<input class="edit-field edit-name" data-edit-name="'+item.id+'" value="'+escapeHtml(item.name)+'">'
              + '<input class="edit-field edit-cat" data-edit-cat="'+item.id+'" value="'+escapeHtml(item.category||'')+'" list="catList">'
              + '<input class="edit-field edit-price" type="number" min="0" step="0.5" data-edit-price="'+item.id+'" value="'+item.price+'">'
              + '<span class="row-actions">'
              + '<button class="icon-btn" data-save="'+item.id+'" title="Save" style="color:var(--success);border-color:var(--success);">'+ICONS.check+'</button>'
              + '<button class="icon-btn" data-cancel-edit="'+item.id+'" title="Cancel">'+ICONS.xcirc+'</button>'
              + '</span></div>';
          } else {
            html += '<div class="menu-item-row'+(item.available === false ? ' unavailable' : '')+'">'
              + '<span class="name">'+escapeHtml(item.name)+'</span>'
              + '<span class="price">'+money(item.price)+'</span>'
              + '<label class="avail-toggle" title="'+(item.available === false ? 'Mark available' : 'Mark unavailable today')+'">'
              + '<input type="checkbox" data-avail-toggle="'+item.id+'"'+(item.available !== false ? ' checked' : '')+'>'
              + '<span class="avail-toggle-track"></span>'
              + '<span class="avail-toggle-label">'+(item.available === false ? 'Unavailable' : 'Available')+'</span>'
              + '</label>'
              + '<span class="row-actions">'
              + '<button class="icon-btn" data-edit="'+item.id+'" title="Edit price / details"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg></button>'
              + '<button class="icon-btn danger" data-del="'+item.id+'" title="Delete"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>'
              + '</span></div>';
          }
        });
        html += '</div>';
      });
      wrap.innerHTML = html;
    }

    wrap.querySelectorAll('[data-edit]').forEach(function(btn){
      btn.addEventListener('click', function(){ menuEditingId = btn.dataset.edit; renderMenuFromCache(); });
    });
    wrap.querySelectorAll('[data-cancel-edit]').forEach(function(btn){
      btn.addEventListener('click', function(){ menuEditingId = null; renderMenuFromCache(); });
    });
    wrap.querySelectorAll('[data-save]').forEach(function(btn){
      btn.addEventListener('click', function(){
        var id = btn.dataset.save;
        var item = state.menu.find(function(i){ return i.id === id; });
        if(!item) return;
        var nameEl = wrap.querySelector('[data-edit-name="'+id+'"]');
        var catEl = wrap.querySelector('[data-edit-cat="'+id+'"]');
        var priceEl = wrap.querySelector('[data-edit-price="'+id+'"]');
        var name = nameEl.value.trim();
        var category = catEl.value.trim() || 'Other';
        var price = parseFloat(priceEl.value);
        if(!name || isNaN(price) || price < 0){ showToast('Enter a valid name and price.', 'error'); return; }
        menuEditingId = null;
        api.updateMenuItem(id, { name: name, category: category, price: price, isVeg: item.isVeg }).then(function(){
          showToast('Item updated'); renderMenu(); renderItemPicker();
        }).catch(function(e){ showToast(e.message, 'error'); });
      });
    });
    wrap.querySelectorAll('[data-del]').forEach(function(btn){
      btn.addEventListener('click', function(){
        var item = state.menu.find(function(i){ return i.id === btn.dataset.del; });
        if(!item) return;
        openConfirm({
          title: 'Delete this menu item?',
          desc: '<b>'+escapeHtml(item.name)+'</b> will be removed from the menu. You can restore it later from Menu \u203a Deleted items.',
          confirmLabel: 'Delete item',
          onConfirm: function(){
            api.deleteMenuItem(item.id).then(function(){
              showToast('Item deleted — restore it anytime from Deleted items');
              renderMenu(); renderMenuTrash(); renderItemPicker(); renderDashboard();
            }).catch(function(e){ showToast(e.message, 'error'); });
          }
        });
      });
    });
    wrap.querySelectorAll('[data-avail-toggle]').forEach(function(cb){
      cb.addEventListener('change', function(){
        var id = cb.dataset.availToggle;
        var item = state.menu.find(function(i){ return i.id === id; });
        if(!item) return;
        var makeAvailable = cb.checked;
        api.setMenuItemAvailability(id, makeAvailable).then(function(){
          item.available = makeAvailable;
          showToast(makeAvailable ? (item.name + ' marked available') : (item.name + ' marked unavailable'));
          renderMenuFromCache();
          renderItemPicker();
        }).catch(function(e){
          cb.checked = !makeAvailable; // revert the switch on failure
          showToast(e.message, 'error');
        });
      });
    });
  }

  function renderMenuTrash(){
    return fetchDeletedMenuFromServer().then(function(){ renderMenuTrashFromCache(); }).catch(function(e){
      var wrap = document.getElementById('menuTrashWrap');
      if(wrap) wrap.innerHTML = '<p class="error-text show">'+escapeHtml(e.message)+'</p>';
    });
  }
  function renderMenuTrashFromCache(){
    var wrap = document.getElementById('menuTrashWrap');
    var countEl = document.getElementById('menuTrashCount');
    if(state.deletedMenu.length === 0){
      countEl.textContent = '';
      wrap.innerHTML = emptyState(ICONS.trash, 'No deleted items', 'Anything you remove from the menu will show up here so it can be restored.');
      return;
    }
    countEl.textContent = state.deletedMenu.length + ' item' + (state.deletedMenu.length === 1 ? '' : 's');
    wrap.innerHTML = state.deletedMenu.map(function(item){
      var when = new Date(item.deletedAt).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' });
      return '<div class="trash-item-row">'
        + '<span><span class="name">'+escapeHtml(item.name)+'</span><span class="meta">'+escapeHtml(item.category||'Other')+' · deleted '+when+'</span></span>'
        + '<span class="price">'+money(item.price)+'</span>'
        + '<span class="row-actions"><button class="btn ghost small" data-restore="'+item.id+'">Restore</button></span>'
        + '</div>';
    }).join('');
    wrap.querySelectorAll('[data-restore]').forEach(function(btn){
      btn.addEventListener('click', function(){
        var id = btn.dataset.restore;
        var item = state.deletedMenu.find(function(i){ return i.id === id; });
        if(!item) return;
        api.restoreMenuItem(id).then(function(){
          showToast('"'+item.name+'" restored to menu');
          renderMenu(); renderMenuTrash(); renderItemPicker();
        }).catch(function(e){ showToast(e.message, 'error'); });
      });
    });
  }

  document.getElementById('addMenuItemBtn').addEventListener('click', function(){
    var btn = this;
    var name = document.getElementById('miName').value.trim();
    var category = document.getElementById('miCategory').value.trim() || 'Other';
    var price = parseFloat(document.getElementById('miPrice').value);
    var err = document.getElementById('menuError');
    if(!name || isNaN(price) || price < 0){ err.classList.add('show'); return; }
    err.classList.remove('show');
    setBtnLoading(btn, true, 'Adding…');
    api.createMenuItem({ name: name, category: category, price: price }).then(function(){
      setBtnLoading(btn, false, null, 'Add item');
      showToast('Item added to menu');
      document.getElementById('miName').value = '';
      document.getElementById('miPrice').value = '';
      renderMenu(); renderItemPicker(); renderDashboard();
    }).catch(function(e){
      setBtnLoading(btn, false, null, 'Add item');
      err.textContent = e.message; err.classList.add('show');
    });
  });

  // ---------- billing / order ----------
  function renderItemPicker(){
    var wrap = document.getElementById('itemPickerGroups');
    if(state.menu.length === 0){
      wrap.innerHTML = emptyState(ICONS.dish, 'No menu items yet', 'Ask your admin to add dishes with prices first.');
      return;
    }
    var groups = {};
    state.menu.forEach(function(item){
      var cat = item.category || 'Other';
      groups[cat] = groups[cat] || [];
      groups[cat].push(item);
    });
    var html = '';
    Object.keys(groups).sort().forEach(function(cat){
      html += '<div><h3 style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted);margin:0 0 12px;">'+escapeHtml(cat)+'</h3><div class="item-picker-grid">';
      groups[cat].forEach(function(item){
        var isUnavailable = item.available === false;
        html += '<button class="item-card'+(isUnavailable ? ' unavailable' : '')+'" data-add="'+item.id+'"'+(isUnavailable ? ' disabled' : '')+'>'
          + '<span class="name">'+escapeHtml(item.name)+'</span>'
          + '<span class="price">'+(isUnavailable ? 'Unavailable' : money(item.price))+'</span></button>';
      });
      html += '</div></div>';
    });
    wrap.innerHTML = html;
    wrap.querySelectorAll('[data-add]:not([disabled])').forEach(function(btn){
      btn.addEventListener('click', function(){ addToOrder(btn.dataset.add); });
    });
  }
  function addToOrder(itemId){
    var t = currentTable();
    if(!t) return;
    var menuItem = state.menu.find(function(i){ return i.id === itemId; });
    if(!menuItem || menuItem.available === false) return;
    var line = t.items.find(function(l){ return l.itemId === itemId; });
    if(line){ line.qty += 1; } else { t.items.push({ itemId: itemId, name: menuItem.name, price: menuItem.price, qty: 1 }); }
    syncCurrentTable();
    renderTicket();
  }

  // Customer name/phone belong to whichever table is currently open — saved into that
  // table's own order object as the Staff types, so switching tables never loses them.
  document.getElementById('custName').addEventListener('input', function(){
    var t = currentTable();
    if(!t) return;
    t.customerName = this.value;
    syncCurrentTable();
  });
  document.getElementById('custPhone').addEventListener('input', function(){
    var t = currentTable();
    if(!t) return;
    t.customerPhone = this.value;
    syncCurrentTable();
  });

  var menuSearchInput = document.getElementById('menuSearchInput');
  var menuSearchDropdown = document.getElementById('menuSearchDropdown');

  function renderSearchDropdown(matches, q){
    if(matches.length === 0){
      menuSearchDropdown.innerHTML = '<div class="msd-empty">No items match "'+escapeHtml(q)+'"</div>';
    } else {
      menuSearchDropdown.innerHTML = matches.map(function(item){
        return '<div class="msd-item" data-pick="'+item.id+'">'
          + '<span><span class="msd-name">'+escapeHtml(item.name)+'</span><span class="msd-cat">'+escapeHtml(item.category||'')+'</span></span>'
          + '<span class="msd-price">'+money(item.price)+'</span></div>';
      }).join('');
      menuSearchDropdown.querySelectorAll('[data-pick]').forEach(function(el){
        el.addEventListener('click', function(){
          addToOrder(el.dataset.pick);
          menuSearchInput.value = '';
          menuSearchDropdown.classList.remove('show');
          menuSearchDropdown.innerHTML = '';
          menuSearchInput.focus();
        });
      });
    }
    menuSearchDropdown.classList.add('show');
  }
  menuSearchInput.addEventListener('input', function(){
    var q = this.value.trim().toLowerCase();
    if(!q){ menuSearchDropdown.classList.remove('show'); menuSearchDropdown.innerHTML = ''; return; }
    var matches = state.menu.filter(function(i){ return i.name.toLowerCase().indexOf(q) > -1; });
    matches.sort(function(a,b){
      var aStarts = a.name.toLowerCase().indexOf(q) === 0 ? 0 : 1;
      var bStarts = b.name.toLowerCase().indexOf(q) === 0 ? 0 : 1;
      return aStarts - bStarts;
    });
    renderSearchDropdown(matches.slice(0, 8), q);
  });
  menuSearchInput.addEventListener('keydown', function(e){
    if(e.key === 'Enter'){
      var first = menuSearchDropdown.querySelector('[data-pick]');
      if(first){ first.click(); }
      e.preventDefault();
    } else if(e.key === 'Escape'){
      menuSearchDropdown.classList.remove('show');
    }
  });
  document.addEventListener('click', function(e){
    if(!e.target.closest('.menu-search-wrap')){ menuSearchDropdown.classList.remove('show'); }
  });

  function changeQty(itemId, delta){
    var t = currentTable();
    if(!t) return;
    var line = t.items.find(function(l){ return l.itemId === itemId; });
    if(!line) return;
    line.qty += delta;
    if(line.qty <= 0){ t.items = t.items.filter(function(l){ return l.itemId !== itemId; }); }
    syncCurrentTable();
    renderTicket();
  }
  function removeLine(itemId){
    var t = currentTable();
    if(!t) return;
    t.items = t.items.filter(function(l){ return l.itemId !== itemId; });
    syncCurrentTable();
    renderTicket();
  }
  function computeTotals(order, taxRate){
    var subtotal = order.reduce(function(sum, l){ return sum + l.price * l.qty; }, 0);
    var tax = subtotal * (taxRate / 100);
    return { subtotal: subtotal, cgst: tax / 2, sgst: tax / 2, tax: tax, total: subtotal + tax };
  }
  function calcDiscount(totalAfterTax, promo){
    if(!promo) return 0;
    var d = promo.discountType === 'percent' ? totalAfterTax * (promo.discountValue / 100) : promo.discountValue;
    return Math.max(0, Math.min(d, totalAfterTax));
  }
  // The real invoice number is now assigned by the server at the moment of
  // generation (so numbering stays correct even with multiple staff/devices
  // creating invoices at the same time) — so this preview can no longer predict
  // the exact number in advance the way it could when everything was local-only.
  function previewInvoiceNo(){
    return 'Assigned on generate';
  }
  function renderAppliedPromo(){
    var wrap = document.getElementById('appliedPromoInfo');
    var ct = currentTable();
    if(!ct || !ct.appliedPromo){ wrap.innerHTML = ''; return; }
    var p = ct.appliedPromo;
    var label = p.discountType === 'percent' ? (p.discountValue + '% off') : (money(p.discountValue) + ' off');
    wrap.innerHTML = '<div class="promo-applied"><span>"'+escapeHtml(p.code)+'" applied — '+escapeHtml(label)+'</span><button id="removePromoBtn" title="Remove">✕</button></div>';
    document.getElementById('removePromoBtn').addEventListener('click', function(){
      var ct2 = currentTable();
      if(!ct2) return;
      ct2.appliedPromo = null;
      syncCurrentTable();
      renderTicket();
    });
  }
  function renderTicket(){
    var linesWrap = document.getElementById('ticketLines');
    var totalsWrap = document.getElementById('ticketTotals');
    document.getElementById('ticketInvoiceNo').textContent = previewInvoiceNo();
    renderAppliedPromo();

    var ct = currentTable();
    if(!ct || ct.items.length === 0){
      linesWrap.innerHTML = '<div class="ticket-empty">No items added yet. Tap dishes on the left to build the order.</div>';
      totalsWrap.innerHTML = '';
      return;
    }
    linesWrap.innerHTML = ct.items.map(function(l){
      return '<div class="ticket-line">'
        + '<span class="name">'+escapeHtml(l.name)+'</span>'
        + '<span class="qty-ctrl"><button data-qm="'+l.itemId+'">−</button><span>'+l.qty+'</span><button data-qp="'+l.itemId+'">+</button></span>'
        + '<span class="amt">'+money(l.price * l.qty)+'</span>'
        + '<button class="rm" data-rm="'+l.itemId+'">✕</button></div>';
    }).join('');
    linesWrap.querySelectorAll('[data-qm]').forEach(function(b){ b.addEventListener('click', function(){ changeQty(b.dataset.qm, -1); }); });
    linesWrap.querySelectorAll('[data-qp]').forEach(function(b){ b.addEventListener('click', function(){ changeQty(b.dataset.qp, 1); }); });
    linesWrap.querySelectorAll('[data-rm]').forEach(function(b){ b.addEventListener('click', function(){ removeLine(b.dataset.rm); }); });

    var t = computeTotals(ct.items, state.restaurant.taxRate);
    var discount = calcDiscount(t.total, ct.appliedPromo);
    var grandTotal = t.total - discount;
    var html = '<div class="row"><span>Subtotal</span><span>'+money(t.subtotal)+'</span></div>';
    if(state.restaurant.taxRate > 0){
      html += '<div class="row"><span>CGST '+(state.restaurant.taxRate/2).toFixed(1)+'%</span><span>'+money(t.cgst)+'</span></div>';
      html += '<div class="row"><span>SGST '+(state.restaurant.taxRate/2).toFixed(1)+'%</span><span>'+money(t.sgst)+'</span></div>';
    }
    if(discount > 0){
      html += '<div class="row" style="color:var(--success);"><span>Discount ('+escapeHtml(ct.appliedPromo.code)+')</span><span>−'+money(discount)+'</span></div>';
    }
    html += '<div class="row total"><span>Total</span><span>'+money(grandTotal)+'</span></div>';
    totalsWrap.innerHTML = html;
  }

  document.getElementById('applyPromoBtn').addEventListener('click', function(){
    var ct = currentTable();
    if(!ct) return;
    var codeInput = document.getElementById('promoCodeInput').value.trim().toUpperCase();
    var err = document.getElementById('promoError');
    if(!codeInput){ err.textContent = 'Enter a code.'; err.classList.add('show'); return; }
    var promo = state.promoCodes.find(function(p){ return p.code === codeInput; });
    if(!promo){ err.textContent = 'Invalid promo code.'; err.classList.add('show'); return; }
    if(!isPromoUsable(promo)){
      err.textContent = promoStatus(promo) === 'Expired' ? 'This code has expired.' : 'This code has reached its usage limit.';
      err.classList.add('show');
      return;
    }
    err.classList.remove('show');
    ct.appliedPromo = promo;
    syncCurrentTable();
    document.getElementById('promoCodeInput').value = '';
    renderTicket();
  });

  document.getElementById('paymentMethodBtns').addEventListener('click', function(e){
    var btn = e.target.closest('.pm-btn');
    if(!btn) return;
    var ct = currentTable();
    if(!ct) return;
    ct.paymentMethod = btn.dataset.method;
    syncCurrentTable();
    document.querySelectorAll('.pm-btn').forEach(function(b){ b.classList.toggle('active', b === btn); });
  });

  document.getElementById('generateInvoiceBtn').addEventListener('click', function(){
    var btn = this;
    var tableId = state.currentTableId;
    var ct = currentTable();
    if(!ct){ showToast('Select a table first.', 'error'); return; }
    var name = document.getElementById('custName').value.trim();
    var phone = document.getElementById('custPhone').value.trim();
    var err = document.getElementById('billingError');
    if(!name || !phone || ct.items.length === 0){ err.classList.add('show'); return; }
    err.classList.remove('show');

    var t = computeTotals(ct.items, state.restaurant.taxRate);
    var promo = ct.appliedPromo;
    var discount = calcDiscount(t.total, promo);
    var grandTotal = t.total - discount;

    setBtnLoading(btn, true, 'Generating invoice…');
    // Cancel any pending debounced save for this table — we're about to write
    // its final (pre-invoice) state and then explicitly clear it, so a stale
    // timer firing later must not overwrite the cleared table.
    clearTimeout(tableSaveTimers[tableId]);

    api.createInvoice({
      department: 'restaurant', customerName: name, customerPhone: phone, tableNo: parseInt(tableId, 10),
      subtotal: t.subtotal, discountAmount: discount, promoCode: promo ? promo.code : null,
      totalAmount: grandTotal, paymentMethod: ct.paymentMethod,
      items: ct.items.map(function(l){ return { name: l.name, quantity: l.qty, unitPrice: l.price, lineTotal: l.price * l.qty }; })
    }).then(function(serverInvoice){
      var invoice = {
        id: serverInvoice.id, invoiceNo: serverInvoice.invoice_no, date: serverInvoice.created_at,
        customerName: name, customerPhone: phone,
        tableNo: tableId, refLabel: 'Table', refValue: tableId, department: 'restaurant',
        items: ct.items.map(function(l){ return { name:l.name, price:l.price, qty:l.qty, amount:l.price*l.qty }; }),
        subtotal: t.subtotal, cgst: t.cgst, sgst: t.sgst, tax: t.tax,
        preDiscountTotal: t.total, discountAmount: discount,
        promoCode: promo ? promo.code : null,
        total: grandTotal,
        paymentMethod: ct.paymentMethod,
        restaurant: Object.assign({}, state.restaurant),
        createdByStaffId: state.session.staffId || '',
        createdByName: state.session.name || state.session.staffId || 'Staff'
      };
      // Only THIS table's order is cleared — every other table's active order is untouched.
      state.tables[tableId] = newTableOrder();
      return pushTableToServer(tableId).then(function(){ return invoice; });
    }).then(function(invoice){
      setBtnLoading(btn, false, null, 'Generate invoice');
      openInvoiceOverlay(invoice);
      if(state.currentTableId === tableId){
        document.getElementById('custName').value = '';
        document.getElementById('custPhone').value = '';
        document.querySelectorAll('.pm-btn').forEach(function(b){ b.classList.toggle('active', b.dataset.method === 'Cash'); });
        var titleEl = document.getElementById('billingHeadTitle');
        if(titleEl) titleEl.textContent = 'Table ' + tableId + ' — New bill';
        renderTicket();
      }
      updateTableNavBadges();
      if(promo) renderPromoList();
      renderHistory();
      renderSalesAnalysis();
      renderDashboard();
    }).catch(function(e){
      setBtnLoading(btn, false, null, 'Generate invoice');
      err.textContent = e.message; err.classList.add('show');
    });
  });

  // ---------- room booking / banquet hall booking (free-text charges) ----------
  var roomDraft = { items: [], paymentMethod: 'Cash' };
  var banquetDraft = { items: [], paymentMethod: 'Cash' };

  function renderDraftTicket(draft, ids){
    var invEl = document.getElementById(ids.invoiceNo);
    if(invEl) invEl.textContent = previewInvoiceNo();
    var linesWrap = document.getElementById(ids.lines);
    var totalsWrap = document.getElementById(ids.totals);
    if(!linesWrap || !totalsWrap) return;
    if(draft.items.length === 0){
      linesWrap.innerHTML = '<div class="ticket-empty">No charges added yet. Add a description and amount on the left.</div>';
      totalsWrap.innerHTML = '';
      return;
    }
    linesWrap.innerHTML = draft.items.map(function(l){
      return '<div class="ticket-line">'
        + '<span class="name">'+escapeHtml(l.name)+'</span>'
        + '<span class="amt">'+money(l.amount)+'</span>'
        + '<button class="rm" data-rm-draft="'+l.id+'">✕</button></div>';
    }).join('');
    linesWrap.querySelectorAll('[data-rm-draft]').forEach(function(b){
      b.addEventListener('click', function(){
        draft.items = draft.items.filter(function(x){ return x.id !== b.dataset.rmDraft; });
        renderDraftTicket(draft, ids);
      });
    });
    var t = computeTotals(draft.items, state.restaurant.taxRate);
    var html = '<div class="row"><span>Subtotal</span><span>'+money(t.subtotal)+'</span></div>';
    if(state.restaurant.taxRate > 0){
      html += '<div class="row"><span>CGST '+(state.restaurant.taxRate/2).toFixed(1)+'%</span><span>'+money(t.cgst)+'</span></div>';
      html += '<div class="row"><span>SGST '+(state.restaurant.taxRate/2).toFixed(1)+'%</span><span>'+money(t.sgst)+'</span></div>';
    }
    html += '<div class="row total"><span>Total</span><span>'+money(t.total)+'</span></div>';
    totalsWrap.innerHTML = html;
  }
  function renderRoomTicket(){
    renderDraftTicket(roomDraft, { invoiceNo:'roomTicketInvoiceNo', lines:'roomTicketLines', totals:'roomTicketTotals' });
    updateRoomBalanceHint();
  }
  function renderBanquetTicket(){
    renderDraftTicket(banquetDraft, { invoiceNo:'banquetTicketInvoiceNo', lines:'banquetTicketLines', totals:'banquetTicketTotals' });
  }
  function wireChargeAdd(descId, amountId, btnId, errId, draft, renderFn){
    var btn = document.getElementById(btnId);
    if(!btn) return;
    btn.addEventListener('click', function(){
      var desc = document.getElementById(descId).value.trim();
      var amount = parseFloat(document.getElementById(amountId).value);
      var err = document.getElementById(errId);
      if(!desc || isNaN(amount) || amount <= 0){ err.classList.add('show'); return; }
      err.classList.remove('show');
      draft.items.push({ id: uid(), name: desc, price: amount, qty: 1, amount: amount });
      document.getElementById(descId).value = '';
      document.getElementById(amountId).value = '';
      document.getElementById(descId).focus();
      renderFn();
    });
    bindEnterToSubmit([descId, amountId], btnId);
  }
  wireChargeAdd('roomChargeDesc','roomChargeAmount','addRoomChargeBtn','roomChargeError', roomDraft, renderRoomTicket);

  document.getElementById('roomPaymentMethodBtns').addEventListener('click', function(e){
    var btn = e.target.closest('.pm-btn');
    if(!btn) return;
    roomDraft.paymentMethod = btn.dataset.method;
    this.querySelectorAll('.pm-btn').forEach(function(b){ b.classList.toggle('active', b === btn); });
  });
  document.getElementById('banquetPaymentMethodBtns').addEventListener('click', function(e){
    var btn = e.target.closest('.pm-btn');
    if(!btn) return;
    banquetDraft.paymentMethod = btn.dataset.method;
    this.querySelectorAll('.pm-btn').forEach(function(b){ b.classList.toggle('active', b === btn); });
  });

  // ---------- room management: Admin configuration (Setup/Availability) ----------
  function roomCategoryName(id){
    var c = state.roomCategories.find(function(x){ return x.id === id; });
    return c ? c.name : '—';
  }
  function computeRoomStatusLabel(r){
    if(r.outOfOrder) return 'Out of order';
    if(r.status === 'occupied') return 'Occupied';
    return 'Available';
  }
  function computeRoomStatusBadgeClass(r){
    if(r.outOfOrder) return 'warning';
    if(r.status === 'occupied') return 'danger';
    return 'success';
  }
  // Adds any missing rooms 1..count on a floor (e.g. Floor 1, count 10 -> 101..110) and removes
  // rooms beyond the new count — unless they're currently occupied, in which case they're kept
  // and the caller is told so (so it can warn the Admin) rather than destroying a live booking.
  // Does the actual creating/deleting via the API, then re-fetches so every device stays in sync.
  function syncRoomsForFloor(floor, count){
    var keptOccupied = false;
    var toDelete = [];
    state.rooms.forEach(function(r){
      if(r.floor !== floor) return;
      var pos = r.roomNo - (floor * 100);
      if(pos > count){
        if(r.status === 'occupied'){ keptOccupied = true; }
        else { toDelete.push(r.id); }
      }
    });
    var toCreate = [];
    for(var i = 1; i <= count; i++){
      var roomNo = floor * 100 + i;
      var already = state.rooms.some(function(r){ return r.roomNo === roomNo; });
      if(!already){
        toCreate.push({
          roomNo: roomNo, floor: floor,
          categoryId: state.roomCategories.length ? state.roomCategories[0].id : null,
          bedType: 'Double Bed', ac: true, maxAdults: 2, maxChildren: 1,
          price: 0, amenities: [], extraBedAllowed: false, extraBedPrice: 0, outOfOrder: false
        });
      }
    }
    return Promise.all(toDelete.map(function(id){ return api.deleteRoom(id); }))
      .then(function(){ return Promise.all(toCreate.map(function(room){ return api.createRoom(room); })); })
      .then(function(){ return fetchRoomSetupFromServer(); })
      .then(function(){ return keptOccupied; });
  }
  function renderRoomFloorList(){
    var wrap = document.getElementById('roomFloorListWrap');
    if(!wrap) return;
    if(state.roomFloors.length === 0){
      wrap.innerHTML = '<p class="hint" style="margin:0;">No floors configured yet — add one above.</p>';
      return;
    }
    var sorted = state.roomFloors.slice().sort(function(a,b){ return a.floor - b.floor; });
    var rows = sorted.map(function(f){
      return '<tr><td data-label="Floor">Floor '+f.floor+'</td><td data-label="Rooms configured">'+f.count+'</td>'
        + '<td data-label="Actions"><button class="btn danger-ghost small" data-remove-floor="'+f.id+'" data-floor-num="'+f.floor+'">Remove</button></td></tr>';
    }).join('');
    wrap.innerHTML = '<div class="table-scroll"><table class="dtable"><thead><tr><th>Floor</th><th>Rooms configured</th><th></th></tr></thead><tbody>'+rows+'</tbody></table></div>';
    wrap.querySelectorAll('[data-remove-floor]').forEach(function(btn){
      btn.addEventListener('click', function(){
        var floorId = btn.dataset.removeFloor;
        var floorNum = parseInt(btn.dataset.floorNum, 10);
        var occupied = state.rooms.some(function(r){ return r.floor === floorNum && r.status === 'occupied'; });
        if(occupied){ showToast('Cannot remove Floor '+floorNum+' — it has an occupied room. Check it out first.', 'error'); return; }
        openConfirm({
          title: 'Remove Floor ' + floorNum + '?',
          desc: 'This removes the floor\'s configuration and its rooms from inventory.',
          confirmLabel: 'Remove floor',
          onConfirm: function(){
            var roomIds = state.rooms.filter(function(r){ return r.floor === floorNum; }).map(function(r){ return r.id; });
            Promise.all(roomIds.map(function(id){ return api.deleteRoom(id); }))
              .then(function(){ return api.deleteRoomFloor(floorId); })
              .then(function(){ return fetchRoomSetupFromServer(); })
              .then(function(){ showToast('Floor removed'); renderRoomSetup(); })
              .catch(function(e){ showToast(e.message, 'error'); });
          }
        });
      });
    });
  }
  document.getElementById('addRoomFloorBtn').addEventListener('click', function(){
    var btn = this;
    var floorNo = parseInt(document.getElementById('roomFloorNo').value, 10);
    var count = parseInt(document.getElementById('roomFloorCount').value, 10);
    var err = document.getElementById('roomFloorError');
    if(!floorNo || floorNo < 1 || !count || count < 1 || count > 99){ err.classList.add('show'); return; }
    err.classList.remove('show');
    setBtnLoading(btn, true, 'Saving…');
    var existing = state.roomFloors.find(function(f){ return f.floor === floorNo; });
    var savePromise = existing ? api.updateRoomFloor(existing.id, count) : api.addRoomFloor(floorNo, count);
    savePromise.then(function(){
      return fetchRoomSetupFromServer();
    }).then(function(){
      return syncRoomsForFloor(floorNo, count);
    }).then(function(keptOccupied){
      setBtnLoading(btn, false, null, 'Save floor');
      document.getElementById('roomFloorNo').value = '';
      document.getElementById('roomFloorCount').value = '';
      showToast(keptOccupied ? 'Floor saved — occupied rooms beyond the new count were kept.' : 'Floor saved');
      renderRoomSetup();
    }).catch(function(e){
      setBtnLoading(btn, false, null, 'Save floor');
      err.textContent = e.message; err.classList.add('show');
    });
  });
  bindEnterToSubmit(['roomFloorNo','roomFloorCount'], 'addRoomFloorBtn');

  function renderRoomCategoryList(){
    var wrap = document.getElementById('roomCategoryListWrap');
    if(!wrap) return;
    if(state.roomCategories.length === 0){
      wrap.innerHTML = '<p class="hint" style="margin:0;">No categories yet — add one above (e.g. Standard, Deluxe, Suite).</p>';
      return;
    }
    var rows = state.roomCategories.map(function(c){
      return '<tr><td data-label="Category">'+escapeHtml(c.name)+'</td>'
        + '<td data-label="Actions"><button class="btn danger-ghost small" data-remove-category="'+c.id+'">Delete</button></td></tr>';
    }).join('');
    wrap.innerHTML = '<div class="table-scroll"><table class="dtable"><thead><tr><th>Category</th><th></th></tr></thead><tbody>'+rows+'</tbody></table></div>';
    wrap.querySelectorAll('[data-remove-category]').forEach(function(btn){
      btn.addEventListener('click', function(){
        var cId = btn.dataset.removeCategory;
        var inUse = state.rooms.some(function(r){ return r.categoryId === cId; });
        if(inUse){ showToast('Reassign rooms using this category before deleting it.', 'error'); return; }
        var cat = state.roomCategories.find(function(x){ return x.id === cId; });
        openConfirm({
          title: 'Delete category?',
          desc: '<b>'+escapeHtml(cat ? cat.name : '')+'</b> will be removed.',
          confirmLabel: 'Delete',
          onConfirm: function(){
            api.deleteRoomCategory(cId).then(function(){ return fetchRoomSetupFromServer(); }).then(function(){
              showToast('Category deleted'); renderRoomSetup();
            }).catch(function(e){ showToast(e.message, 'error'); });
          }
        });
      });
    });
  }
  document.getElementById('addRoomCategoryBtn').addEventListener('click', function(){
    var btn = this;
    var name = document.getElementById('roomCategoryName').value.trim();
    var err = document.getElementById('roomCategoryError');
    if(!name){ err.classList.add('show'); return; }
    err.classList.remove('show');
    setBtnLoading(btn, true, 'Adding…');
    api.addRoomCategory(name).then(function(){ return fetchRoomSetupFromServer(); }).then(function(){
      setBtnLoading(btn, false, null, 'Add category');
      document.getElementById('roomCategoryName').value = '';
      showToast('Category added');
      renderRoomSetup();
    }).catch(function(e){
      setBtnLoading(btn, false, null, 'Add category');
      err.textContent = e.message; err.classList.add('show');
    });
  });
  bindEnterToSubmit(['roomCategoryName'], 'addRoomCategoryBtn');

  function renderRoomInventoryTable(){
    var wrap = document.getElementById('roomInventoryWrap');
    var countEl = document.getElementById('roomInventoryCount');
    if(!wrap) return;
    if(countEl) countEl.textContent = state.rooms.length + ' room' + (state.rooms.length === 1 ? '' : 's');
    if(state.rooms.length === 0){
      wrap.innerHTML = emptyState(ICONS.room, 'No rooms yet', 'Add a floor above to generate room numbers automatically.');
      return;
    }
    var sorted = state.rooms.slice().sort(function(a,b){ return a.roomNo - b.roomNo; });
    var rows = sorted.map(function(r){
      var cap = r.maxAdults + '+' + r.maxChildren;
      var statusBadge = '<span class="badge '+computeRoomStatusBadgeClass(r)+'">'+computeRoomStatusLabel(r).toUpperCase()+'</span>';
      return '<tr>'
        + '<td data-label="Room No." class="code">'+escapeHtml(String(r.roomNo))+'</td>'
        + '<td data-label="Floor">'+r.floor+'</td>'
        + '<td data-label="Category">'+escapeHtml(roomCategoryName(r.categoryId))+'</td>'
        + '<td data-label="Bed">'+escapeHtml(r.bedType)+'</td>'
        + '<td data-label="AC">'+(r.ac ? 'AC' : 'Non-AC')+'</td>'
        + '<td data-label="Capacity">'+cap+'</td>'
        + '<td data-label="Price">'+money(r.price)+'</td>'
        + '<td data-label="Status">'+statusBadge+'</td>'
        + '<td data-label="Actions"><button class="btn ghost small" data-edit-room="'+r.id+'">Edit</button></td>'
        + '</tr>';
    }).join('');
    wrap.innerHTML = '<div class="table-scroll"><table class="dtable"><thead><tr><th>Room No.</th><th>Floor</th><th>Category</th><th>Bed</th><th>AC</th><th>Capacity</th><th>Price</th><th>Status</th><th></th></tr></thead><tbody>'+rows+'</tbody></table></div>';
    wrap.querySelectorAll('[data-edit-room]').forEach(function(btn){
      btn.addEventListener('click', function(){ openRoomEditModal(btn.dataset.editRoom); });
    });
  }
  function renderRoomSetup(){
    renderRoomFloorList();
    renderRoomCategoryList();
    renderRoomInventoryTable();
    document.getElementById('setStdCheckIn').value = state.restaurant.standardCheckInTime || '12:00';
    document.getElementById('setStdCheckOut').value = state.restaurant.standardCheckOutTime || '11:00';
    document.getElementById('setEarlyCheckinFee').value = state.restaurant.earlyCheckinFeePerHour || 0;
    document.getElementById('setLateCheckoutFee').value = state.restaurant.lateCheckoutFeePerHour || 0;
  }
  document.getElementById('saveRoomPolicyBtn').addEventListener('click', function(){
    var btn = this;
    var updated = Object.assign({}, state.restaurant, {
      standardCheckInTime: document.getElementById('setStdCheckIn').value || '12:00',
      standardCheckOutTime: document.getElementById('setStdCheckOut').value || '11:00',
      earlyCheckinFeePerHour: parseFloat(document.getElementById('setEarlyCheckinFee').value) || 0,
      lateCheckoutFeePerHour: parseFloat(document.getElementById('setLateCheckoutFee').value) || 0
    });
    setBtnLoading(btn, true, 'Saving…');
    api.updateRestaurantSettings({ tableCount: state.tableCount, extra: updated }).then(function(){
      state.restaurant = updated;
      setBtnLoading(btn, false, null, 'Save policy');
      showToast('Check-in / check-out policy saved');
      var note = document.getElementById('roomPolicySavedNote');
      note.style.display = 'inline';
      setTimeout(function(){ note.style.display = 'none'; }, 2000);
    }).catch(function(e){
      setBtnLoading(btn, false, null, 'Save policy');
      showToast(e.message, 'error');
    });
  });

  // ---------- room edit modal (Admin only) ----------
  var roomModalScrim = wireModal('roomModalScrim', ['roomModalClose','roomModalCancel']);
  var roomEditingId = null;
  function renderRoomEditAmenities(selected){
    var wrap = document.getElementById('roomEditAmenities');
    wrap.innerHTML = DEFAULT_AMENITIES.map(function(a){
      var checked = selected.indexOf(a) > -1 ? ' checked' : '';
      return '<label style="display:flex;align-items:center;gap:7px;font-size:12.5px;font-weight:500;"><input type="checkbox" value="'+escapeHtml(a)+'" data-amenity style="width:15px;height:15px;accent-color:var(--accent);margin:0;"'+checked+'> '+escapeHtml(a)+'</label>';
    }).join('');
  }
  function openRoomEditModal(roomId){
    var r = state.rooms.find(function(x){ return x.id === roomId; });
    if(!r) return;
    roomEditingId = roomId;
    document.getElementById('roomModalTitle').textContent = 'Edit Room ' + r.roomNo;
    var catSel = document.getElementById('roomEditCategory');
    catSel.innerHTML = state.roomCategories.length
      ? state.roomCategories.map(function(c){ return '<option value="'+c.id+'"'+(c.id===r.categoryId?' selected':'')+'>'+escapeHtml(c.name)+'</option>'; }).join('')
      : '<option value="">Add a category first</option>';
    document.getElementById('roomEditBed').value = r.bedType || 'Double Bed';
    document.getElementById('roomEditAc').value = r.ac ? '1' : '0';
    document.getElementById('roomEditMaxAdults').value = r.maxAdults;
    document.getElementById('roomEditMaxChildren').value = r.maxChildren;
    document.getElementById('roomEditPrice').value = r.price;
    document.getElementById('roomEditStatus').value = r.outOfOrder ? 'out_of_order' : 'active';
    document.getElementById('roomEditExtraBed').checked = !!r.extraBedAllowed;
    document.getElementById('roomEditExtraBedPrice').value = r.extraBedPrice || 0;
    renderRoomEditAmenities(r.amenities || []);
    document.getElementById('roomEditError').classList.remove('show');
    roomModalScrim.classList.add('show');
  }
  document.getElementById('saveRoomEditBtn').addEventListener('click', function(){
    var r = state.rooms.find(function(x){ return x.id === roomEditingId; });
    if(!r) return;
    var err = document.getElementById('roomEditError');
    var categoryId = document.getElementById('roomEditCategory').value;
    var price = parseFloat(document.getElementById('roomEditPrice').value);
    var maxAdults = parseInt(document.getElementById('roomEditMaxAdults').value, 10);
    var maxChildren = parseInt(document.getElementById('roomEditMaxChildren').value, 10);
    if(!categoryId){ err.textContent = 'Select a category.'; err.classList.add('show'); return; }
    if(isNaN(price) || price < 0){ err.textContent = 'Enter a valid price.'; err.classList.add('show'); return; }
    if(!maxAdults || maxAdults < 1){ err.textContent = 'Enter a valid adult capacity.'; err.classList.add('show'); return; }
    if(isNaN(maxChildren) || maxChildren < 0){ err.textContent = 'Enter a valid children capacity.'; err.classList.add('show'); return; }
    var wantsOutOfOrder = document.getElementById('roomEditStatus').value === 'out_of_order';
    if(wantsOutOfOrder && r.status === 'occupied'){
      err.textContent = 'This room currently has a guest — check it out before marking it out of order.';
      err.classList.add('show');
      return;
    }
    err.classList.remove('show');
    var updated = {
      roomNo: r.roomNo, floor: r.floor,
      categoryId: categoryId,
      bedType: document.getElementById('roomEditBed').value,
      ac: document.getElementById('roomEditAc').value === '1',
      maxAdults: maxAdults,
      maxChildren: maxChildren,
      price: price,
      extraBedAllowed: document.getElementById('roomEditExtraBed').checked,
      extraBedPrice: parseFloat(document.getElementById('roomEditExtraBedPrice').value) || 0,
      outOfOrder: wantsOutOfOrder,
      amenities: Array.prototype.slice.call(document.querySelectorAll('#roomEditAmenities [data-amenity]:checked')).map(function(c){ return c.value; })
    };
    var saveBtn = document.getElementById('saveRoomEditBtn');
    setBtnLoading(saveBtn, true, 'Saving…');
    api.updateRoom(r.id, updated).then(function(){ return fetchRoomSetupFromServer(); }).then(function(){
      setBtnLoading(saveBtn, false, null, 'Save room');
      roomModalScrim.classList.remove('show');
      showToast('Room ' + r.roomNo + ' saved');
      renderRoomSetup();
      renderRoomAvailability();
    }).catch(function(e){
      setBtnLoading(saveBtn, false, null, 'Save room');
      err.textContent = e.message; err.classList.add('show');
    });
  });

  // ---------- room availability (Admin only: read-only) ----------
  function renderRoomAvailability(){
    var statsWrap = document.getElementById('roomAvailabilityStats');
    if(!statsWrap) return;
    var rooms = state.rooms;
    var total = rooms.length;
    var occupied = rooms.filter(function(r){ return r.status === 'occupied'; }).length;
    var outOfOrder = rooms.filter(function(r){ return r.outOfOrder; }).length;
    var available = total - occupied - outOfOrder;
    statsWrap.innerHTML =
      kpiCard('Total rooms', String(total), 'room')
      + kpiCard('Available', String(available), 'check')
      + kpiCard('Occupied', String(occupied), 'billing')
      + kpiCard('Out of order', String(outOfOrder), 'info');

    var filtersWrap = document.getElementById('roomAvailabilityFilters');
    var floors = state.roomFloors.map(function(f){ return f.floor; }).sort(function(a,b){ return a-b; });
    var floorOptions = '<option value="">All floors</option>' + floors.map(function(f){ return '<option value="'+f+'">Floor '+f+'</option>'; }).join('');
    var catOptions = '<option value="">All categories</option>' + state.roomCategories.map(function(c){ return '<option value="'+c.id+'">'+escapeHtml(c.name)+'</option>'; }).join('');
    if(filtersWrap && !filtersWrap.dataset.wired){
      filtersWrap.innerHTML =
        '<select id="roomAvailStatusFilter"><option value="all">All rooms</option><option value="available">Available</option><option value="occupied">Occupied</option><option value="out_of_order">Out of order</option></select>'
        + '<select id="roomAvailFloorFilter">'+floorOptions+'</select>'
        + '<select id="roomAvailCatFilter">'+catOptions+'</select>';
      filtersWrap.dataset.wired = '1';
      ['roomAvailStatusFilter','roomAvailFloorFilter','roomAvailCatFilter'].forEach(function(id){
        document.getElementById(id).addEventListener('change', renderRoomAvailabilityList);
      });
    } else if(filtersWrap){
      var floorSel = document.getElementById('roomAvailFloorFilter');
      var catSel = document.getElementById('roomAvailCatFilter');
      if(floorSel){ var curFloor = floorSel.value; floorSel.innerHTML = floorOptions; floorSel.value = curFloor; }
      if(catSel){ var curCat = catSel.value; catSel.innerHTML = catOptions; catSel.value = curCat; }
    }
    renderRoomAvailabilityList();
  }
  function renderRoomAvailabilityList(){
    var wrap = document.getElementById('roomAvailabilityListWrap');
    if(!wrap) return;
    var statusFilter = (document.getElementById('roomAvailStatusFilter') || {}).value || 'all';
    var floorFilter = (document.getElementById('roomAvailFloorFilter') || {}).value || '';
    var catFilter = (document.getElementById('roomAvailCatFilter') || {}).value || '';
    var rooms = state.rooms.filter(function(r){
      if(statusFilter === 'available' && (r.status !== 'available' || r.outOfOrder)) return false;
      if(statusFilter === 'occupied' && r.status !== 'occupied') return false;
      if(statusFilter === 'out_of_order' && !r.outOfOrder) return false;
      if(floorFilter && String(r.floor) !== floorFilter) return false;
      if(catFilter && r.categoryId !== catFilter) return false;
      return true;
    }).sort(function(a,b){ return a.roomNo - b.roomNo; });
    if(rooms.length === 0){
      wrap.innerHTML = emptyState(ICONS.room, 'No rooms match', 'Try a different filter, or configure rooms in Setup.');
      return;
    }
    var rows = rooms.map(function(r){
      return '<tr>'
        + '<td data-label="Room No." class="code">'+escapeHtml(String(r.roomNo))+'</td>'
        + '<td data-label="Category">'+escapeHtml(roomCategoryName(r.categoryId))+'</td>'
        + '<td data-label="AC">'+(r.ac?'AC':'Non-AC')+'</td>'
        + '<td data-label="Price">'+money(r.price)+'</td>'
        + '<td data-label="Status"><span class="badge '+computeRoomStatusBadgeClass(r)+'">'+computeRoomStatusLabel(r).toUpperCase()+'</span></td>'
        + '</tr>';
    }).join('');
    wrap.innerHTML = '<div class="table-scroll"><table class="dtable"><thead><tr><th>Room No.</th><th>Category</th><th>AC</th><th>Price</th><th>Status</th></tr></thead><tbody>'+rows+'</tbody></table></div>';
  }

  // ---------- staff room booking screen: select a configured room, book, and check out ----------
  function availableRoomsForBooking(){
    return state.rooms.filter(function(r){ return r.status === 'available' && !r.outOfOrder; }).sort(function(a,b){ return a.roomNo - b.roomNo; });
  }
  function updateRoomSelectedInfo(){
    var sel = document.getElementById('roomNo');
    var info = document.getElementById('roomSelectedInfo');
    if(!sel || !info) return;
    var r = state.rooms.find(function(x){ return x.id === sel.value; });
    if(!r){ info.textContent = ''; return; }
    info.textContent = 'Max occupancy: ' + r.maxAdults + ' adults + ' + r.maxChildren + ' children · Bed: ' + r.bedType
      + (r.extraBedAllowed ? ' · Extra bed available (' + money(r.extraBedPrice) + ')' : '');
  }
  // Number of nights between two yyyy-mm-dd dates (minimum 1 — even a same-day
  // or not-yet-picked check-out is billed as at least one night).
  function computeRoomNights(checkInVal, checkOutVal){
    if(!checkInVal || !checkOutVal) return 1;
    var inMs = new Date(checkInVal + 'T00:00:00').getTime();
    var outMs = new Date(checkOutVal + 'T00:00:00').getTime();
    var diffDays = Math.round((outMs - inMs) / 86400000);
    return diffDays > 0 ? diffDays : 1;
  }
  // Auto-fills the room-rent Description/Amount charge fields from the
  // selected room's nightly rate and the check-in/check-out dates, so staff
  // don't have to work out the math themselves. Staff can still edit the
  // fields before clicking Add.
  function autofillRoomCharge(){
    var sel = document.getElementById('roomNo');
    var descEl = document.getElementById('roomChargeDesc');
    var amtEl = document.getElementById('roomChargeAmount');
    if(!sel || !descEl || !amtEl) return;
    var room = state.rooms.find(function(x){ return x.id === sel.value; });
    if(!room){ return; }
    var nights = computeRoomNights(document.getElementById('roomCheckIn').value, document.getElementById('roomCheckOut').value);
    descEl.value = 'Room rent (' + nights + ' night' + (nights === 1 ? '' : 's') + ')';
    amtEl.value = room.price * nights;
  }
  function renderRoomBookingPage(){
    var sel = document.getElementById('roomNo');
    if(!sel) return;
    var rooms = availableRoomsForBooking();
    var prevVal = sel.value;
    if(rooms.length === 0){
      sel.innerHTML = '<option value="">No rooms available</option>';
    } else {
      sel.innerHTML = '<option value="">Select a room</option>' + rooms.map(function(r){
        return '<option value="'+r.id+'">'+r.roomNo+' — '+escapeHtml(roomCategoryName(r.categoryId))+' ('+(r.ac?'AC':'Non-AC')+') — '+money(r.price)+'/night</option>';
      }).join('');
      if(rooms.some(function(r){ return r.id === prevVal; })) sel.value = prevVal;
    }
    renderRoomPickerPanel(rooms, sel.value);
    updateRoomSelectedInfo();
    api.getInvoices('room').then(function(rows){ state.roomInvoices = rows.map(mapServerRoomInvoiceListRow); }).catch(function(){}).then(renderOccupiedRoomsList);
  }
  // Builds the rich, card-based room picker (Room Booking page). Keeps the
  // underlying <select id="roomNo"> as the real source of truth — clicking a
  // card just sets the select's value and fires 'change', so every existing
  // handler (autofill, occupancy checks, etc.) keeps working unchanged.
  function renderRoomPickerPanel(rooms, selectedId){
    var btn = document.getElementById('roomPickerBtn');
    var btnText = document.getElementById('roomPickerBtnText');
    var panel = document.getElementById('roomPickerPanel');
    var wrap = document.getElementById('roomPickerWrap');
    if(!panel || !btn || !wrap) return;

    if(rooms.length === 0){
      panel.innerHTML = '<div class="room-picker-empty">No rooms available right now.</div>';
    } else {
      panel.innerHTML = rooms.map(function(r){
        var catName = roomCategoryName(r.categoryId);
        var needsSetup = !r.categoryId || !r.price;
        var amenities = (r.amenities || []).slice(0, 4).map(function(a){ return '<span class="rpc-amenity">'+escapeHtml(a)+'</span>'; }).join('');
        var moreCount = (r.amenities || []).length - 4;
        if(moreCount > 0) amenities += '<span class="rpc-amenity">+'+moreCount+' more</span>';
        return '<div class="room-picker-card" data-room-id="'+r.id+'">'
          + '<div class="rpc-left">'
          + '<div class="rpc-title">Room '+escapeHtml(String(r.roomNo))+' <span class="rpc-badge">'+escapeHtml(catName)+'</span> <span class="rpc-badge ac">'+(r.ac?'AC':'Non-AC')+'</span></div>'
          + '<div class="rpc-meta">Floor '+escapeHtml(String(r.floor))+' · '+escapeHtml(r.bedType||'Bed type not set')+' · Sleeps '+r.maxAdults+' adult'+(r.maxAdults===1?'':'s')+(r.maxChildren ? ' + '+r.maxChildren+' child'+(r.maxChildren===1?'':'ren') : '')+(r.extraBedAllowed ? ' · Extra bed '+money(r.extraBedPrice) : '')+'</div>'
          + (amenities ? '<div class="rpc-amenities">'+amenities+'</div>' : '')
          + (needsSetup ? '<div class="rpc-warn">⚠ Category/price not set — finish this in Room Setup</div>' : '')
          + '</div>'
          + '<div class="rpc-price">'+money(r.price)+'<small>/night</small></div>'
          + '</div>';
      }).join('');
    }
    panel.querySelectorAll('.room-picker-card').forEach(function(card){
      card.addEventListener('click', function(){
        var sel = document.getElementById('roomNo');
        sel.value = card.dataset.roomId;
        sel.dispatchEvent(new Event('change'));
        wrap.classList.remove('open');
        updateRoomPickerBtnText(rooms, card.dataset.roomId);
      });
    });

    updateRoomPickerBtnText(rooms, selectedId);
  }
  function updateRoomPickerBtnText(rooms, selectedId){
    var btnText = document.getElementById('roomPickerBtnText');
    if(!btnText) return;
    var selectedRoom = rooms.find(function(r){ return r.id === selectedId; });
    btnText.textContent = selectedRoom
      ? 'Room ' + selectedRoom.roomNo + ' — ' + roomCategoryName(selectedRoom.categoryId) + ' (' + (selectedRoom.ac?'AC':'Non-AC') + ') — ' + money(selectedRoom.price) + '/night'
      : (rooms.length === 0 ? 'No rooms available' : 'Select a room');
  }
  (function(){
    var wrap = document.getElementById('roomPickerWrap');
    var btn = document.getElementById('roomPickerBtn');
    if(!wrap || !btn) return;
    btn.addEventListener('click', function(e){
      e.stopPropagation();
      wrap.classList.toggle('open');
    });
    document.addEventListener('click', function(e){
      if(wrap.classList.contains('open') && !wrap.contains(e.target)) wrap.classList.remove('open');
    });
  })();
  var roomNoSelectEl = document.getElementById('roomNo');
  if(roomNoSelectEl) roomNoSelectEl.addEventListener('change', function(){ updateRoomSelectedInfo(); autofillRoomCharge(); updateEarlyCheckinFeeLineItem(); });

  // ---------- early check-in fee (auto-managed line item) ----------
  var EARLY_CHECKIN_FEE_ITEM_ID = 'auto-early-checkin-fee';
  function timeToMinutes(t){ var parts = t.split(':'); return parseInt(parts[0],10)*60 + (parseInt(parts[1],10)||0); }
  function updateEarlyCheckinFeeLineItem(){
    roomDraft.items = roomDraft.items.filter(function(it){ return it.id !== EARLY_CHECKIN_FEE_ITEM_ID; });
    var checkInVal = document.getElementById('roomCheckIn').value;
    var wrap = document.getElementById('roomArrivalTimeWrap');
    var isToday = checkInVal && checkInVal === localDateStr(new Date());
    wrap.style.display = isToday ? '' : 'none';
    if(isToday){
      var timeInput = document.getElementById('roomArrivalTime');
      if(!timeInput.value){
        var now = new Date();
        timeInput.value = String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0');
      }
      var feePerHour = state.restaurant.earlyCheckinFeePerHour || 0;
      var stdCheckIn = state.restaurant.standardCheckInTime || '12:00';
      if(feePerHour > 0 && timeInput.value){
        var arrivalMins = timeToMinutes(timeInput.value);
        var stdMins = timeToMinutes(stdCheckIn);
        if(arrivalMins < stdMins){
          var hoursEarly = Math.ceil((stdMins - arrivalMins) / 60);
          var fee = hoursEarly * feePerHour;
          roomDraft.items.push({ id: EARLY_CHECKIN_FEE_ITEM_ID, name: 'Early check-in fee (' + hoursEarly + ' hr' + (hoursEarly===1?'':'s') + ' early)', price: fee, qty: 1, amount: fee });
        }
      }
    }
    renderRoomTicket();
  }
  document.getElementById('roomCheckIn').addEventListener('change', updateEarlyCheckinFeeLineItem);
  document.getElementById('roomArrivalTime').addEventListener('input', updateEarlyCheckinFeeLineItem);
  document.getElementById('roomAdvanceAmount').addEventListener('input', updateRoomBalanceHint);
  function updateRoomBalanceHint(){
    var hintEl = document.getElementById('roomBalanceHint');
    if(!hintEl) return;
    var t = computeTotals(roomDraft.items, state.restaurant.taxRate);
    var advance = parseFloat(document.getElementById('roomAdvanceAmount').value) || 0;
    if(advance > t.total && t.total > 0){
      hintEl.textContent = 'Advance can\'t exceed the total (' + money(t.total) + ').';
      hintEl.style.color = 'var(--danger)';
    } else if(advance > 0){
      hintEl.textContent = 'Balance due at checkout: ' + money(t.total - advance) + '.';
      hintEl.style.color = 'var(--text-secondary)';
    } else {
      hintEl.textContent = 'Leave blank if collecting full payment now.';
      hintEl.style.color = 'var(--text-muted)';
    }
  }
  var roomCheckInEl = document.getElementById('roomCheckIn');
  if(roomCheckInEl) roomCheckInEl.addEventListener('change', autofillRoomCharge);
  var roomCheckOutEl = document.getElementById('roomCheckOut');
  if(roomCheckOutEl) roomCheckOutEl.addEventListener('change', autofillRoomCharge);

  function renderOccupiedRoomsList(){
    var wrap = document.getElementById('roomOccupiedWrap');
    if(!wrap) return;
    var occupied = state.rooms.filter(function(r){ return r.status === 'occupied'; }).sort(function(a,b){ return a.roomNo - b.roomNo; });
    if(occupied.length === 0){
      wrap.innerHTML = emptyState(ICONS.room, 'No occupied rooms', 'Rooms you book will show up here until checkout.');
      return;
    }
    var rows = occupied.map(function(r){
      var b = r.booking || {};
      var inv = (state.roomInvoices||[]).find(function(i){ return i.id === b.invoiceId; });
      var total = inv ? inv.total : null;
      var balance = total != null ? total - (b.advanceAmount||0) : null;
      var paymentHtml = '<span style="color:var(--text-muted);font-size:12px;">—</span>';
      if(total != null){
        if(!b.advanceAmount || b.advanceAmount <= 0){
          paymentHtml = '<span style="color:var(--text-muted);font-size:12px;">Full amount paid</span>';
        } else if(b.balancePaid || balance <= 0){
          paymentHtml = '<span class="badge success">Fully paid</span>';
        } else {
          paymentHtml = 'Advance ' + money(b.advanceAmount) + '<br><span style="color:var(--text-muted);font-size:12px;">Balance ' + money(balance) + ' due</span>'
            + '<br><button class="btn ghost small" data-mark-room-balance="'+b.id+'" style="margin-top:4px;">Mark balance received</button>';
        }
      }
      return '<tr>'
        + '<td data-label="Room No." class="code">'+escapeHtml(String(r.roomNo))+'</td>'
        + '<td data-label="Guest">'+escapeHtml(b.guestName||'—')+'</td>'
        + '<td data-label="Phone">'+escapeHtml(b.guestPhone||'—')+'</td>'
        + '<td data-label="Payment">'+paymentHtml+'</td>'
        + '<td data-label="Check-out">'+escapeHtml(b.checkOut||'—')+'</td>'
        + '<td data-label="Actions"><button class="btn ghost small" data-checkout-room="'+r.id+'">Check out</button></td>'
        + '</tr>';
    }).join('');
    wrap.innerHTML = '<div class="table-scroll"><table class="dtable"><thead><tr><th>Room No.</th><th>Guest</th><th>Phone</th><th>Payment</th><th>Check-out</th><th></th></tr></thead><tbody>'+rows+'</tbody></table></div>';
    wrap.querySelectorAll('[data-mark-room-balance]').forEach(function(btn){
      btn.addEventListener('click', function(){
        api.markRoomBalancePaid(btn.dataset.markRoomBalance).then(function(){
          showToast('Balance marked as received');
          return fetchRoomSetupFromServer();
        }).then(renderOccupiedRoomsList).catch(function(e){ showToast(e.message, 'error'); });
      });
    });
    wrap.querySelectorAll('[data-checkout-room]').forEach(function(btn){
      btn.addEventListener('click', function(){
        var r = state.rooms.find(function(x){ return x.id === btn.dataset.checkoutRoom; });
        if(!r || !r.booking) return;
        var lateFee = computeLateCheckoutFee();
        var desc = 'The room will become available for new bookings.';
        if(lateFee.hoursLate > 0){
          desc = 'Checking out ' + lateFee.hoursLate + ' hour' + (lateFee.hoursLate===1?'':'s') + ' past the standard checkout time — a late checkout fee of ' + money(lateFee.fee) + ' will be added as a new invoice.';
        }
        openConfirm({
          title: 'Check out Room ' + r.roomNo + '?',
          desc: desc,
          confirmLabel: 'Check out',
          onConfirm: function(){
            api.checkoutRoomBooking(r.booking.id).then(function(){
              if(lateFee.fee <= 0) return null;
              return api.createInvoice({
                department: 'room', customerName: r.booking.guestName, customerPhone: r.booking.guestPhone,
                roomBookingId: r.booking.id, subtotal: lateFee.fee, discountAmount: 0, promoCode: null,
                totalAmount: lateFee.fee, paymentMethod: 'Cash',
                items: [{ name: 'Late checkout fee (' + lateFee.hoursLate + ' hr' + (lateFee.hoursLate===1?'':'s') + ' late)', quantity: 1, unitPrice: lateFee.fee, lineTotal: lateFee.fee }]
              });
            }).then(function(feeInvoice){
              return fetchRoomSetupFromServer().then(function(){ return feeInvoice; });
            }).then(function(feeInvoice){
              showToast('Room ' + r.roomNo + ' checked out');
              renderRoomBookingPage();
              renderRoomAvailability();
              renderRoomHistory();
              renderDashboard();
              if(feeInvoice){
                openInvoiceOverlay({
                  id: feeInvoice.id, invoiceNo: feeInvoice.invoice_no, date: feeInvoice.created_at,
                  customerName: r.booking.guestName, customerPhone: r.booking.guestPhone,
                  refLabel: 'Room', refValue: String(r.roomNo), metaRows: [{ label:'Charge', value:'Late checkout fee' }],
                  department: 'room',
                  items: [{ name: 'Late checkout fee (' + lateFee.hoursLate + ' hr' + (lateFee.hoursLate===1?'':'s') + ' late)', price: lateFee.fee, qty: 1, amount: lateFee.fee }],
                  subtotal: lateFee.fee, cgst: 0, sgst: 0, tax: 0, preDiscountTotal: lateFee.fee, discountAmount: 0, promoCode: null, total: lateFee.fee,
                  paymentMethod: 'Cash', restaurant: Object.assign({}, state.restaurant),
                  createdByStaffId: state.session.staffId || '', createdByName: state.session.name || state.session.staffId || 'Staff'
                });
              }
            }).catch(function(e){ showToast(e.message, 'error'); });
          }
        });
      });
    });
  }
  // Compares the current time against the standard checkout time from Room
  // Setup's policy card. Returns { hoursLate, fee } — both 0 if not late,
  // or if the fee-per-hour is 0 (feature turned off).
  function computeLateCheckoutFee(){
    var feePerHour = state.restaurant.lateCheckoutFeePerHour || 0;
    if(feePerHour <= 0) return { hoursLate: 0, fee: 0 };
    var stdMins = timeToMinutes(state.restaurant.standardCheckOutTime || '11:00');
    var now = new Date();
    var nowMins = now.getHours() * 60 + now.getMinutes();
    if(nowMins <= stdMins) return { hoursLate: 0, fee: 0 };
    var hoursLate = Math.ceil((nowMins - stdMins) / 60);
    return { hoursLate: hoursLate, fee: hoursLate * feePerHour };
  }

  function generateBookingInvoice(opts){
    // opts: { btn, draft, nameVal, phoneVal, refLabel, refValue, metaRows, errId, resetIds, department }
    var err = document.getElementById(opts.errId);
    if(!opts.nameVal || !opts.phoneVal || !opts.refValue || opts.draft.items.length === 0){
      err.classList.add('show');
      return;
    }
    err.classList.remove('show');

    var t = computeTotals(opts.draft.items, state.restaurant.taxRate);
    var invoice = {
      id: uid(), invoiceNo: previewInvoiceNo(), date: new Date().toISOString(),
      customerName: opts.nameVal, customerPhone: opts.phoneVal,
      customerEmail: opts.customerEmail || null,
      idProofType: opts.idProofType || null, idProofMasked: opts.idProofMasked || null,
      refLabel: opts.refLabel, refValue: opts.refValue, metaRows: opts.metaRows || [],
      department: opts.department,
      items: opts.draft.items.map(function(l){ return { name:l.name, price:l.price, qty:l.qty, amount:l.amount }; }),
      subtotal: t.subtotal, cgst: t.cgst, sgst: t.sgst, tax: t.tax,
      preDiscountTotal: t.total, discountAmount: 0, promoCode: null,
      total: t.total,
      paymentMethod: opts.draft.paymentMethod,
      restaurant: Object.assign({}, state.restaurant),
      createdByStaffId: state.session.staffId || '',
      createdByName: state.session.name || state.session.staffId || 'Staff'
    };
    setBtnLoading(opts.btn, true, 'Generating invoice…');
    state.invoices.unshift(invoice);
    state.invoiceSeq += 1;
    opts.draft.items = [];

    Promise.all([persistInvoices(), persistInvoiceSeq()]).then(function(){
      setBtnLoading(opts.btn, false, null, 'Generate invoice');
      openInvoiceOverlay(invoice);
      opts.resetIds.forEach(function(id){ var el = document.getElementById(id); if(el) el.value = ''; });
      opts.resetFn(invoice);
      renderHistory();
      renderSalesAnalysis();
      renderDashboard();
    });
  }

  document.getElementById('generateRoomInvoiceBtn').addEventListener('click', function(){
    var name = document.getElementById('roomGuestName').value.trim();
    var phone = document.getElementById('roomGuestPhone').value.trim();
    var email = document.getElementById('roomGuestEmail').value.trim();
    var idType = document.getElementById('roomIdType').value;
    var idNumber = document.getElementById('roomIdNumber').value.trim();
    var roomSel = document.getElementById('roomNo');
    var room = state.rooms.find(function(x){ return x.id === roomSel.value; });
    var checkIn = document.getElementById('roomCheckIn').value;
    var checkOut = document.getElementById('roomCheckOut').value;
    var err = document.getElementById('roomBookingError');
    if(!room || room.status !== 'available' || room.outOfOrder || !name || !phone || roomDraft.items.length === 0){
      err.textContent = 'Select an available room, and add guest name, phone and at least one charge.';
      err.classList.add('show');
      return;
    }
    if(!email || email.indexOf('@') === -1){
      err.textContent = 'Enter a valid email address.';
      err.classList.add('show');
      return;
    }
    if(!idType){
      err.textContent = 'Select an ID proof type.';
      err.classList.add('show');
      return;
    }
    if(!idNumber){
      err.textContent = 'Enter the ID proof number.';
      err.classList.add('show');
      return;
    }
    err.classList.remove('show');
    var t = computeTotals(roomDraft.items, state.restaurant.taxRate);
    var advanceAmount = parseFloat(document.getElementById('roomAdvanceAmount').value) || 0;
    if(advanceAmount > t.total){
      err.textContent = 'Advance can\'t exceed the total (' + money(t.total) + ').';
      err.classList.add('show');
      return;
    }
    var isToday = checkIn === localDateStr(new Date());
    var arrivalTime = document.getElementById('roomArrivalTime').value;
    var checkInISO = checkIn ? (checkIn + 'T' + (isToday && arrivalTime ? arrivalTime : (state.restaurant.standardCheckInTime || '12:00')) + ':00') : new Date().toISOString();
    var metaRows = [{ label:'Category', value: roomCategoryName(room.categoryId) }];
    if(checkIn) metaRows.push({ label:'Check-in', value: checkIn + (isToday && arrivalTime ? ' ' + arrivalTime : '') });
    if(checkOut) metaRows.push({ label:'Check-out', value: checkOut });
    if(advanceAmount > 0){
      metaRows.push({ label:'Advance paid', value: money(advanceAmount) });
      metaRows.push({ label:'Balance due', value: money(t.total - advanceAmount) });
    }
    generateRoomInvoiceViaServer({
      btn: this, room: room, nameVal: name, phoneVal: phone,
      customerEmail: email, idProofType: idType, idProofNumber: idNumber, idProofMasked: maskIdProof(idNumber),
      checkIn: checkInISO, checkOut: checkOut, advanceAmount: advanceAmount, metaRows: metaRows, errId: 'roomBookingError',
      resetIds: ['roomGuestName','roomGuestPhone','roomGuestEmail','roomIdType','roomIdNumber','roomNo','roomCheckIn','roomCheckOut','roomArrivalTime','roomAdvanceAmount']
    });
  });

  // Creates the booking + invoice for a room via the API (so both are visible
  // from any device), then updates the local UI the same way the old local-only
  // flow used to. This mirrors generateBookingInvoice's local math (totals,
  // display shape) but persists through the backend instead of localStorage.
  function generateRoomInvoiceViaServer(opts){
    var err = document.getElementById(opts.errId);
    var t = computeTotals(roomDraft.items, state.restaurant.taxRate);
    setBtnLoading(opts.btn, true, 'Generating invoice…');
    api.createRoomBooking({
      roomId: opts.room.id, guestName: opts.nameVal, guestPhone: opts.phoneVal,
      guestEmail: opts.customerEmail || null, idProofType: opts.idProofType || null, idProofNumber: opts.idProofNumber || null,
      checkIn: opts.checkIn || new Date().toISOString(), checkOut: opts.checkOut || null,
      advanceAmount: opts.advanceAmount || 0, advancePaymentMethod: roomDraft.paymentMethod
    }).then(function(booking){
      return api.createInvoice({
        department: 'room', customerName: opts.nameVal, customerPhone: opts.phoneVal,
        roomBookingId: booking.id, subtotal: t.subtotal, discountAmount: 0, promoCode: null,
        totalAmount: t.total, paymentMethod: roomDraft.paymentMethod,
        items: roomDraft.items.map(function(l){ return { name: l.name, quantity: l.qty, unitPrice: l.price, lineTotal: l.amount }; })
      });
    }).then(function(serverInvoice){
      // Build the same invoice shape the rest of the app (ticket/PDF/overlay) already expects.
      var invoice = {
        id: serverInvoice.id, invoiceNo: serverInvoice.invoice_no, date: serverInvoice.created_at,
        customerName: opts.nameVal, customerPhone: opts.phoneVal, customerEmail: opts.customerEmail || null,
        idProofType: opts.idProofType || null, idProofMasked: opts.idProofMasked || null,
        refLabel: 'Room', refValue: String(opts.room.roomNo), metaRows: opts.metaRows || [],
        department: 'room',
        items: roomDraft.items.map(function(l){ return { name:l.name, price:l.price, qty:l.qty, amount:l.amount }; }),
        subtotal: t.subtotal, cgst: t.cgst, sgst: t.sgst, tax: t.tax,
        preDiscountTotal: t.total, discountAmount: 0, promoCode: null, total: t.total,
        paymentMethod: roomDraft.paymentMethod, advanceAmount: opts.advanceAmount || 0,
        restaurant: Object.assign({}, state.restaurant),
        createdByStaffId: state.session.staffId || '',
        createdByName: state.session.name || state.session.staffId || 'Staff'
      };
      roomDraft.items = [];
      return fetchRoomSetupFromServer().then(function(){ return invoice; });
    }).then(function(invoice){
      setBtnLoading(opts.btn, false, null, 'Generate invoice');
      openInvoiceOverlay(invoice);
      opts.resetIds.forEach(function(id){ var el = document.getElementById(id); if(el) el.value = ''; });
      document.getElementById('roomGuestHistoryCard').style.display = 'none';
      document.querySelectorAll('#roomPaymentMethodBtns .pm-btn').forEach(function(b){ b.classList.toggle('active', b.dataset.method === 'Cash'); });
      roomDraft.paymentMethod = 'Cash';
      document.getElementById('roomArrivalTimeWrap').style.display = 'none';
      renderRoomTicket();
      renderRoomBookingPage();
      renderRoomAvailability();
      renderRoomHistory();
      renderDashboard();
    }).catch(function(e){
      setBtnLoading(opts.btn, false, null, 'Generate invoice');
      err.textContent = e.message; err.classList.add('show');
    });
  }

  // ================= BANQUET HALL MANAGEMENT =================
  // Admin: Setup (configure halls) + Availability (read-only) + History (read-only).
  // Staff (banquet department): find an eligible hall for a customer's request and book it.

  var BANQUET_PRICING_BASES = [
    { key:'hour', label:'Per Hour' },
    { key:'day', label:'Per Day' },
    { key:'week', label:'Per Week' }
  ];
  var DEFAULT_BANQUET_FACILITIES = ['Air Conditioning','Stage','Chairs','Tables','Sound System','Projector','Microphone','Lighting','Decoration','Parking','Wi-Fi','Catering Area','Green Room','Power Backup'];
  function banquetBasisLabel(basis){
    var b = BANQUET_PRICING_BASES.find(function(x){ return x.key === basis; });
    return b ? b.label : basis;
  }
  function newBanquetHall(){
    return { id: uid(), name:'', capacity:0, outOfOrder:false, facilities:[],
      pricing: { hour:{enabled:false, price:0}, day:{enabled:false, price:0}, week:{enabled:false, price:0} } };
  }
  function hallById(id){ return state.banquetHalls.find(function(h){ return h.id === id; }); }
  // One-time repair: bookings saved before a pricing fix could have totalAmount stuck at 0
  // even though unitPrice/durationCount were captured correctly — recompute those in place.
  function repairBanquetBookingTotalsIfNeeded(){
    var changed = false;
    state.banquetBookings.forEach(function(b){
      if((!b.totalAmount || b.totalAmount <= 0) && b.unitPrice > 0 && b.durationCount > 0){
        b.totalAmount = b.unitPrice * b.durationCount;
        changed = true;
      }
    });
    return changed ? persistBanquetBookings() : Promise.resolve();
  }
  function hallSupportsBasis(hall, basis){ return !!(hall.pricing && hall.pricing[basis] && hall.pricing[basis].enabled && hall.pricing[basis].price > 0); }
  function hallEnabledBases(hall){ return BANQUET_PRICING_BASES.filter(function(b){ return hallSupportsBasis(hall, b.key); }); }

  // ---------- Admin: Setup ----------
  function renderBanquetHallTable(){
    var wrap = document.getElementById('banquetHallWrap');
    var countEl = document.getElementById('banquetHallCount');
    if(!wrap) return;
    if(countEl) countEl.textContent = state.banquetHalls.length + ' hall' + (state.banquetHalls.length === 1 ? '' : 's');
    if(state.banquetHalls.length === 0){
      wrap.innerHTML = emptyState(ICONS.banquet, 'No banquet halls yet', 'Click "Add hall" above to configure your first banquet hall.');
      return;
    }
    var rows = state.banquetHalls.map(function(h){
      var pricingHtml = hallEnabledBases(h).map(function(b){ return banquetBasisLabel(b.key) + ': ' + money(h.pricing[b.key].price); }).join('<br>') || '<span style="color:var(--text-muted);">Not configured</span>';
      var facilitiesHtml = h.facilities && h.facilities.length ? escapeHtml(h.facilities.join(', ')) : '<span style="color:var(--text-muted);">—</span>';
      var statusBadge = h.outOfOrder ? '<span class="badge warning">OUT OF ORDER</span>' : '<span class="badge success">AVAILABLE</span>';
      return '<tr>'
        + '<td data-label="Hall name" class="code">'+escapeHtml(h.name)+'</td>'
        + '<td data-label="Capacity">'+h.capacity+' Guests</td>'
        + '<td data-label="Pricing">'+pricingHtml+'</td>'
        + '<td data-label="Facilities" style="max-width:220px;">'+facilitiesHtml+'</td>'
        + '<td data-label="Status">'+statusBadge+'</td>'
        + '<td data-label="Actions" style="white-space:nowrap;"><button class="btn ghost small" data-edit-hall="'+h.id+'">Edit</button> '
        + '<button class="btn danger-ghost small" data-delete-hall="'+h.id+'">Delete</button></td>'
        + '</tr>';
    }).join('');
    wrap.innerHTML = '<div class="table-scroll"><table class="dtable"><thead><tr><th>Hall name</th><th>Capacity</th><th>Pricing</th><th>Facilities</th><th>Status</th><th></th></tr></thead><tbody>'+rows+'</tbody></table></div>';
    wrap.querySelectorAll('[data-edit-hall]').forEach(function(btn){
      btn.addEventListener('click', function(){ openBanquetHallModal(btn.dataset.editHall); });
    });
    wrap.querySelectorAll('[data-delete-hall]').forEach(function(btn){
      btn.addEventListener('click', function(){
        var hId = btn.dataset.deleteHall;
        var hasActive = state.banquetBookings.some(function(b){ return b.hallId === hId && b.status === 'booked'; });
        if(hasActive){ showToast('Cannot delete this hall — it has an active booking.', 'error'); return; }
        var h = hallById(hId);
        openConfirm({
          title: 'Delete hall?',
          desc: '<b>'+escapeHtml(h ? h.name : '')+'</b> and its configuration will be removed. Its booking history is kept.',
          confirmLabel: 'Delete',
          onConfirm: function(){
            api.deleteBanquetHall(hId).then(function(){ return fetchBanquetHallsFromServer(); }).then(function(){
              showToast('Hall deleted'); renderBanquetSetup();
            }).catch(function(e){ showToast(e.message, 'error'); });
          }
        });
      });
    });
  }
  function renderBanquetSetup(){
    fillBanquetPricingForm();
    return fetchBanquetHallsFromServer().then(function(){ renderBanquetHallTable(); }).catch(function(e){
      var wrap = document.getElementById('banquetHallWrap');
      if(wrap) wrap.innerHTML = '<p class="error-text show">'+escapeHtml(e.message)+'</p>';
    });
  }
  function fillBanquetPricingForm(){
    var food = getFoodPackages(), deco = getDecorationPackages();
    document.getElementById('setFoodVegStandard').value = food.find(function(f){ return f.key==='veg_standard'; }).pricePerPlate;
    document.getElementById('setFoodVegPremium').value = food.find(function(f){ return f.key==='veg_premium'; }).pricePerPlate;
    document.getElementById('setFoodNonvegStandard').value = food.find(function(f){ return f.key==='nonveg_standard'; }).pricePerPlate;
    document.getElementById('setFoodNonvegPremium').value = food.find(function(f){ return f.key==='nonveg_premium'; }).pricePerPlate;
    document.getElementById('setDecoBasic').value = deco.find(function(d){ return d.key==='basic'; }).cost;
    document.getElementById('setDecoPremium').value = deco.find(function(d){ return d.key==='premium'; }).cost;
    document.getElementById('setDecoLuxury').value = deco.find(function(d){ return d.key==='luxury'; }).cost;
  }
  document.getElementById('saveBanquetPricingBtn').addEventListener('click', function(){
    var btn = this;
    var updated = Object.assign({}, state.restaurant, {
      foodPackagePrices: {
        veg_standard: parseFloat(document.getElementById('setFoodVegStandard').value) || 0,
        veg_premium: parseFloat(document.getElementById('setFoodVegPremium').value) || 0,
        nonveg_standard: parseFloat(document.getElementById('setFoodNonvegStandard').value) || 0,
        nonveg_premium: parseFloat(document.getElementById('setFoodNonvegPremium').value) || 0
      },
      decorationPackagePrices: {
        basic: parseFloat(document.getElementById('setDecoBasic').value) || 0,
        premium: parseFloat(document.getElementById('setDecoPremium').value) || 0,
        luxury: parseFloat(document.getElementById('setDecoLuxury').value) || 0
      }
    });
    setBtnLoading(btn, true, 'Saving…');
    api.updateRestaurantSettings({ tableCount: state.tableCount, extra: updated }).then(function(){
      state.restaurant = updated;
      setBtnLoading(btn, false, null, 'Save pricing');
      showToast('Food & decoration pricing saved');
      var note = document.getElementById('banquetPricingSavedNote');
      note.style.display = 'inline';
      setTimeout(function(){ note.style.display = 'none'; }, 2000);
    }).catch(function(e){
      setBtnLoading(btn, false, null, 'Save pricing');
      showToast(e.message, 'error');
    });
  });

  // ---------- Admin: hall Add/Edit modal ----------
  var banquetHallModalScrim = wireModal('banquetHallModalScrim', ['banquetHallModalClose','banquetHallModalCancel']);
  var banquetHallEditingId = null;
  function renderBanquetHallEditFacilities(selected){
    var wrap = document.getElementById('banquetHallEditFacilities');
    wrap.innerHTML = DEFAULT_BANQUET_FACILITIES.map(function(a){
      var checked = selected.indexOf(a) > -1 ? ' checked' : '';
      return '<label style="display:flex;align-items:center;gap:7px;font-size:12.5px;font-weight:500;"><input type="checkbox" value="'+escapeHtml(a)+'" data-hall-facility style="width:15px;height:15px;accent-color:var(--accent);margin:0;"'+checked+'> '+escapeHtml(a)+'</label>';
    }).join('');
  }
  function openBanquetHallModal(hallId){
    var isNew = !hallId;
    var h = isNew ? newBanquetHall() : hallById(hallId);
    if(!h) return;
    banquetHallEditingId = isNew ? null : hallId;
    document.getElementById('banquetHallModalTitle').textContent = isNew ? 'Add hall' : 'Edit ' + h.name;
    document.getElementById('banquetHallEditName').value = h.name || '';
    document.getElementById('banquetHallEditCapacity').value = h.capacity || '';
    document.getElementById('banquetHallEditHourEnabled').checked = !!h.pricing.hour.enabled;
    document.getElementById('banquetHallEditHourPrice').value = h.pricing.hour.price || '';
    document.getElementById('banquetHallEditDayEnabled').checked = !!h.pricing.day.enabled;
    document.getElementById('banquetHallEditDayPrice').value = h.pricing.day.price || '';
    document.getElementById('banquetHallEditWeekEnabled').checked = !!h.pricing.week.enabled;
    document.getElementById('banquetHallEditWeekPrice').value = h.pricing.week.price || '';
    document.getElementById('banquetHallEditStatus').value = h.outOfOrder ? 'out_of_order' : 'active';
    renderBanquetHallEditFacilities(h.facilities || []);
    document.getElementById('banquetHallEditError').classList.remove('show');
    banquetHallModalScrim.dataset.newHallData = isNew ? JSON.stringify(h) : '';
    banquetHallModalScrim.classList.add('show');
  }
  document.getElementById('addBanquetHallBtn').addEventListener('click', function(){ openBanquetHallModal(null); });
  document.getElementById('saveBanquetHallEditBtn').addEventListener('click', function(){
    var isNew = !banquetHallEditingId;
    var h = isNew ? JSON.parse(banquetHallModalScrim.dataset.newHallData || JSON.stringify(newBanquetHall())) : hallById(banquetHallEditingId);
    if(!h) return;
    var err = document.getElementById('banquetHallEditError');
    var name = document.getElementById('banquetHallEditName').value.trim();
    var capacity = parseInt(document.getElementById('banquetHallEditCapacity').value, 10);
    var hourEnabled = document.getElementById('banquetHallEditHourEnabled').checked;
    var dayEnabled = document.getElementById('banquetHallEditDayEnabled').checked;
    var weekEnabled = document.getElementById('banquetHallEditWeekEnabled').checked;
    var hourPrice = parseFloat(document.getElementById('banquetHallEditHourPrice').value) || 0;
    var dayPrice = parseFloat(document.getElementById('banquetHallEditDayPrice').value) || 0;
    var weekPrice = parseFloat(document.getElementById('banquetHallEditWeekPrice').value) || 0;
    if(!name){ err.textContent = 'Enter a hall name.'; err.classList.add('show'); return; }
    var dupe = state.banquetHalls.some(function(x){ return x.id !== h.id && x.name.toLowerCase() === name.toLowerCase(); });
    if(dupe){ err.textContent = 'A hall with this name already exists.'; err.classList.add('show'); return; }
    if(!capacity || capacity < 1){ err.textContent = 'Enter a valid capacity.'; err.classList.add('show'); return; }
    if(!hourEnabled && !dayEnabled && !weekEnabled){ err.textContent = 'Enable at least one pricing basis.'; err.classList.add('show'); return; }
    if(hourEnabled && hourPrice <= 0){ err.textContent = 'Enter a valid per-hour price.'; err.classList.add('show'); return; }
    if(dayEnabled && dayPrice <= 0){ err.textContent = 'Enter a valid per-day price.'; err.classList.add('show'); return; }
    if(weekEnabled && weekPrice <= 0){ err.textContent = 'Enter a valid per-week price.'; err.classList.add('show'); return; }
    var wantsOutOfOrder = document.getElementById('banquetHallEditStatus').value === 'out_of_order';
    if(wantsOutOfOrder){
      var hasActive = state.banquetBookings.some(function(b){ return b.hallId === h.id && b.status === 'booked'; });
      if(hasActive){ err.textContent = 'This hall has an active booking — cancel or complete it before marking out of order.'; err.classList.add('show'); return; }
    }
    err.classList.remove('show');
    var payload = {
      name: name, capacity: capacity,
      pricing: { hour:{enabled:hourEnabled, price:hourPrice}, day:{enabled:dayEnabled, price:dayPrice}, week:{enabled:weekEnabled, price:weekPrice} },
      outOfOrder: wantsOutOfOrder,
      facilities: Array.prototype.slice.call(document.querySelectorAll('#banquetHallEditFacilities [data-hall-facility]:checked')).map(function(c){ return c.value; })
    };
    var saveBtn = document.getElementById('saveBanquetHallEditBtn');
    setBtnLoading(saveBtn, true, 'Saving…');
    var savePromise = isNew ? api.createBanquetHall(payload) : api.updateBanquetHall(h.id, payload);
    savePromise.then(function(){ return fetchBanquetHallsFromServer(); }).then(function(){
      setBtnLoading(saveBtn, false, null, 'Save hall');
      banquetHallModalScrim.classList.remove('show');
      showToast('Hall ' + payload.name + ' saved');
      renderBanquetSetup();
      renderBanquetAvailability();
    }).catch(function(e){
      setBtnLoading(saveBtn, false, null, 'Save hall');
      err.textContent = e.message; err.classList.add('show');
    });
  });

  // ---------- Admin: Availability (read-only) ----------
  // A hall's *current* status right now: out of order, booked (an active booking covers this moment), or available.
  function banquetHallCurrentStatus(hall){
    if(hall.outOfOrder) return 'out_of_order';
    var now = Date.now();
    var active = state.banquetBookings.some(function(b){
      return b.hallId === hall.id && b.status === 'booked' && new Date(b.startISO).getTime() <= now && new Date(b.endISO).getTime() > now;
    });
    return active ? 'booked' : 'available';
  }
  function banquetStatusBadge(statusKey){
    var map = { available:['success','AVAILABLE'], booked:['danger','BOOKED'], out_of_order:['warning','OUT OF ORDER'] };
    var m = map[statusKey] || ['info', statusKey.toUpperCase()];
    return '<span class="badge '+m[0]+'">'+m[1]+'</span>';
  }
  function renderBanquetAvailability(){
    var statsWrap = document.getElementById('banquetAvailabilityStats');
    if(!statsWrap) return;
    return fetchBanquetHallsFromServer().then(function(){ return fetchBanquetBookingsFromServer(); }).then(function(){
      renderBanquetAvailabilityBody();
    }).catch(function(e){ statsWrap.innerHTML = '<p class="error-text show">'+escapeHtml(e.message)+'</p>'; });
  }
  function renderBanquetAvailabilityBody(){
    var statsWrap = document.getElementById('banquetAvailabilityStats');
    if(!statsWrap) return;
    var halls = state.banquetHalls;
    var total = halls.length;
    var outOfOrder = halls.filter(function(h){ return h.outOfOrder; }).length;
    var booked = halls.filter(function(h){ return banquetHallCurrentStatus(h) === 'booked'; }).length;
    var available = total - outOfOrder - booked;
    statsWrap.innerHTML =
      kpiCard('Total halls', String(total), 'banquet')
      + kpiCard('Available', String(available), 'check')
      + kpiCard('Booked', String(booked), 'billing')
      + kpiCard('Out of order', String(outOfOrder), 'info');

    var listWrap = document.getElementById('banquetAvailabilityListWrap');
    if(halls.length === 0){
      listWrap.innerHTML = emptyState(ICONS.banquet, 'No halls configured', 'Configure banquet halls in Setup to see live availability here.');
    } else {
      var rows = halls.map(function(h){
        var statusKey = banquetHallCurrentStatus(h);
        var pricingHtml = hallEnabledBases(h).map(function(b){ return banquetBasisLabel(b.key) + ': ' + money(h.pricing[b.key].price); }).join(', ') || '—';
        return '<tr>'
          + '<td data-label="Hall" class="code">'+escapeHtml(h.name)+'</td>'
          + '<td data-label="Capacity">'+h.capacity+' Guests</td>'
          + '<td data-label="Pricing">'+pricingHtml+'</td>'
          + '<td data-label="Status">'+banquetStatusBadge(statusKey)+'</td>'
          + '</tr>';
      }).join('');
      listWrap.innerHTML = '<div class="table-scroll"><table class="dtable"><thead><tr><th>Hall</th><th>Capacity</th><th>Pricing</th><th>Status</th></tr></thead><tbody>'+rows+'</tbody></table></div>';
    }
    renderBanquetCalendar();
  }
  var banquetCalMonth = (function(){ var d = new Date(); d.setDate(1); d.setHours(0,0,0,0); return d; })();
  var banquetCalSelectedDate = null;
  function repeatDots(n){ var s=''; for(var i=0;i<n;i++){ s += '<span class="cal-dot"></span>'; } return s; }
  function renderBanquetCalendar(){
    var gridEl = document.getElementById('banquetCalGrid');
    if(!gridEl) return;
    document.getElementById('banquetCalMonthLabel').textContent = banquetCalMonth.toLocaleDateString('en-IN', { month:'long', year:'numeric' });
    var year = banquetCalMonth.getFullYear(), month = banquetCalMonth.getMonth();
    var startWeekday = new Date(year, month, 1).getDay();
    var daysInMonth = new Date(year, month + 1, 0).getDate();
    var todayStr = new Date().toDateString();
    var countsByDate = {};
    (state.banquetBookings || []).forEach(function(b){
      if(b.status === 'cancelled') return;
      var d = new Date(b.startISO);
      var key = d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
      countsByDate[key] = (countsByDate[key] || 0) + 1;
    });
    var weekdayLabels = ['S','M','T','W','T','F','S'];
    var html = '<div class="cal-grid-head">' + weekdayLabels.map(function(w){ return '<span>'+w+'</span>'; }).join('') + '</div><div class="cal-grid-body">';
    for(var i=0;i<startWeekday;i++){ html += '<span class="cal-cell empty"></span>'; }
    for(var day=1; day<=daysInMonth; day++){
      var dateObj = new Date(year, month, day);
      var key = year + '-' + month + '-' + day;
      var count = countsByDate[key] || 0;
      var isToday = dateObj.toDateString() === todayStr;
      var isSelected = banquetCalSelectedDate && dateObj.toDateString() === banquetCalSelectedDate.toDateString();
      html += '<button type="button" class="cal-cell' + (isToday?' today':'') + (isSelected?' selected':'') + '" data-cal-day="' + day + '">'
        + '<span class="cal-day-num">' + day + '</span>'
        + (count > 0 ? '<span class="cal-dot-wrap">' + repeatDots(Math.min(count,3)) + (count>3?'<span class="cal-more">+'+(count-3)+'</span>':'') + '</span>' : '')
        + '</button>';
    }
    html += '</div>';
    gridEl.innerHTML = html;
    gridEl.querySelectorAll('[data-cal-day]').forEach(function(btn){
      btn.addEventListener('click', function(){
        banquetCalSelectedDate = new Date(year, month, parseInt(btn.dataset.calDay, 10));
        renderBanquetCalendar();
        renderBanquetCalDay();
      });
    });
  }
  function renderBanquetCalDay(){
    var wrap = document.getElementById('banquetCalDayWrap');
    if(!wrap) return;
    if(!banquetCalSelectedDate){
      wrap.innerHTML = '<p class="hint" style="margin:0;">Click a date above to see which halls are booked that day.</p>';
      return;
    }
    if(state.banquetHalls.length === 0){
      wrap.innerHTML = emptyState(ICONS.banquet, 'No halls configured', 'Configure banquet halls in Setup first.');
      return;
    }
    var dayStart = new Date(banquetCalSelectedDate); dayStart.setHours(0,0,0,0);
    var dayEnd = new Date(banquetCalSelectedDate); dayEnd.setHours(23,59,59,999);
    var dateLabel = banquetCalSelectedDate.toLocaleDateString('en-IN', { weekday:'long', day:'2-digit', month:'long', year:'numeric' });
    var rows = state.banquetHalls.map(function(h){
      var overlapping = state.banquetBookings.filter(function(b){
        return b.hallId === h.id && b.status === 'booked' && new Date(b.startISO).getTime() <= dayEnd.getTime() && new Date(b.endISO).getTime() >= dayStart.getTime();
      });
      var statusKey = h.outOfOrder ? 'out_of_order' : (overlapping.length ? 'booked' : 'available');
      var detail = overlapping.map(function(b){
        return escapeHtml(b.customerName) + ' · ' + new Date(b.startISO).toLocaleString('en-IN', {dateStyle:'short', timeStyle:'short'}) + ' – ' + new Date(b.endISO).toLocaleString('en-IN', {dateStyle:'short', timeStyle:'short'});
      }).join('<br>') || '—';
      return '<tr>'
        + '<td data-label="Hall" class="code">'+escapeHtml(h.name)+'</td>'
        + '<td data-label="Status">'+banquetStatusBadge(statusKey)+'</td>'
        + '<td data-label="Bookings that day">'+detail+'</td>'
        + '</tr>';
    }).join('');
    wrap.innerHTML = '<p class="section-block-label" style="margin-bottom:10px;">'+dateLabel+'</p><div class="table-scroll"><table class="dtable"><thead><tr><th>Hall</th><th>Status</th><th>Bookings that day</th></tr></thead><tbody>'+rows+'</tbody></table></div>';
  }
  document.getElementById('banquetCalPrev').addEventListener('click', function(){ banquetCalMonth.setMonth(banquetCalMonth.getMonth()-1); renderBanquetCalendar(); });
  document.getElementById('banquetCalNext').addEventListener('click', function(){ banquetCalMonth.setMonth(banquetCalMonth.getMonth()+1); renderBanquetCalendar(); });
  document.getElementById('banquetCalToday').addEventListener('click', function(){
    var d = new Date(); d.setDate(1); d.setHours(0,0,0,0);
    banquetCalMonth = d;
    banquetCalSelectedDate = new Date();
    renderBanquetCalendar();
    renderBanquetCalDay();
  });

  // ---------- Admin: History (read-only) ----------
  function banquetBookingRow(b){
    var h = hallById(b.hallId);
    var statusMap = { booked:'info', completed:'success', cancelled:'danger' };
    var balance = b.totalAmount - b.advanceAmount;
    var paymentHtml = b.advanceAmount <= 0
      ? '<span style="color:var(--text-muted);font-size:12px;">Full amount due</span>'
      : (b.balancePaid || balance <= 0)
        ? '<span class="badge success">Fully paid</span>'
        : 'Advance ' + money(b.advanceAmount) + '<br><span style="color:var(--text-muted);font-size:12px;">Balance ' + money(balance) + ' due</span>';
    return '<tr>'
      + '<td data-label="Booking ID" class="code">'+escapeHtml(b.bookingCode)+'</td>'
      + '<td data-label="Hall">'+escapeHtml(h ? h.name : '—')+'</td>'
      + '<td data-label="Customer">'+escapeHtml(b.customerName)+'<br><span style="color:var(--text-muted);font-size:12px;">'+escapeHtml(b.customerPhone)+'</span></td>'
      + '<td data-label="Event">'+escapeHtml(b.eventType || '—')+'</td>'
      + '<td data-label="Guests">'+b.guestCount+'</td>'
      + '<td data-label="Pricing">'+banquetBasisLabel(b.pricingBasis)+' × '+b.durationCount+'</td>'
      + '<td data-label="Schedule">'+new Date(b.startISO).toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short'})+' – '+new Date(b.endISO).toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short'})+'</td>'
      + '<td data-label="Staff">'+escapeHtml(b.createdByName||'—')+'</td>'
      + '<td data-label="Total" class="amt">'+money(b.totalAmount)+'</td>'
      + '<td data-label="Payment">'+paymentHtml+'</td>'
      + '<td data-label="Status"><span class="badge '+(statusMap[b.status]||'info')+'">'+b.status.toUpperCase()+'</span></td>'
      + '<td data-label="Invoice">'+(b.invoiceId ? '<button class="btn ghost small" data-view-banquet-invoice="'+b.invoiceId+'">View</button>' : '<span style="color:var(--text-muted);font-size:12px;">Not billed yet</span>')+'</td>'
      + '</tr>';
  }
  // Fills in an invoice fetched via GET /api/invoices/:id with the hall
  // name + schedule from the matching local booking, since those live on
  // banquet_bookings rather than the invoice row itself.
  function mapServerBanquetInvoiceListRow(row, booking){
    var staffAcct = state.staff.find(function(s){ return s.staffId === row.created_by_staff_id; });
    var tax = Number(row.total_amount) + Number(row.discount_amount) - Number(row.subtotal);
    var hall = booking ? hallById(booking.hallId) : null;
    var metaRows = [];
    if(booking){
      metaRows.push({ label:'Event type', value: booking.eventType || '—' });
      metaRows.push({ label:'Guests', value: String(booking.guestCount) });
      metaRows.push({ label:'Schedule', value: new Date(booking.startISO).toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short'}) + ' – ' + new Date(booking.endISO).toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short'}) });
      if(booking.foodPackage) metaRows.push({ label:'Food package', value: booking.foodPackage });
      if(booking.decorationPackage) metaRows.push({ label:'Decoration', value: booking.decorationPackage });
    }
    return {
      id: row.id, invoiceNo: row.invoice_no, date: row.created_at,
      customerName: row.customer_name, customerPhone: row.customer_phone,
      refLabel: 'Banquet Hall', refValue: hall ? hall.name : (booking ? booking.bookingCode : null),
      metaRows: metaRows, department: row.department,
      subtotal: Number(row.subtotal), tax: tax, cgst: tax/2, sgst: tax/2,
      preDiscountTotal: Number(row.subtotal) + tax, discountAmount: Number(row.discount_amount) || 0,
      promoCode: row.promo_code, total: Number(row.total_amount), paymentMethod: row.payment_method,
      advanceAmount: booking ? booking.advanceAmount : 0,
      items: (row.items || []).map(function(it){ return { name: it.name, price: Number(it.unit_price), qty: Number(it.quantity), amount: Number(it.line_total) }; }),
      restaurant: Object.assign({}, state.restaurant),
      createdByStaffId: row.created_by_staff_id, createdByName: staffAcct ? staffAcct.name : (row.created_by_staff_id || 'Admin')
    };
  }
  document.getElementById('exportBanquetHistoryBtn').addEventListener('click', function(){
    exportRowsToExcel('banquet_bookings', (state.banquetBookings || []).map(function(b){
      var hall = hallById(b.hallId);
      return {
        bookingCode: b.bookingCode, customerName: b.customerName, customerPhone: b.customerPhone,
        hall: hall ? hall.name : '—', eventType: b.eventType || '', startDate: localDateStr(new Date(b.startISO)),
        endDate: localDateStr(new Date(b.endISO)), totalAmount: b.totalAmount, status: b.status,
        advanceAmount: b.advanceAmount, balancePaid: b.balancePaid ? 'Yes' : 'No', createdBy: b.createdByName || b.createdByStaffId || 'Admin'
      };
    }), [
      { key:'bookingCode', label:'Booking Code' }, { key:'customerName', label:'Customer Name' },
      { key:'customerPhone', label:'Phone' }, { key:'hall', label:'Hall' }, { key:'eventType', label:'Event Type' },
      { key:'startDate', label:'Start Date' }, { key:'endDate', label:'End Date' },
      { key:'totalAmount', label:'Total (₹)' }, { key:'status', label:'Status' },
      { key:'advanceAmount', label:'Advance (₹)' }, { key:'balancePaid', label:'Balance Paid' }, { key:'createdBy', label:'Staff' }
    ]);
  });
  function renderBanquetHistory(){
    var wrap = document.getElementById('banquetHistoryWrap');
    var summaryWrap = document.getElementById('banquetHistorySummary');
    if(!wrap) return;
    return Promise.all([fetchBanquetHallsFromServer(), fetchBanquetBookingsFromServer()]).then(function(){
      renderBanquetHistoryBody();
    }).catch(function(e){ wrap.innerHTML = '<p class="error-text show">'+escapeHtml(e.message)+'</p>'; });
  }
  function renderBanquetHistoryBody(){
    var wrap = document.getElementById('banquetHistoryWrap');
    var summaryWrap = document.getElementById('banquetHistorySummary');
    if(!wrap) return;
    var hallSel = document.getElementById('banquetHistHall');
    if(!hallSel.dataset.wired){
      hallSel.dataset.wired = '1';
      hallSel.addEventListener('change', renderBanquetHistory);
      document.getElementById('banquetHistStatus').addEventListener('change', renderBanquetHistory);
      document.getElementById('banquetHistSearch').addEventListener('input', renderBanquetHistory);
    }
    var curHallVal = hallSel.value;
    hallSel.innerHTML = '<option value="">All halls</option>' + state.banquetHalls.map(function(h){ return '<option value="'+h.id+'">'+escapeHtml(h.name)+'</option>'; }).join('');
    hallSel.value = curHallVal;

    var all = state.banquetBookings.slice().sort(function(a,b){ return new Date(b.createdAt) - new Date(a.createdAt); });
    if(state.session.role === 'staff'){
      var cutoff15b = Date.now() - 15 * 86400000;
      all = all.filter(function(b){ return new Date(b.createdAt).getTime() >= cutoff15b; });
    }
    if(all.length === 0){
      summaryWrap.innerHTML = '';
      wrap.innerHTML = emptyState(ICONS.history, 'No banquet bookings yet', 'Bookings Staff make will show up here.');
      return;
    }
    var q = (document.getElementById('banquetHistSearch').value || '').trim().toLowerCase();
    var hallFilter = hallSel.value;
    var statusFilter = document.getElementById('banquetHistStatus').value;
    var list = all.filter(function(b){
      if(hallFilter && b.hallId !== hallFilter) return false;
      if(statusFilter && b.status !== statusFilter) return false;
      if(q){
        var hay = (b.customerName+' '+b.customerPhone+' '+b.bookingCode).toLowerCase();
        if(hay.indexOf(q) === -1) return false;
      }
      return true;
    });
    var totalSales = list.reduce(function(s,b){ return s + (b.status !== 'cancelled' ? (Number(b.totalAmount)||0) : 0); }, 0);
    summaryWrap.innerHTML = '<div class="summary-strip">'
      + '<div class="summary-chip"><p class="sc-label">Total billed</p><p class="sc-value">'+money(totalSales)+'</p></div>'
      + '<div class="summary-chip"><p class="sc-label">Bookings</p><p class="sc-value">'+list.length+'</p></div>'
      + '</div>';
    if(list.length === 0){
      wrap.innerHTML = emptyState(ICONS.history, 'No bookings match', 'Try a different search or filter.');
      return;
    }
    var rows = list.map(banquetBookingRow).join('');
    wrap.innerHTML = '<div class="table-scroll"><table class="dtable"><thead><tr><th>Booking ID</th><th>Hall</th><th>Customer</th><th>Event</th><th>Guests</th><th>Pricing</th><th>Schedule</th><th>Staff</th><th class="amt">Total</th><th>Payment</th><th>Status</th><th>Invoice</th></tr></thead><tbody>'+rows+'</tbody></table></div>';
    wrap.querySelectorAll('[data-view-banquet-invoice]').forEach(function(btn){
      btn.addEventListener('click', function(){
        var invoiceId = btn.dataset.viewBanquetInvoice;
        var booking = state.banquetBookings.find(function(b){ return b.invoiceId === invoiceId; });
        api.getInvoice(invoiceId).then(function(row){
          openInvoiceOverlay(mapServerBanquetInvoiceListRow(row, booking));
        }).catch(function(e){ showToast(e.message, 'error'); });
      });
    });
  }

  // ---------- Staff: booking flow ----------
  function nextBanquetBookingCode(){
    var d = new Date();
    var ymd = d.getFullYear() + String(d.getMonth()+1).padStart(2,'0') + String(d.getDate()).padStart(2,'0');
    var seq = state.banquetBookings.filter(function(b){ return b.bookingCode && b.bookingCode.indexOf('BH-'+ymd) === 0; }).length + 1;
    return 'BH-' + ymd + '-' + String(seq).padStart(4,'0');
  }
  function banquetHallHasConflict(hallId, startMs, endMs, excludeBookingId){
    return state.banquetBookings.some(function(b){
      if(b.hallId !== hallId || b.status === 'cancelled') return false;
      if(excludeBookingId && b.id === excludeBookingId) return false;
      var bs = new Date(b.startISO).getTime(), be = new Date(b.endISO).getTime();
      return startMs < be && endMs > bs;
    });
  }
  // Reads the schedule form and returns { basis, startMs, endMs, durationCount } or null if the form is incomplete/invalid.
  function readBanquetScheduleForm(){
    var dateVal = document.getElementById('banquetEventDate').value;
    var basis = document.getElementById('banquetPricingBasis').value;
    if(!dateVal) return null;
    if(basis === 'hour'){
      var startTime = document.getElementById('banquetStartTime').value;
      var hours = parseFloat(document.getElementById('banquetHours').value);
      if(!startTime || !hours || hours <= 0) return null;
      var startMs = new Date(dateVal + 'T' + startTime + ':00').getTime();
      var endMs = startMs + hours * 3600000;
      return { basis:'hour', startMs:startMs, endMs:endMs, durationCount: hours };
    }
    if(basis === 'day'){
      var days = parseInt(document.getElementById('banquetDays').value, 10);
      if(!days || days <= 0) return null;
      var dStartMs = new Date(dateVal + 'T00:00:00').getTime();
      var dEndMs = dStartMs + days * 86400000;
      return { basis:'day', startMs:dStartMs, endMs:dEndMs, durationCount: days };
    }
    if(basis === 'week'){
      var weeks = parseInt(document.getElementById('banquetWeeks').value, 10);
      if(!weeks || weeks <= 0) return null;
      var wStartMs = new Date(dateVal + 'T00:00:00').getTime();
      var wEndMs = wStartMs + weeks * 7 * 86400000;
      return { basis:'week', startMs:wStartMs, endMs:wEndMs, durationCount: weeks };
    }
    return null;
  }
  function updateBanquetBasisFieldsVisibility(){
    var basis = document.getElementById('banquetPricingBasis').value;
    document.getElementById('banquetHourFieldWrap').style.display = basis === 'hour' ? '' : 'none';
    document.getElementById('banquetHourDurationWrap').style.display = basis === 'hour' ? '' : 'none';
    document.getElementById('banquetDaysWrap').style.display = basis === 'day' ? '' : 'none';
    document.getElementById('banquetWeeksWrap').style.display = basis === 'week' ? '' : 'none';
  }
  document.getElementById('banquetPricingBasis').addEventListener('change', updateBanquetBasisFieldsVisibility);
  updateBanquetBasisFieldsVisibility();

  var banquetSelectedHallId = null;
  var banquetSelectedSchedule = null;

  function renderBanquetEligibleHalls(){
    var card = document.getElementById('banquetEligibleHallsCard');
    var wrap = document.getElementById('banquetEligibleHallsWrap');
    var err = document.getElementById('banquetScheduleError');
    var guestCount = parseInt(document.getElementById('banquetGuestCount').value, 10);
    var schedule = readBanquetScheduleForm();
    if(!guestCount || guestCount < 1 || !schedule || schedule.endMs <= schedule.startMs){
      err.classList.add('show');
      card.style.display = 'none';
      document.getElementById('banquetConfirmWrap').style.display = 'none';
      return;
    }
    err.classList.remove('show');
    var eligible = state.banquetHalls.filter(function(h){
      if(h.outOfOrder) return false;
      if(h.capacity < guestCount) return false;
      if(!hallSupportsBasis(h, schedule.basis)) return false;
      if(banquetHallHasConflict(h.id, schedule.startMs, schedule.endMs)) return false;
      return true;
    });
    card.style.display = '';
    banquetSelectedSchedule = schedule;
    banquetSelectedHallId = null;
    document.getElementById('banquetConfirmWrap').style.display = 'none';
    if(eligible.length === 0){
      var anyCapacityIssue = state.banquetHalls.some(function(h){ return !h.outOfOrder && h.capacity < guestCount; });
      wrap.innerHTML = emptyState(ICONS.banquet, 'No hall fits this request',
        anyCapacityIssue ? 'Guest count exceeds this hall\'s maximum capacity for one or more halls. Try fewer guests or a different date/time.' : 'No hall is available and free for this date/time. Try a different date, time or pricing basis.');
      return;
    }
    wrap.innerHTML = eligible.map(function(h){
      var price = h.pricing[schedule.basis].price;
      var total = price * schedule.durationCount;
      return '<div class="card" style="margin-bottom:12px;padding:14px 16px;display:flex;justify-content:space-between;align-items:center;gap:14px;flex-wrap:wrap;">'
        + '<div><p style="margin:0 0 4px;font-weight:700;">'+escapeHtml(h.name)+'</p>'
        + '<p class="hint" style="margin:0;">Capacity: '+h.capacity+' Guests · '+banquetBasisLabel(schedule.basis)+': '+money(price)+' × '+schedule.durationCount+' = <b>'+money(total)+'</b>'
        + (h.facilities && h.facilities.length ? '<br>'+escapeHtml(h.facilities.join(', ')) : '')+'</p></div>'
        + '<button class="btn accent small" data-select-hall="'+h.id+'">Select</button>'
        + '</div>';
    }).join('');
    wrap.querySelectorAll('[data-select-hall]').forEach(function(btn){
      btn.addEventListener('click', function(){ selectBanquetHallForBooking(btn.dataset.selectHall); });
    });
  }
  document.getElementById('findBanquetHallsBtn').addEventListener('click', renderBanquetEligibleHalls);

  // Prices are admin-configurable (Banquet Management → Setup → "Food &
  // decoration pricing"). These functions read the live values every time,
  // falling back to sensible defaults for a tenant that hasn't set them yet.
  function getFoodPackages(){
    var p = state.restaurant.foodPackagePrices || {};
    return [
      { key:'veg_standard', label:'Veg Standard', pricePerPlate: p.veg_standard != null ? p.veg_standard : 400 },
      { key:'veg_premium', label:'Veg Premium', pricePerPlate: p.veg_premium != null ? p.veg_premium : 650 },
      { key:'nonveg_standard', label:'Non-Veg Standard', pricePerPlate: p.nonveg_standard != null ? p.nonveg_standard : 550 },
      { key:'nonveg_premium', label:'Non-Veg Premium', pricePerPlate: p.nonveg_premium != null ? p.nonveg_premium : 800 }
    ];
  }
  function getDecorationPackages(){
    var p = state.restaurant.decorationPackagePrices || {};
    return [
      { key:'basic', label:'Basic', cost: p.basic != null ? p.basic : 8000 },
      { key:'premium', label:'Premium', cost: p.premium != null ? p.premium : 18000 },
      { key:'luxury', label:'Luxury', cost: p.luxury != null ? p.luxury : 35000 }
    ];
  }
  function renderBanquetPackageSelects(){
    var foodSel = document.getElementById('banquetFoodPackage');
    var decoSel = document.getElementById('banquetDecorationPackage');
    if(!foodSel || !decoSel) return;
    var foodVal = foodSel.value, decoVal = decoSel.value;
    foodSel.innerHTML = '<option value="">No catering</option>' + getFoodPackages().map(function(f){
      return '<option value="'+f.key+'">'+f.label+' — '+money(f.pricePerPlate)+'/plate</option>';
    }).join('');
    decoSel.innerHTML = '<option value="">No decoration</option>' + getDecorationPackages().map(function(d){
      return '<option value="'+d.key+'">'+d.label+' — '+money(d.cost)+'</option>';
    }).join('');
    foodSel.value = foodVal; decoSel.value = decoVal;
  }
  var EVENT_PACKAGE_PRESETS = {
    essential: { food:'', decoration:'' },
    premium: { food:'veg_standard', decoration:'basic' },
    luxury: { food:'nonveg_premium', decoration:'luxury' }
  };
  var banquetHallLineItem = null;
  // Rebuilds the full ticket (hall + food + decoration) any time the hall,
  // guest count, or either package selection changes. Food/decoration only
  // show up once a hall has actually been picked, matching the existing
  // "select a hall first" flow.
  function rebuildBanquetDraftItems(){
    var items = [];
    if(banquetHallLineItem) items.push(banquetHallLineItem);
    if(banquetHallLineItem){
      var guestCount = parseInt(document.getElementById('banquetGuestCount').value, 10) || 0;
      var foodKey = document.getElementById('banquetFoodPackage').value;
      var food = getFoodPackages().find(function(f){ return f.key === foodKey; });
      if(food && guestCount > 0){
        items.push({ id: uid(), name: 'Food Package — ' + food.label + ' (' + guestCount + ' plates)', price: food.pricePerPlate, qty: guestCount, amount: food.pricePerPlate * guestCount });
      }
      var decoKey = document.getElementById('banquetDecorationPackage').value;
      var deco = getDecorationPackages().find(function(d){ return d.key === decoKey; });
      if(deco){
        items.push({ id: uid(), name: 'Decoration — ' + deco.label, price: deco.cost, qty: 1, amount: deco.cost });
      }
    }
    banquetDraft.items = items;
    renderBanquetTicket();
    updateBanquetAdvanceHint();
  }
  function updateBanquetAdvanceHint(){
    var hintEl = document.getElementById('banquetBalanceHint');
    if(!hintEl) return;
    var t = computeTotals(banquetDraft.items, state.restaurant.taxRate);
    var advance = parseFloat(document.getElementById('banquetAdvanceAmount').value) || 0;
    if(advance > t.total && t.total > 0){
      hintEl.textContent = 'Advance can\'t exceed the total (' + money(t.total) + ').';
      hintEl.style.color = 'var(--danger)';
    } else if(advance > 0){
      hintEl.textContent = 'Balance due at the event: ' + money(t.total - advance) + '.';
      hintEl.style.color = 'var(--text-secondary)';
    } else {
      hintEl.textContent = 'Leave blank if collecting full payment now.';
      hintEl.style.color = 'var(--text-muted)';
    }
  }
  document.getElementById('banquetPackagePreset').addEventListener('change', function(){
    var preset = EVENT_PACKAGE_PRESETS[this.value];
    if(preset){
      document.getElementById('banquetFoodPackage').value = preset.food;
      document.getElementById('banquetDecorationPackage').value = preset.decoration;
      rebuildBanquetDraftItems();
    }
  });
  document.getElementById('banquetFoodPackage').addEventListener('change', function(){
    document.getElementById('banquetPackagePreset').value = 'custom';
    rebuildBanquetDraftItems();
  });
  document.getElementById('banquetDecorationPackage').addEventListener('change', function(){
    document.getElementById('banquetPackagePreset').value = 'custom';
    rebuildBanquetDraftItems();
  });
  document.getElementById('banquetGuestCount').addEventListener('input', rebuildBanquetDraftItems);
  document.getElementById('banquetAdvanceAmount').addEventListener('input', updateBanquetAdvanceHint);

  function selectBanquetHallForBooking(hallId){
    var h = hallById(hallId);
    var schedule = banquetSelectedSchedule;
    if(!h || !schedule) return;
    // guard against a conflict created since the search (e.g. another staff member just booked it)
    if(banquetHallHasConflict(h.id, schedule.startMs, schedule.endMs)){
      showToast('That hall was just booked for an overlapping time — pick another.', 'error');
      renderBanquetEligibleHalls();
      return;
    }
    banquetSelectedHallId = hallId;
    var price = h.pricing[schedule.basis].price;
    var total = price * schedule.durationCount;
    document.getElementById('banquetSelectedHallInfo').innerHTML =
      '<b>'+escapeHtml(h.name)+'</b><br>Capacity: '+h.capacity+' Guests<br>'
      + banquetBasisLabel(schedule.basis)+': '+money(price)+' × '+schedule.durationCount+'<br>'
      + new Date(schedule.startMs).toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short'})+' – '+new Date(schedule.endMs).toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short'})
      + (h.facilities && h.facilities.length ? '<br>Facilities: '+escapeHtml(h.facilities.join(', ')) : '');
    banquetHallLineItem = { id: uid(), name: h.name + ' — ' + banquetBasisLabel(schedule.basis) + ' × ' + schedule.durationCount, price: price, qty: schedule.durationCount, amount: total };
    rebuildBanquetDraftItems();
    document.getElementById('banquetConfirmWrap').style.display = '';
  }

  // Lets Staff pull an in-house guest's details (name, phone, email, ID proof)
  // straight from their current room booking, so the guest doesn't have to
  // repeat themselves when booking a banquet hall too. Uses a dedicated lookup
  // endpoint (rather than the full Room data) since Banquet staff aren't allowed
  // to fetch Room inventory — this endpoint only reveals one occupied room's guest.
  function banquetAutofillFromRoom(){
    var input = document.getElementById('banquetRoomLookup');
    var hint = document.getElementById('banquetRoomLookupHint');
    var roomNoVal = input.value.trim();
    if(!roomNoVal){
      hint.textContent = 'Enter a room number first.';
      hint.style.color = 'var(--danger)';
      return;
    }
    hint.textContent = 'Looking up…';
    hint.style.color = 'var(--text-muted)';
    api.lookupRoomGuest(roomNoVal).then(function(g){
      document.getElementById('banquetClientName').value = g.guest_name || '';
      document.getElementById('banquetClientPhone').value = g.guest_phone || '';
      document.getElementById('banquetClientEmail').value = g.guest_email || '';
      document.getElementById('banquetIdType').value = g.id_proof_type || '';
      document.getElementById('banquetIdNumber').value = g.id_proof_number || '';
      hint.textContent = 'Details filled in from Room ' + roomNoVal + ' — ' + (g.guest_name || 'guest') + '.';
      hint.style.color = 'var(--success)';
      showToast('Guest details pulled from Room ' + roomNoVal);
    }).catch(function(e){
      hint.textContent = e.message || ('No in-house guest found for room ' + roomNoVal + '.');
      hint.style.color = 'var(--danger)';
    });
  }
  document.getElementById('banquetRoomLookupBtn').addEventListener('click', banquetAutofillFromRoom);
  bindEnterToSubmit(['banquetRoomLookup'], 'banquetRoomLookupBtn');

  // ---------- returning-guest lookup (Room + Banquet booking forms) ----------
  // Fires when the phone field loses focus. Purely informational — never
  // blocks submission, never shows an error toast on "not found" (that's
  // the normal case for a first-time guest, not a failure).
  function checkGuestHistory(phoneInputId, cardId, nameInputId, emailInputId){
    var phoneEl = document.getElementById(phoneInputId);
    var card = document.getElementById(cardId);
    var digits = phoneEl.value.replace(/\D/g, '');
    if(digits.length < 7){ card.style.display = 'none'; return; }
    api.getGuestHistory(digits).then(function(res){
      if(!res || !res.found){ card.style.display = 'none'; return; }
      var lastDate = res.lastStay ? localDateStr(new Date(res.lastStay.date)) : '';
      var lastLabel = res.lastStay ? res.lastStay.label : '';
      card.innerHTML = '<span class="guest-history-card-text">'
        + '<b>Returning guest</b> — ' + res.totalStays + ' previous stay' + (res.totalStays === 1 ? '' : 's')
        + (lastLabel ? ('. Last stayed: ' + escapeHtml(lastLabel) + ' on ' + lastDate) : '')
        + '. Total spent: ' + money(res.totalSpent) + '.</span>'
        + '<button type="button" class="btn ghost small" id="' + cardId + 'UseBtn">Use these details</button>';
      card.style.display = 'flex';
      document.getElementById(cardId + 'UseBtn').addEventListener('click', function(){
        var nameEl = document.getElementById(nameInputId);
        if(nameEl && !nameEl.value.trim()) nameEl.value = res.suggestedName || '';
        if(emailInputId){
          var emailEl = document.getElementById(emailInputId);
          if(emailEl && !emailEl.value.trim() && res.suggestedEmail) emailEl.value = res.suggestedEmail;
        }
        showToast('Guest details filled in from their last visit.');
      });
    }).catch(function(){ card.style.display = 'none'; }); // silent — this is a convenience lookup, not a required step
  }
  document.getElementById('roomGuestPhone').addEventListener('blur', function(){
    checkGuestHistory('roomGuestPhone', 'roomGuestHistoryCard', 'roomGuestName', 'roomGuestEmail');
  });
  document.getElementById('banquetClientPhone').addEventListener('blur', function(){
    checkGuestHistory('banquetClientPhone', 'banquetGuestHistoryCard', 'banquetClientName', 'banquetClientEmail');
  });

  document.getElementById('generateBanquetInvoiceBtn').addEventListener('click', function(){
    var name = document.getElementById('banquetClientName').value.trim();
    var phone = document.getElementById('banquetClientPhone').value.trim();
    var email = document.getElementById('banquetClientEmail').value.trim();
    var idType = document.getElementById('banquetIdType').value;
    var idNumber = document.getElementById('banquetIdNumber').value.trim();
    var guestCount = parseInt(document.getElementById('banquetGuestCount').value, 10);
    var hall = hallById(banquetSelectedHallId);
    var schedule = banquetSelectedSchedule;
    var err = document.getElementById('banquetBookingError');
    if(!name || !phone || !hall || !schedule || banquetDraft.items.length === 0){
      err.textContent = 'Add customer name, phone, email, ID proof and select a hall.';
      err.classList.add('show');
      return;
    }
    if(!email || email.indexOf('@') === -1){
      err.textContent = 'Enter a valid email address.';
      err.classList.add('show');
      return;
    }
    if(!idType){
      err.textContent = 'Select an ID proof type.';
      err.classList.add('show');
      return;
    }
    if(!idNumber){
      err.textContent = 'Enter the ID proof number.';
      err.classList.add('show');
      return;
    }
    if(hall.capacity < guestCount){
      err.textContent = 'Guest count exceeds this hall\'s maximum capacity.';
      err.classList.add('show');
      return;
    }
    if(banquetHallHasConflict(hall.id, schedule.startMs, schedule.endMs)){
      err.textContent = 'This hall was just booked for an overlapping time — pick another.';
      err.classList.add('show');
      return;
    }
    err.classList.remove('show');
    var eventType = document.getElementById('banquetEventType').value;
    var foodKey = document.getElementById('banquetFoodPackage').value;
    var food = getFoodPackages().find(function(f){ return f.key === foodKey; });
    var decoKey = document.getElementById('banquetDecorationPackage').value;
    var deco = getDecorationPackages().find(function(d){ return d.key === decoKey; });
    var t = computeTotals(banquetDraft.items, state.restaurant.taxRate);
    var advanceAmount = parseFloat(document.getElementById('banquetAdvanceAmount').value) || 0;
    if(advanceAmount > t.total){
      err.textContent = 'Advance can\'t exceed the total (' + money(t.total) + ').';
      err.classList.add('show');
      return;
    }
    var metaRows = [
      { label:'Hall', value: hall.name },
      { label:'Event type', value: eventType || '—' },
      { label:'Guests', value: String(guestCount) },
      { label:'Pricing basis', value: banquetBasisLabel(schedule.basis) },
      { label:'Duration', value: String(schedule.durationCount) },
      { label:'Start', value: new Date(schedule.startMs).toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short'}) },
      { label:'End', value: new Date(schedule.endMs).toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short'}) }
    ];
    if(advanceAmount > 0){
      metaRows.push({ label:'Advance paid', value: money(advanceAmount) });
      metaRows.push({ label:'Balance due', value: money(t.total - advanceAmount) });
    }
    var bookingCode = nextBanquetBookingCode();
    generateBanquetInvoiceViaServer({
      btn: this, hall: hall, schedule: schedule, bookingCode: bookingCode, guestCount: guestCount,
      nameVal: name, phoneVal: phone, customerEmail: email, idProofType: idType, idProofMasked: maskIdProof(idNumber),
      eventType: eventType, foodPackageLabel: food ? food.label : null, decorationPackageLabel: deco ? deco.label : null,
      advanceAmount: advanceAmount,
      metaRows: metaRows, errId: 'banquetBookingError',
      resetIds: ['banquetClientName','banquetClientPhone','banquetClientEmail','banquetIdType','banquetIdNumber','banquetRoomLookup','banquetGuestCount','banquetEventDate','banquetStartTime','banquetHours','banquetDays','banquetWeeks','banquetEventType','banquetAdvanceAmount']
    });
  });

  // Same idea as generateRoomInvoiceViaServer: creates the booking + invoice
  // through the API so both are visible from any device, then updates the
  // local UI the way the old local-only flow used to.
  function generateBanquetInvoiceViaServer(opts){
    var err = document.getElementById(opts.errId);
    var t = computeTotals(banquetDraft.items, state.restaurant.taxRate);
    setBtnLoading(opts.btn, true, 'Generating invoice…');
    api.createBanquetBooking({
      bookingCode: opts.bookingCode, hallId: opts.hall.id,
      customerName: opts.nameVal, customerPhone: opts.phoneVal, guestCount: opts.guestCount,
      eventType: opts.eventType || null, foodPackage: opts.foodPackageLabel || null, decorationPackage: opts.decorationPackageLabel || null,
      pricingBasis: opts.schedule.basis, unitPrice: opts.hall.pricing[opts.schedule.basis].price,
      durationCount: opts.schedule.durationCount,
      startISO: new Date(opts.schedule.startMs).toISOString(), endISO: new Date(opts.schedule.endMs).toISOString(),
      totalAmount: t.total, advanceAmount: opts.advanceAmount || 0, advancePaymentMethod: banquetDraft.paymentMethod
    }).then(function(booking){
      return api.createInvoice({
        department: 'banquet', customerName: opts.nameVal, customerPhone: opts.phoneVal,
        banquetBookingId: booking.id, subtotal: t.subtotal, discountAmount: 0, promoCode: null,
        totalAmount: t.total, paymentMethod: banquetDraft.paymentMethod,
        items: banquetDraft.items.map(function(l){ return { name: l.name, quantity: l.qty, unitPrice: l.price, lineTotal: l.amount }; })
      });
    }).then(function(serverInvoice){
      var invoice = {
        id: serverInvoice.id, invoiceNo: serverInvoice.invoice_no, date: serverInvoice.created_at,
        customerName: opts.nameVal, customerPhone: opts.phoneVal, customerEmail: opts.customerEmail || null,
        idProofType: opts.idProofType || null, idProofMasked: opts.idProofMasked || null,
        refLabel: 'Banquet Hall', refValue: opts.hall.name, metaRows: opts.metaRows || [],
        department: 'banquet',
        items: banquetDraft.items.map(function(l){ return { name:l.name, price:l.price, qty:l.qty, amount:l.amount }; }),
        subtotal: t.subtotal, cgst: t.cgst, sgst: t.sgst, tax: t.tax,
        preDiscountTotal: t.total, discountAmount: 0, promoCode: null, total: t.total,
        paymentMethod: banquetDraft.paymentMethod, advanceAmount: opts.advanceAmount || 0,
        restaurant: Object.assign({}, state.restaurant),
        createdByStaffId: state.session.staffId || '',
        createdByName: state.session.name || state.session.staffId || 'Staff'
      };
      banquetDraft.items = [];
      banquetHallLineItem = null;
      return fetchBanquetBookingsFromServer().then(function(){ return invoice; });
    }).then(function(invoice){
      setBtnLoading(opts.btn, false, null, 'Confirm booking & generate invoice');
      opts.resetIds.forEach(function(id){ var el = document.getElementById(id); if(el) el.value = ''; });
      document.getElementById('banquetGuestHistoryCard').style.display = 'none';
      document.getElementById('banquetFoodPackage').value = '';
      document.getElementById('banquetDecorationPackage').value = '';
      document.getElementById('banquetPackagePreset').value = 'custom';
      document.querySelectorAll('#banquetPaymentMethodBtns .pm-btn').forEach(function(b){ b.classList.toggle('active', b.dataset.method === 'Cash'); });
      banquetDraft.paymentMethod = 'Cash';
      banquetSelectedHallId = null;
      banquetSelectedSchedule = null;
      document.getElementById('banquetConfirmWrap').style.display = 'none';
      document.getElementById('banquetEligibleHallsCard').style.display = 'none';
      var lookupHint = document.getElementById('banquetRoomLookupHint');
      if(lookupHint) lookupHint.textContent = '';
      renderBanquetTicket();
      renderBanquetBookingPage();
      renderBanquetAvailability();
      renderDashboard();
      openInvoiceOverlay(invoice);
    }).catch(function(e){
      setBtnLoading(opts.btn, false, null, 'Confirm booking & generate invoice');
      err.textContent = e.message; err.classList.add('show');
    });
  }

  document.getElementById('downloadBanquetQuoteBtn').addEventListener('click', function(){
    var hall = hallById(banquetSelectedHallId);
    var schedule = banquetSelectedSchedule;
    if(!hall || !schedule || banquetDraft.items.length === 0){
      showToast('Select a hall first to generate a quotation.', 'error');
      return;
    }
    if(!window.jspdf || !window.jspdf.jsPDF){
      showToast('PDF library is still loading — try again in a moment.', 'error');
      return;
    }
    var name = document.getElementById('banquetClientName').value.trim() || 'Prospective customer';
    var phone = document.getElementById('banquetClientPhone').value.trim() || '—';
    var eventType = document.getElementById('banquetEventType').value;
    var t = computeTotals(banquetDraft.items, state.restaurant.taxRate);
    var metaRows = [
      { label:'Event type', value: eventType || '—' },
      { label:'Guests', value: document.getElementById('banquetGuestCount').value || '—' },
      { label:'Schedule', value: new Date(schedule.startMs).toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short'}) + ' – ' + new Date(schedule.endMs).toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short'}) }
    ];
    var quoteInv = {
      invoiceNo: 'Estimate #' + Date.now().toString(36).toUpperCase(),
      date: new Date().toISOString(),
      customerName: name, customerPhone: phone, customerEmail: null, idProofMasked: null,
      refLabel: 'Banquet Hall', refValue: hall.name, metaRows: metaRows,
      department: 'banquet', items: banquetDraft.items,
      subtotal: t.subtotal, cgst: t.cgst, sgst: t.sgst, tax: t.tax,
      discountAmount: 0, promoCode: null, total: t.total,
      advanceSuggested: Math.round(t.total * 0.25),
      paymentMethod: 'To be decided', createdByName: state.session.name || (state.session.role === 'admin' ? (state.session.firstName || 'Admin') : 'Staff'),
      restaurant: state.restaurant
    };
    try{
      var doc = buildProfessionalInvoicePdf(quoteInv, { mode:'quotation' });
      doc.save('Quotation-' + hall.name.replace(/\s+/g,'') + '-' + Date.now() + '.pdf');
    }catch(e){
      showToast('Could not generate the quotation PDF: ' + e.message, 'error');
    }
  });

  function renderBanquetStaffBookingsList(){
    var wrap = document.getElementById('banquetStaffBookingsWrap');
    if(!wrap) return;
    return fetchBanquetBookingsFromServer().then(function(){ renderBanquetStaffBookingsListBody(); }).catch(function(e){
      wrap.innerHTML = '<p class="error-text show">'+escapeHtml(e.message)+'</p>';
    });
  }
  function renderBanquetStaffBookingsListBody(){
    var wrap = document.getElementById('banquetStaffBookingsWrap');
    if(!wrap) return;
    var list = state.banquetBookings.slice().sort(function(a,b){ return new Date(b.startISO) - new Date(a.startISO); });
    if(list.length === 0){
      wrap.innerHTML = emptyState(ICONS.banquet, 'No bookings yet', 'Bookings you make will show up here.');
      return;
    }
    var rows = list.map(function(b){
      var h = hallById(b.hallId);
      var statusMap = { booked:'info', completed:'success', cancelled:'danger' };
      var actions = b.status === 'booked'
        ? '<button class="btn ghost small" data-complete-booking="'+b.id+'">Mark completed</button> <button class="btn danger-ghost small" data-cancel-booking="'+b.id+'">Cancel</button>'
        : '—';
      var balance = b.totalAmount - b.advanceAmount;
      var paymentHtml;
      if(b.advanceAmount <= 0){
        paymentHtml = '<span style="color:var(--text-muted);font-size:12px;">Full amount due</span>';
      } else if(b.balancePaid || balance <= 0){
        paymentHtml = '<span class="badge success">Fully paid</span>';
      } else {
        paymentHtml = 'Advance ' + money(b.advanceAmount) + '<br><span style="color:var(--text-muted);font-size:12px;">Balance ' + money(balance) + ' due</span>'
          + (b.status !== 'cancelled' ? '<br><button class="btn ghost small" data-mark-balance="'+b.id+'" style="margin-top:4px;">Mark balance received</button>' : '');
      }
      return '<tr>'
        + '<td data-label="Booking ID" class="code">'+escapeHtml(b.bookingCode)+'</td>'
        + '<td data-label="Hall">'+escapeHtml(h ? h.name : '—')+'</td>'
        + '<td data-label="Customer">'+escapeHtml(b.customerName)+'</td>'
        + '<td data-label="Event">'+escapeHtml(b.eventType || '—')+'</td>'
        + '<td data-label="Schedule">'+new Date(b.startISO).toLocaleString('en-IN',{dateStyle:'short',timeStyle:'short'})+' – '+new Date(b.endISO).toLocaleString('en-IN',{dateStyle:'short',timeStyle:'short'})+'</td>'
        + '<td data-label="Total" class="amt">'+money(b.totalAmount)+'</td>'
        + '<td data-label="Payment">'+paymentHtml+'</td>'
        + '<td data-label="Status"><span class="badge '+(statusMap[b.status]||'info')+'">'+b.status.toUpperCase()+'</span></td>'
        + '<td data-label="Actions" style="white-space:nowrap;">'+actions+'</td>'
        + '</tr>';
    }).join('');
    wrap.innerHTML = '<div class="table-scroll"><table class="dtable"><thead><tr><th>Booking ID</th><th>Hall</th><th>Customer</th><th>Event</th><th>Schedule</th><th class="amt">Total</th><th>Payment</th><th>Status</th><th></th></tr></thead><tbody>'+rows+'</tbody></table></div>';
    wrap.querySelectorAll('[data-mark-balance]').forEach(function(btn){
      btn.addEventListener('click', function(){
        api.markBanquetBalancePaid(btn.dataset.markBalance).then(function(){
          showToast('Balance marked as received'); renderBanquetStaffBookingsList();
        }).catch(function(e){ showToast(e.message, 'error'); });
      });
    });
    wrap.querySelectorAll('[data-complete-booking]').forEach(function(btn){
      btn.addEventListener('click', function(){
        api.setBanquetBookingStatus(btn.dataset.completeBooking, 'completed').then(function(){
          showToast('Booking marked completed'); renderBanquetStaffBookingsList();
        }).catch(function(e){ showToast(e.message, 'error'); });
      });
    });
    wrap.querySelectorAll('[data-cancel-booking]').forEach(function(btn){
      btn.addEventListener('click', function(){
        var b = state.banquetBookings.find(function(x){ return x.id === btn.dataset.cancelBooking; });
        if(!b) return;
        openConfirm({
          title: 'Cancel booking?',
          desc: 'The hall will become available again for the affected period. The booking stays in history as cancelled.',
          confirmLabel: 'Cancel booking',
          onConfirm: function(){
            api.setBanquetBookingStatus(b.id, 'cancelled').then(function(){
              showToast('Booking cancelled'); renderBanquetStaffBookingsList();
            }).catch(function(e){ showToast(e.message, 'error'); });
          }
        });
      });
    });
  }
  function renderBanquetBookingPage(){
    document.getElementById('banquetEligibleHallsCard').style.display = 'none';
    document.getElementById('banquetConfirmWrap').style.display = 'none';
    banquetSelectedHallId = null;
    banquetSelectedSchedule = null;
    banquetHallLineItem = null;
    banquetDraft.items = [];
    document.getElementById('banquetScheduleError').classList.remove('show');
    document.getElementById('banquetBookingError').classList.remove('show');
    updateBanquetBasisFieldsVisibility();
    renderBanquetPackageSelects();
    fetchBanquetHallsFromServer();
    renderBanquetStaffBookingsList();
  }

  // ---------- invoice receipt overlay ----------
  function renderReceiptHtml(inv){
    var r = inv.restaurant;
    var itemsHtml = inv.items.map(function(it){
      return '<div class="r-item-row">'
        + '<span class="iname">'+escapeHtml(it.name)+'</span>'
        + '<span class="leader"></span>'
        + '<span class="iqty">'+it.qty+' x '+money(it.price)+'</span>'
        + '<span class="iamt">'+money(it.amount)+'</span></div>';
    }).join('');
    var dateStr = new Date(inv.date).toLocaleString('en-IN', { dateStyle:'medium', timeStyle:'short' });
    var totalsHtml = '<div class="row"><span>Subtotal</span><span>'+money(inv.subtotal)+'</span></div>';
    if(r.taxRate > 0){
      totalsHtml += '<div class="row"><span>CGST '+(r.taxRate/2).toFixed(1)+'%</span><span>'+money(inv.cgst)+'</span></div>';
      totalsHtml += '<div class="row"><span>SGST '+(r.taxRate/2).toFixed(1)+'%</span><span>'+money(inv.sgst)+'</span></div>';
    }
    if(inv.discountAmount > 0){
      totalsHtml += '<div class="row" style="color:var(--success);"><span>Discount ('+escapeHtml(inv.promoCode)+')</span><span>−'+money(inv.discountAmount)+'</span></div>';
    }
    totalsHtml += '<div class="row grand"><span>Total</span><span>'+money(inv.total)+'</span></div>';
    var paymentHtml = '<div class="r-payment">Paid via <b>'+escapeHtml(inv.paymentMethod || 'Cash')+'</b></div>';
    var staffHtml = inv.createdByName ? '<div class="r-meta-row"><span class="label">Billed by</span><span class="value">'+escapeHtml(inv.createdByName)+'</span></div>' : '';
    var tableHtml = inv.refValue ? '<div class="r-meta-row"><span class="label">'+escapeHtml(inv.refLabel || 'Table')+'</span><span class="value">'+escapeHtml(String(inv.refValue))+'</span></div>' : '';
    var metaRowsHtml = (inv.metaRows || []).map(function(m){
      return '<div class="r-meta-row"><span class="label">'+escapeHtml(m.label)+'</span><span class="value">'+escapeHtml(String(m.value))+'</span></div>';
    }).join('');

    return ''
      + '<div class="r-brand">'
      + (r.logo ? '<img src="'+r.logo+'" alt="" style="max-width:70px;max-height:56px;object-fit:contain;margin:0 auto 8px;display:block;">' : '')
      + '<h3>'+escapeHtml(r.name || 'Business')+'</h3>'
      + (r.address ? '<p>'+escapeHtml(r.address)+'</p>' : '')
      + (r.phone ? '<p>Ph: '+escapeHtml(r.phone)+'</p>' : '')
      + (r.email ? '<p>'+escapeHtml(r.email)+'</p>' : '')
      + (r.gstin ? '<p>GSTIN: '+escapeHtml(r.gstin)+'</p>' : '') + '</div>'
      + '<div class="r-divider"></div>'
      + '<div style="text-align:center;"><span class="r-stamp">Invoice '+escapeHtml(inv.invoiceNo)+'</span></div>'
      + '<div class="r-meta-row"><span class="label">Date</span><span class="value">'+dateStr+'</span></div>'
      + tableHtml
      + metaRowsHtml
      + staffHtml
      + '<div class="r-cust"><div class="cname">'+escapeHtml(inv.customerName)+'</div><div class="cphone">'+escapeHtml(inv.customerPhone)+'</div></div>'
      + '<div class="r-divider"></div>'
      + '<div class="r-items">'+itemsHtml+'</div>'
      + '<div class="r-divider"></div>'
      + '<div class="r-totals">'+totalsHtml+'</div>'
      + paymentHtml
      + (r.footer ? '<div class="r-footer">'+escapeHtml(r.footer)+'</div>' : '')
      + '<div class="r-barcode"></div>';
  }
  // Professional, full-page invoice layout used for Room booking and Banquet
  // hall booking invoices — the Restaurant department keeps the thermal
  // receipt look from renderReceiptHtml above.
  function renderProfessionalReceiptHtml(inv){
    var r = inv.restaurant;
    var dateStr = new Date(inv.date).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' });
    var itemsHtml = inv.items.map(function(it){
      return '<tr><td>'+escapeHtml(it.name)+'</td><td class="num">'+it.qty+'</td><td class="num">'+money(it.price)+'</td><td class="num">'+money(it.amount)+'</td></tr>';
    }).join('');
    var totalsHtml = '<div class="row"><span>Subtotal</span><span>'+money(inv.subtotal)+'</span></div>';
    if(r.taxRate > 0){
      totalsHtml += '<div class="row"><span>CGST '+(r.taxRate/2).toFixed(1)+'%</span><span>'+money(inv.cgst)+'</span></div>';
      totalsHtml += '<div class="row"><span>SGST '+(r.taxRate/2).toFixed(1)+'%</span><span>'+money(inv.sgst)+'</span></div>';
    }
    if(inv.discountAmount > 0){
      totalsHtml += '<div class="row" style="color:#2f7d52;"><span>Discount ('+escapeHtml(inv.promoCode)+')</span><span>−'+money(inv.discountAmount)+'</span></div>';
    }
    totalsHtml += '<div class="row grand"><span>Total</span><span>'+money(inv.total)+'</span></div>';

    var refRowHtml = inv.refValue ? '<div class="kv-row"><span class="l">'+escapeHtml(inv.refLabel||'Ref')+'</span><span class="v">'+escapeHtml(String(inv.refValue))+'</span></div>' : '';
    var metaRowsHtml = (inv.metaRows || []).map(function(m){
      return '<div class="kv-row"><span class="l">'+escapeHtml(m.label)+'</span><span class="v">'+escapeHtml(String(m.value))+'</span></div>';
    }).join('');
    var infoLine = [r.phone?('Ph: '+escapeHtml(r.phone)):null, r.email?escapeHtml(r.email):null, r.gstin?('GSTIN: '+escapeHtml(r.gstin)):null].filter(Boolean).join(' &nbsp;•&nbsp; ');

    return ''
      + '<div class="pro-head">'
      + '<div class="biz">'
      + (r.logo ? '<img src="'+r.logo+'" alt="" style="max-width:64px;max-height:48px;object-fit:contain;margin-bottom:8px;display:block;">' : '')
      + '<h3>'+escapeHtml(r.name || 'Business')+'</h3>'
      + (r.address ? '<p>'+escapeHtml(r.address)+'</p>' : '')
      + (infoLine ? '<p>'+infoLine+'</p>' : '')
      + '</div>'
      + '<div class="doc"><p class="tag">Invoice</p><h4>'+escapeHtml(inv.invoiceNo)+'</h4><p>'+dateStr+'</p></div>'
      + '</div>'
      + '<div class="pro-body">'
      + '<div class="pro-parties">'
      + '<div class="pro-party"><h5>Billed to</h5><div class="pname">'+escapeHtml(inv.customerName)+'</div>'
        + '<p>'+escapeHtml(inv.customerPhone)+'</p>'
        + (inv.customerEmail ? '<p>'+escapeHtml(inv.customerEmail)+'</p>' : '')
        + (inv.idProofMasked ? '<p>'+escapeHtml(inv.idProofType||'ID proof')+': '+escapeHtml(inv.idProofMasked)+'</p>' : '')
        + '</div>'
      + '<div class="pro-party"><h5>'+(inv.department === 'room' ? 'Room details' : 'Booking details')+'</h5>'
        + refRowHtml + metaRowsHtml
        + '</div>'
      + '</div>'
      + '<table class="pro-table"><thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead><tbody>'+itemsHtml+'</tbody></table>'
      + '<div class="pro-totals">'+totalsHtml+'</div>'
      + '</div>'
      + '<div class="pro-foot">'
      + '<div class="terms">'+(r.footer ? escapeHtml(r.footer) : 'Thank you for your business. This is a computer-generated invoice.')+'<br>Billed by '+escapeHtml(inv.createdByName || 'Staff')+' &nbsp;•&nbsp; Paid via '+escapeHtml(inv.paymentMethod || 'Cash')+'</div>'
      + '<div class="sign"><div class="line">Authorized signatory</div></div>'
      + '</div>';
  }
  function isProInvoice(inv){ return inv.department === 'room' || inv.department === 'banquet'; }
  function openInvoiceOverlay(inv){
    state.activeInvoice = inv;
    var pro = isProInvoice(inv);
    var card = document.getElementById('receiptCard');
    card.className = 'receipt' + (pro ? ' pro' : '');
    card.innerHTML = pro ? renderProfessionalReceiptHtml(inv) : renderReceiptHtml(inv);
    document.getElementById('invoiceOverlay').classList.add('show');
  }
  function closeInvoiceOverlay(){ document.getElementById('invoiceOverlay').classList.remove('show'); }
  document.getElementById('closeInvoiceBtn').addEventListener('click', closeInvoiceOverlay);
  document.getElementById('printInvoiceBtn').addEventListener('click', function(){ window.print(); });
  function pdfSafeCurrency(){
    var sym = state.restaurant.currency || '₹';
    for(var i=0;i<sym.length;i++){ if(sym.charCodeAt(i) > 255){ return 'Rs.'; } }
    return sym;
  }
  function pdfMoney(n){
    n = Math.round((n + Number.EPSILON) * 100) / 100;
    return pdfSafeCurrency() + n.toFixed(2);
  }
  function buildInvoicePdfDoc(inv){
    var jsPDFCtor = (window.jspdf && window.jspdf.jsPDF) ? window.jspdf.jsPDF : null;
    if(!jsPDFCtor){ throw new Error('jsPDF not loaded'); }
    var r = inv.restaurant;
    var pageWidth = 100;
    var margin = 8;
    var contentWidth = pageWidth - margin * 2;
    var cx = pageWidth / 2;
    var ink = [27, 26, 23], soft = [97, 92, 82], accent = [185, 138, 47];

    var measureDoc = new jsPDFCtor({ unit: 'mm', format: [pageWidth, 400] });
    measureDoc.setFont('helvetica', 'normal'); measureDoc.setFontSize(8.5);
    var addressLines = r.address ? measureDoc.splitTextToSize(r.address, contentWidth) : [];
    var footerLines = r.footer ? measureDoc.splitTextToSize(r.footer, contentWidth) : [];

    var logoInfo = null, logoW = 0, logoH = 0;
    if(r.logo){
      try{
        logoInfo = measureDoc.getImageProperties(r.logo);
        logoW = 20; logoH = (logoInfo.height / logoInfo.width) * logoW;
        if(logoH > 16){ logoH = 16; logoW = (logoInfo.width / logoInfo.height) * logoH; }
      }catch(e){ logoInfo = null; }
    }

    var y = margin;
    if(logoInfo){ y += logoH + 3; }
    y += 7; y += addressLines.length * 4;
    if(r.phone) y += 4;
    if(r.email) y += 4;
    if(r.gstin) y += 4;
    y += 8; y += 9; y += 6; y += 5 + 5; y += 8;
    y += Math.max(inv.items.length, 1) * 5; y += 8; y += 5;
    if(r.taxRate > 0){ y += 5 + 5; }
    if(inv.discountAmount > 0){ y += 5; }
    y += 8; y += 6;
    if(footerLines.length){ y += footerLines.length * 4 + 4; }
    y += 10; y += margin;
    var pageHeight = y;

    var doc = new jsPDFCtor({ unit: 'mm', format: [pageWidth, pageHeight] });
    var cy = margin;

    function dashedLine(){
      doc.setDrawColor(160, 150, 135);
      doc.setLineDashPattern([1, 1], 0);
      doc.line(margin, cy, pageWidth - margin, cy);
      doc.setLineDashPattern([], 0);
    }

    if(logoInfo){
      doc.addImage(r.logo, logoInfo.fileType, cx - logoW / 2, cy - 4, logoW, logoH);
      cy += logoH + 3;
    }

    doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(ink[0], ink[1], ink[2]);
    doc.text(r.name || 'Business', cx, cy, { align: 'center' });
    cy += 6;

    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(soft[0], soft[1], soft[2]);
    addressLines.forEach(function(line){ doc.text(line, cx, cy, { align: 'center' }); cy += 4; });
    if(r.phone){ doc.text('Ph: ' + r.phone, cx, cy, { align: 'center' }); cy += 4; }
    if(r.email){ doc.text(r.email, cx, cy, { align: 'center' }); cy += 4; }
    if(r.gstin){ doc.text('GSTIN: ' + r.gstin, cx, cy, { align: 'center' }); cy += 4; }

    cy += 2; dashedLine(); cy += 6;

    doc.setDrawColor(accent[0], accent[1], accent[2]); doc.setLineWidth(0.6);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10);
    var stampText = 'INVOICE ' + inv.invoiceNo;
    var stampWidth = doc.getTextWidth(stampText) + 8;
    doc.roundedRect(cx - stampWidth / 2, cy - 5, stampWidth, 8, 1, 1);
    doc.setTextColor(accent[0], accent[1], accent[2]);
    doc.text(stampText, cx, cy, { align: 'center' });
    cy += 9;

    var dateStr = new Date(inv.date).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(soft[0], soft[1], soft[2]);
    doc.text('DATE', margin, cy);
    doc.setFont('helvetica', 'bold'); doc.setTextColor(ink[0], ink[1], ink[2]);
    doc.text(dateStr, pageWidth - margin, cy, { align: 'right' });
    cy += 6;

    doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(ink[0], ink[1], ink[2]);
    doc.text(inv.customerName, margin, cy); cy += 5;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(soft[0], soft[1], soft[2]);
    doc.text(inv.customerPhone, margin, cy); cy += 3;

    cy += 3; dashedLine(); cy += 6;

    doc.setFont('courier', 'normal'); doc.setFontSize(8.5);
    inv.items.forEach(function(it){
      doc.setTextColor(ink[0], ink[1], ink[2]);
      doc.text(it.name, margin, cy);
      doc.setTextColor(soft[0], soft[1], soft[2]);
      doc.text(it.qty + ' x ' + pdfMoney(it.price), pageWidth - margin - 20, cy, { align: 'right' });
      doc.setTextColor(ink[0], ink[1], ink[2]);
      doc.text(pdfMoney(it.amount), pageWidth - margin, cy, { align: 'right' });
      cy += 5;
    });

    cy += 1; dashedLine(); cy += 6;

    function totalRow(label, value, bold, size){
      doc.setFont('courier', bold ? 'bold' : 'normal');
      doc.setFontSize(size || 9);
      doc.setTextColor(ink[0], ink[1], ink[2]);
      doc.text(label, margin, cy);
      doc.text(value, pageWidth - margin, cy, { align: 'right' });
      cy += bold ? 7 : 5;
    }
    totalRow('Subtotal', pdfMoney(inv.subtotal), false);
    if(r.taxRate > 0){
      totalRow('CGST ' + (r.taxRate/2).toFixed(1) + '%', pdfMoney(inv.cgst), false);
      totalRow('SGST ' + (r.taxRate/2).toFixed(1) + '%', pdfMoney(inv.sgst), false);
    }
    if(inv.discountAmount > 0){
      doc.setFont('courier', 'normal'); doc.setFontSize(9); doc.setTextColor(47, 125, 82);
      doc.text('Discount (' + inv.promoCode + ')', margin, cy);
      doc.text('-' + pdfMoney(inv.discountAmount), pageWidth - margin, cy, { align: 'right' });
      cy += 5;
    }
    doc.setDrawColor(ink[0], ink[1], ink[2]);
    doc.line(margin, cy - 4, pageWidth - margin, cy - 4);
    totalRow('Total', pdfMoney(inv.total), true, 12);

    cy += 2;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(soft[0], soft[1], soft[2]);
    doc.text('Paid via ' + (inv.paymentMethod || 'Cash'), cx, cy, { align: 'center' });
    cy += 4;

    if(footerLines.length){
      cy += 3;
      doc.setFont('helvetica', 'italic'); doc.setFontSize(8.5); doc.setTextColor(soft[0], soft[1], soft[2]);
      footerLines.forEach(function(line){ doc.text(line, cx, cy, { align: 'center' }); cy += 4; });
    }

    cy += 4;
    doc.setDrawColor(ink[0], ink[1], ink[2]);
    var barX = margin;
    while(barX < pageWidth - margin){
      var w = (Math.random() > 0.5) ? 0.8 : 0.4;
      doc.setLineWidth(w);
      doc.line(barX, cy, barX, cy + 8);
      barX += w + 0.8;
    }
    return doc;
  }

  // Full-page A4 professional invoice PDF — Room booking & Banquet hall
  // booking. Restaurant invoices keep the thermal-receipt PDF above.
  function buildProfessionalInvoicePdf(inv, pdfOpts){
    pdfOpts = pdfOpts || {};
    var isQuote = pdfOpts.mode === 'quotation';
    var jsPDFCtor = (window.jspdf && window.jspdf.jsPDF) ? window.jspdf.jsPDF : null;
    if(!jsPDFCtor){ throw new Error('jsPDF not loaded'); }
    var r = inv.restaurant;
    var doc = new jsPDFCtor({ unit: 'mm', format: 'a4' });
    var pageWidth = 210, pageHeight = 297, margin = 16;
    var contentWidth = pageWidth - margin * 2;
    var ink = [27,26,23], soft = [97,92,82], muted = [146,140,126], border = [229,226,218], primaryBg = [16,35,61];

    // ---- header band ----
    var headH = 40;
    doc.setFillColor(primaryBg[0], primaryBg[1], primaryBg[2]);
    doc.rect(0, 0, pageWidth, headH, 'F');
    var logoInfo = null, logoW = 0, logoH = 0, bx = margin;
    if(r.logo){
      try{
        logoInfo = doc.getImageProperties(r.logo);
        logoW = 15; logoH = (logoInfo.height / logoInfo.width) * logoW;
        if(logoH > 15){ logoH = 15; logoW = (logoInfo.width / logoInfo.height) * logoH; }
        doc.addImage(r.logo, logoInfo.fileType, bx, 12, logoW, logoH);
        bx += logoW + 6;
      }catch(e){ logoInfo = null; }
    }
    doc.setFont('helvetica', 'bold'); doc.setFontSize(16); doc.setTextColor(243,239,230);
    doc.text(r.name || 'Business', bx, 19);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(169,184,204);
    if(r.address) doc.text(r.address, bx, 25, { maxWidth: 105 });
    var infoLine = [r.phone ? ('Ph: '+r.phone) : null, r.email || null, r.gstin ? ('GSTIN: '+r.gstin) : null].filter(Boolean).join('   |   ');
    if(infoLine) doc.text(infoLine, bx, 31, { maxWidth: 105 });

    doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(224,178,96);
    doc.text(isQuote ? 'QUOTATION' : 'INVOICE', pageWidth - margin, 16, { align: 'right' });
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(200,196,188);
    doc.text(inv.invoiceNo, pageWidth - margin, 23, { align: 'right' });
    var dateStr = new Date(inv.date).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' });
    doc.text(dateStr, pageWidth - margin, 29, { align: 'right' });

    var cy = headH + 14;
    var colX = margin, col2X = pageWidth/2 + 6;

    // ---- bill-to / booking details ----
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(muted[0],muted[1],muted[2]);
    doc.text('BILLED TO', colX, cy);
    doc.text(inv.department === 'room' ? 'ROOM DETAILS' : 'BOOKING DETAILS', col2X, cy);
    cy += 7;
    var leftY = cy, rightY = cy;

    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(ink[0],ink[1],ink[2]);
    doc.text(inv.customerName, colX, leftY); leftY += 5.5;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(soft[0],soft[1],soft[2]);
    doc.text(inv.customerPhone, colX, leftY); leftY += 5;
    if(inv.customerEmail){ doc.text(inv.customerEmail, colX, leftY); leftY += 5; }
    if(inv.idProofMasked){ doc.text((inv.idProofType || 'ID proof') + ': ' + inv.idProofMasked, colX, leftY); leftY += 5; }

    function kvRow(label, value){
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(soft[0],soft[1],soft[2]);
      doc.text(label + ':', col2X, rightY);
      doc.setFont('helvetica', 'bold'); doc.setTextColor(ink[0],ink[1],ink[2]);
      doc.text(String(value), col2X + doc.getTextWidth(label + ':  '), rightY);
      rightY += 5;
    }
    if(inv.refValue) kvRow(inv.refLabel || 'Ref', inv.refValue);
    (inv.metaRows || []).forEach(function(m){ kvRow(m.label, m.value); });

    cy = Math.max(leftY, rightY) + 6;
    doc.setDrawColor(border[0],border[1],border[2]); doc.setLineWidth(0.3);
    doc.line(margin, cy, pageWidth - margin, cy);
    cy += 10;

    // ---- items table ----
    var colQty = pageWidth - margin - 70, colRate = pageWidth - margin - 40, colAmt = pageWidth - margin;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(muted[0],muted[1],muted[2]);
    doc.text('DESCRIPTION', margin, cy);
    doc.text('QTY', colQty, cy, { align: 'right' });
    doc.text('RATE', colRate, cy, { align: 'right' });
    doc.text('AMOUNT', colAmt, cy, { align: 'right' });
    cy += 3;
    doc.setDrawColor(ink[0],ink[1],ink[2]); doc.setLineWidth(0.5);
    doc.line(margin, cy, pageWidth - margin, cy);
    cy += 8;

    doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5);
    inv.items.forEach(function(it){
      if(cy > pageHeight - 55){ doc.addPage(); cy = margin + 10; }
      doc.setTextColor(ink[0],ink[1],ink[2]);
      doc.text(it.name, margin, cy);
      doc.setTextColor(soft[0],soft[1],soft[2]);
      doc.text(String(it.qty), colQty, cy, { align: 'right' });
      doc.text(pdfMoney(it.price), colRate, cy, { align: 'right' });
      doc.setTextColor(ink[0],ink[1],ink[2]);
      doc.text(pdfMoney(it.amount), colAmt, cy, { align: 'right' });
      cy += 4;
      doc.setDrawColor(border[0],border[1],border[2]); doc.setLineWidth(0.2);
      doc.line(margin, cy, pageWidth - margin, cy);
      cy += 6;
    });

    cy += 3;
    var totalsX = pageWidth - margin - 70;
    function totalRow(label, value, bold, size, color){
      doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(size || 9.5);
      var c = color || (bold ? ink : soft);
      doc.setTextColor(c[0], c[1], c[2]);
      doc.text(label, totalsX, cy);
      doc.text(value, pageWidth - margin, cy, { align: 'right' });
      cy += bold ? 8 : 6;
    }
    totalRow('Subtotal', pdfMoney(inv.subtotal));
    if(r.taxRate > 0){
      totalRow('CGST ' + (r.taxRate/2).toFixed(1) + '%', pdfMoney(inv.cgst));
      totalRow('SGST ' + (r.taxRate/2).toFixed(1) + '%', pdfMoney(inv.sgst));
    }
    if(inv.discountAmount > 0){ totalRow('Discount (' + inv.promoCode + ')', '-' + pdfMoney(inv.discountAmount), false, 9.5, [47,125,82]); }
    doc.setDrawColor(ink[0],ink[1],ink[2]); doc.setLineWidth(0.5);
    doc.line(totalsX, cy - 4, pageWidth - margin, cy - 4);
    totalRow('Total', pdfMoney(inv.total), true, 13);
    if(isQuote && inv.advanceSuggested){
      totalRow('Suggested advance to confirm', pdfMoney(inv.advanceSuggested), false, 9.5, [224,178,96]);
    }
    if(!isQuote && inv.advanceAmount > 0){
      totalRow('Advance received', pdfMoney(inv.advanceAmount), false, 9.5, [47,125,82]);
      totalRow('Balance due', pdfMoney(inv.total - inv.advanceAmount), true, 10.5);
    }

    cy += 3;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(soft[0],soft[1],soft[2]);
    doc.text('Payment method: ' + (inv.paymentMethod || 'Cash'), margin, cy); cy += 5;
    doc.text('Billed by: ' + (inv.createdByName || 'Staff'), margin, cy);

    // ---- footer: terms + signature ----
    var footY = pageHeight - 34;
    doc.setDrawColor(border[0],border[1],border[2]); doc.setLineWidth(0.3);
    doc.line(margin, footY, pageWidth - margin, footY);
    footY += 8;
    doc.setFont('helvetica', 'italic'); doc.setFontSize(8.5); doc.setTextColor(muted[0],muted[1],muted[2]);
    var terms = isQuote
      ? 'This is an estimate only, not a tax invoice, and is valid for 7 days from the date above. Final pricing is confirmed once the booking is made.'
      : (r.footer || 'Thank you for choosing us. This is a computer-generated invoice.');
    doc.splitTextToSize(terms, contentWidth * 0.6).forEach(function(line){ doc.text(line, margin, footY); footY += 4; });

    // Stamp + signature — drawn only into the downloaded PDF. The on-screen /
    // printed receipt (renderProfessionalReceiptHtml) intentionally leaves
    // these blank, since a printed invoice gets a real ink stamp on paper.
    var signLineY = pageHeight - 26;
    var signBoxX2 = pageWidth - margin, signBoxX1 = signBoxX2 - 50;
    var stampBoxX2 = signBoxX1 - 8, stampBoxX1 = stampBoxX2 - 38;

    if(r.stamp){
      try{
        var stampInfo = doc.getImageProperties(r.stamp);
        var stH = 20, stW = (stampInfo.width / stampInfo.height) * stH;
        if(stW > stampBoxX2 - stampBoxX1){ stW = stampBoxX2 - stampBoxX1; stH = (stampInfo.height / stampInfo.width) * stW; }
        doc.addImage(r.stamp, stampInfo.fileType, stampBoxX1 + ((stampBoxX2 - stampBoxX1) - stW) / 2, signLineY - stH - 2, stW, stH);
      }catch(e){}
    }
    doc.setDrawColor(210,206,196); doc.setLineWidth(0.3);
    doc.line(stampBoxX1, signLineY, stampBoxX2, signLineY);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(muted[0],muted[1],muted[2]);
    doc.text('Company stamp', (stampBoxX1 + stampBoxX2) / 2, signLineY + 5, { align: 'center' });

    if(r.signature){
      try{
        var sigInfo = doc.getImageProperties(r.signature);
        var sgH = 14, sgW = (sigInfo.width / sigInfo.height) * sgH;
        if(sgW > 44){ sgW = 44; sgH = (sigInfo.height / sigInfo.width) * sgW; }
        doc.addImage(r.signature, sigInfo.fileType, signBoxX1 + (50 - sgW) / 2, signLineY - sgH - 2, sgW, sgH);
      }catch(e){}
    }
    doc.line(signBoxX1, signLineY, signBoxX2, signLineY);
    doc.text('Authorized signatory', (signBoxX1 + signBoxX2) / 2, signLineY + 5, { align: 'center' });

    return doc;
  }

  document.getElementById('downloadPdfBtn').addEventListener('click', function(){
    var btn = document.getElementById('downloadPdfBtn');
    var inv = state.activeInvoice;
    if(!inv){ return; }
    if(!window.jspdf || !window.jspdf.jsPDF){
      showToast('PDF library failed to load — check your internet connection.', 'error');
      return;
    }
    setBtnLoading(btn, true, 'Preparing PDF…');
    try{
      var doc = isProInvoice(inv) ? buildProfessionalInvoicePdf(inv) : buildInvoicePdfDoc(inv);
      doc.save(inv.invoiceNo + '.pdf');
      showToast('Invoice downloaded as PDF');
    } catch(err){
      console.error('PDF generation failed', err);
      showToast('Could not generate the PDF — please try again.', 'error');
    }
    setBtnLoading(btn, false, null, 'Download PDF');
  });

  document.getElementById('whatsappTextBtn').addEventListener('click', function(){
    var btn = this;
    var inv = state.activeInvoice;
    if(!inv){ return; }
    var phone = normalizePhoneForWhatsapp(inv.customerPhone);
    if(!phone){ showToast('Could not read a valid WhatsApp number from this invoice.', 'error'); return; }
    if(!window.jspdf || !window.jspdf.jsPDF){
      showToast('PDF library failed to load — check your internet connection.', 'error');
      return;
    }
    setBtnLoading(btn, true, 'Preparing PDF…');
    var base64;
    try{
      var doc = isProInvoice(inv) ? buildProfessionalInvoicePdf(inv) : buildInvoicePdfDoc(inv);
      var dataUri = doc.output('datauristring');
      base64 = dataUri.slice(dataUri.indexOf(',') + 1);
    } catch(err){
      console.error('PDF generation failed', err);
      setBtnLoading(btn, false, null, 'Send on WhatsApp');
      showToast('Could not generate the PDF — please try again.', 'error');
      return;
    }
    api.uploadInvoicePdf(inv.id, base64).then(function(res){
      setBtnLoading(btn, false, null, 'Send on WhatsApp');
      var text = buildWhatsappMessage(inv, res.url);
      window.open('https://wa.me/' + phone + '?text=' + encodeURIComponent(text), '_blank');
    }).catch(function(e){
      setBtnLoading(btn, false, null, 'Send on WhatsApp');
      showToast(e.message, 'error');
    });
  });
  function normalizePhoneForWhatsapp(phone){
    var digits = String(phone || '').replace(/[^\d+]/g, '');
    if(digits.indexOf('+') === 0){ digits = digits.slice(1); }
    digits = digits.replace(/\D/g, '');
    if(digits.length === 10){ digits = '91' + digits; }
    if(digits.length < 10){ return null; }
    return digits;
  }
  function buildWhatsappMessage(inv, pdfUrl){
    var r = inv.restaurant;
    var dateStr = new Date(inv.date).toLocaleString('en-IN', { dateStyle:'medium', timeStyle:'short' });
    var lines = [];
    lines.push('*' + (r.name || 'Business') + '*');
    lines.push('Invoice: ' + inv.invoiceNo + '  |  ' + dateStr);
    if(inv.refValue){ lines.push((inv.refLabel || 'Table') + ': ' + inv.refValue); } else if(inv.tableNo){ lines.push('Table: ' + inv.tableNo); }
    (inv.metaRows || []).forEach(function(m){ lines.push(m.label + ': ' + m.value); });
    if(inv.customerEmail){ lines.push('Email: ' + inv.customerEmail); }
    if(inv.idProofMasked){ lines.push((inv.idProofType || 'ID proof') + ': ' + inv.idProofMasked); }
    lines.push('');
    lines.push('Hi ' + inv.customerName + ', thanks for your order! Here is your invoice:');
    lines.push('');
    inv.items.forEach(function(it){ lines.push(it.name + '  x' + it.qty + '  ' + money(it.amount)); });
    lines.push('');
    lines.push('Subtotal: ' + money(inv.subtotal));
    if(r.taxRate > 0){
      lines.push('CGST (' + (r.taxRate/2).toFixed(1) + '%): ' + money(inv.cgst));
      lines.push('SGST (' + (r.taxRate/2).toFixed(1) + '%): ' + money(inv.sgst));
    }
    if(inv.discountAmount > 0){ lines.push('Discount (' + inv.promoCode + '): -' + money(inv.discountAmount)); }
    lines.push('*Total: ' + money(inv.total) + '*');
    lines.push('Paid via: ' + (inv.paymentMethod || 'Cash'));
    if(pdfUrl){ lines.push(''); lines.push('📄 Download your invoice PDF: ' + pdfUrl); }
    if(r.footer){ lines.push(''); lines.push(r.footer); }
    return lines.join('\n');
  }
  document.getElementById('newBillBtn').addEventListener('click', function(){
    closeInvoiceOverlay();
    if(state.session.role === 'staff' && state.currentTableId){
      switchTab('table-' + state.currentTableId);
    } else {
      switchTab('billing');
    }
  });
  document.getElementById('invoiceOverlay').addEventListener('click', function(e){
    if(e.target.id === 'invoiceOverlay') closeInvoiceOverlay();
  });

  // ---------- history (admin) ----------
  var historySelected = {};
  var roomHistorySelected = {};
  function metaRowValue(inv, label){
    var m = (inv.metaRows || []).find(function(r){ return r.label === label; });
    return m ? m.value : '';
  }
  function localDateStr(d){
    var yyyy = d.getFullYear(), mm = String(d.getMonth()+1).padStart(2,'0'), dd = String(d.getDate()).padStart(2,'0');
    return yyyy+'-'+mm+'-'+dd;
  }
  function mapServerRestaurantInvoiceListRow(row){
    var staffAcct = state.staff.find(function(s){ return s.staffId === row.created_by_staff_id; });
    var tax = Number(row.total_amount) + Number(row.discount_amount) - Number(row.subtotal);
    return {
      id: row.id, invoiceNo: row.invoice_no, date: row.created_at,
      customerName: row.customer_name, customerPhone: row.customer_phone,
      tableNo: row.table_no, refLabel: 'Table', refValue: row.table_no,
      department: row.department, subtotal: Number(row.subtotal), tax: tax, cgst: tax/2, sgst: tax/2,
      preDiscountTotal: Number(row.subtotal) + tax, discountAmount: Number(row.discount_amount) || 0,
      promoCode: row.promo_code, total: Number(row.total_amount), paymentMethod: row.payment_method,
      items: (row.items || []).map(function(it){ return { name: it.name, price: Number(it.unit_price), qty: Number(it.quantity), amount: Number(it.line_total) }; }),
      restaurant: Object.assign({}, state.restaurant),
      createdByStaffId: row.created_by_staff_id, createdByName: staffAcct ? staffAcct.name : (row.created_by_staff_id || 'Admin')
    };
  }
  document.getElementById('exportRestaurantHistoryBtn').addEventListener('click', function(){
    exportRowsToExcel('restaurant_invoices', (state.restaurantInvoices || []).map(function(inv){
      return {
        invoiceNo: inv.invoiceNo, date: localDateStr(new Date(inv.date)), customerName: inv.customerName || '',
        customerPhone: inv.customerPhone || '', tableNo: inv.tableNo != null ? inv.tableNo : '',
        subtotal: inv.subtotal, discount: inv.discountAmount, total: inv.total,
        paymentMethod: inv.paymentMethod, createdBy: inv.createdByName
      };
    }), [
      { key:'invoiceNo', label:'Invoice No' }, { key:'date', label:'Date' },
      { key:'customerName', label:'Customer Name' }, { key:'customerPhone', label:'Phone' },
      { key:'tableNo', label:'Table No' }, { key:'subtotal', label:'Subtotal (₹)' },
      { key:'discount', label:'Discount (₹)' }, { key:'total', label:'Total (₹)' },
      { key:'paymentMethod', label:'Payment Method' }, { key:'createdBy', label:'Staff' }
    ]);
  });
  function renderHistory(){
    var wrap = document.getElementById('historyWrap');
    var summaryWrap = document.getElementById('historySummary');
    if(!wrap) return;
    return api.getInvoices('restaurant').then(function(rows){
      state.restaurantInvoices = rows.map(mapServerRestaurantInvoiceListRow);
      renderHistoryFromCache();
    }).catch(function(e){ wrap.innerHTML = '<p class="error-text show">'+escapeHtml(e.message)+'</p>'; });
  }
  function renderHistoryFromCache(){
    var wrap = document.getElementById('historyWrap');
    var summaryWrap = document.getElementById('historySummary');
    var filterDate = document.getElementById('histDate').value;
    var isStaff = state.session.role === 'staff';
    var restaurantInvoices = state.restaurantInvoices || [];
    if(isStaff){
      var cutoff15r = Date.now() - 15 * 86400000;
      restaurantInvoices = restaurantInvoices.filter(function(inv){ return new Date(inv.date).getTime() >= cutoff15r; });
    }
    var list = restaurantInvoices;
    if(filterDate){
      list = list.filter(function(inv){ return localDateStr(new Date(inv.date)) === filterDate; });
    }

    // drop selections for invoices no longer in the current filtered view
    var visibleIds = {};
    list.forEach(function(inv){ visibleIds[inv.id] = true; });
    Object.keys(historySelected).forEach(function(id){ if(!visibleIds[id]) delete historySelected[id]; });

    if(restaurantInvoices.length === 0){
      summaryWrap.innerHTML = '';
      wrap.innerHTML = emptyState(ICONS.history, 'No invoices yet', 'Bills staff generate will show up here.');
      return;
    }

    var totalSales = list.reduce(function(s,i){ return s + (Number(i.total)||0); }, 0);
    var avgVal = list.length ? totalSales / list.length : 0;
    summaryWrap.innerHTML = '<div class="summary-strip">'
      + '<div class="summary-chip"><p class="sc-label">Total sales</p><p class="sc-value">'+money(totalSales)+'</p></div>'
      + '<div class="summary-chip"><p class="sc-label">Invoices</p><p class="sc-value">'+list.length+'</p></div>'
      + '<div class="summary-chip"><p class="sc-label">Avg. invoice value</p><p class="sc-value">'+money(avgVal)+'</p></div>'
      + '</div>';

    if(list.length === 0){
      wrap.innerHTML = emptyState(ICONS.history, 'No invoices on this date', 'Try another date, or clear the search to see everything.');
      return;
    }

    var selectedCount = Object.keys(historySelected).length;
    var allSelected = selectedCount > 0 && selectedCount === list.length;
    var bulkBarHtml = isStaff ? '' : '<div class="bulk-bar'+(selectedCount>0?' show':'')+'" id="historyBulkBar">'
      + '<span class="bulk-count" id="historyBulkCount">'+selectedCount+' selected</span>'
      + '<button type="button" class="btn ghost small" id="historyClearSelectionBtn">Clear</button>'
      + '<button type="button" class="btn danger small" id="historyBulkDeleteBtn" style="margin-left:auto;">'
      + '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>'
      + 'Delete selected</button></div>';

    var rows = list.map(function(inv){
      var d = new Date(inv.date).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' });
      var checked = historySelected[inv.id] ? ' checked' : '';
      return '<tr class="'+(historySelected[inv.id]?'row-selected':'')+'">'
        + (isStaff ? '' : '<td data-label="" class="select-col"><input type="checkbox" class="row-check" data-select-invoice="'+inv.id+'"'+checked+'></td>')
        + '<td data-label="Invoice" class="code">'+escapeHtml(inv.invoiceNo)+'</td>'
        + '<td data-label="Date">'+d+'</td>'
        + '<td data-label="Details">'+(inv.refValue ? escapeHtml(inv.refLabel || 'Table')+' '+escapeHtml(String(inv.refValue)) : (inv.tableNo ? 'Table '+escapeHtml(String(inv.tableNo)) : '—'))+'</td>'
        + '<td data-label="Customer">'+escapeHtml(inv.customerName)+'<br><span style="color:var(--text-muted);font-size:12px;">'+escapeHtml(inv.customerPhone)+'</span></td>'
        + '<td data-label="Staff">'+escapeHtml(inv.createdByName || '—')+'</td>'
        + '<td data-label="Payment">'+escapeHtml(inv.paymentMethod || 'Cash')+(inv.promoCode ? '<br><span style="color:var(--success);font-size:11px;">'+escapeHtml(inv.promoCode)+'</span>' : '')+'</td>'
        + '<td data-label="Total" class="amt">'+money(inv.total)+'</td>'
        + '<td data-label="Actions" style="white-space:nowrap;">'
        + '<button class="btn ghost small" data-view="'+inv.id+'">View</button> '
        + (isStaff ? '' : '<button class="btn danger-ghost small" data-delete-invoice="'+inv.id+'">Delete</button>')
        + '</td></tr>';
    }).join('');
    wrap.innerHTML = bulkBarHtml
      + '<div class="table-scroll"><table class="dtable"><thead><tr>'
      + (isStaff ? '' : '<th class="select-col"><input type="checkbox" id="historySelectAll"'+(allSelected?' checked':'')+'></th>')
      + '<th>Invoice</th><th>Date</th><th>Details</th><th>Customer</th><th>Staff</th><th>Payment</th><th class="amt">Total</th><th></th>'
      + '</tr></thead><tbody>'+rows+'</tbody></table></div>';

    if(isStaff){
      wrap.querySelectorAll('[data-view]').forEach(function(b){
        b.addEventListener('click', function(){
          var id = b.dataset.view;
          api.getInvoice(id).then(function(row){
            var inv = mapServerRestaurantInvoiceListRow(row);
            inv.items = (row.items || []).map(function(it){ return { name: it.name, price: Number(it.unit_price), qty: Number(it.quantity), amount: Number(it.line_total) }; });
            openInvoiceOverlay(inv);
          }).catch(function(e){ showToast(e.message, 'error'); });
        });
      });
      return;
    }

    function updateBulkBar(){
      var count = Object.keys(historySelected).length;
      var bar = document.getElementById('historyBulkBar');
      bar.classList.toggle('show', count > 0);
      document.getElementById('historyBulkCount').textContent = count + ' selected';
      var selAll = document.getElementById('historySelectAll');
      selAll.checked = count > 0 && count === list.length;
    }
    wrap.querySelectorAll('[data-select-invoice]').forEach(function(cb){
      cb.addEventListener('change', function(){
        var id = cb.dataset.selectInvoice;
        if(cb.checked){ historySelected[id] = true; } else { delete historySelected[id]; }
        cb.closest('tr').classList.toggle('row-selected', cb.checked);
        updateBulkBar();
      });
    });
    document.getElementById('historySelectAll').addEventListener('change', function(){
      if(this.checked){
        list.forEach(function(inv){ historySelected[inv.id] = true; });
      } else {
        historySelected = {};
      }
      renderHistoryFromCache();
    });
    document.getElementById('historyClearSelectionBtn').addEventListener('click', function(){
      historySelected = {};
      renderHistoryFromCache();
    });
    document.getElementById('historyBulkDeleteBtn').addEventListener('click', function(){
      var ids = Object.keys(historySelected);
      if(ids.length === 0) return;
      openConfirm({
        title: 'Delete '+ids.length+' invoice'+(ids.length===1?'':'s')+'?',
        desc: 'These invoice records will be permanently removed. This cannot be undone.',
        confirmLabel: 'Delete '+ids.length+' invoice'+(ids.length===1?'':'s'),
        onConfirm: function(){
          historySelected = {};
          Promise.all(ids.map(function(id){ return api.deleteInvoice(id); })).then(function(){
            showToast(ids.length + ' invoice' + (ids.length===1?'':'s') + ' deleted');
            renderHistory(); renderSalesAnalysis(); renderDashboard();
          }).catch(function(e){ showToast(e.message, 'error'); });
        }
      });
    });

    wrap.querySelectorAll('[data-view]').forEach(function(b){
      b.addEventListener('click', function(){
        var id = b.dataset.view;
        api.getInvoice(id).then(function(row){
          var inv = mapServerRestaurantInvoiceListRow(row);
          inv.items = (row.items || []).map(function(it){ return { name: it.name, price: Number(it.unit_price), qty: Number(it.quantity), amount: Number(it.line_total) }; });
          openInvoiceOverlay(inv);
        }).catch(function(e){ showToast(e.message, 'error'); });
      });
    });
    wrap.querySelectorAll('[data-delete-invoice]').forEach(function(b){
      b.addEventListener('click', function(){
        var inv = state.restaurantInvoices.find(function(i){ return i.id === b.dataset.deleteInvoice; });
        if(!inv) return;
        openConfirm({
          title: 'Delete invoice '+inv.invoiceNo+'?',
          desc: 'This invoice record will be permanently removed. This cannot be undone.',
          confirmLabel: 'Delete invoice',
          onConfirm: function(){
            delete historySelected[inv.id];
            api.deleteInvoice(inv.id).then(function(){
              showToast('Invoice deleted'); renderHistory(); renderSalesAnalysis(); renderDashboard();
            }).catch(function(e){ showToast(e.message, 'error'); });
          }
        });
      });
    });
  }
  document.getElementById('histDate').addEventListener('change', function(){
    historySelected = {};
    renderHistoryFromCache();
  });
  // Server-backed room booking history: fetch every visit, then render from a
  // local cache so filtering/sorting stays instant without extra round-trips.
  function renderRoomHistory(){
    return api.getInvoices('room').then(function(rows){
      state.roomInvoices = rows.map(mapServerRoomInvoiceListRow);
      renderRoomHistoryFromCache();
    }).catch(function(e){
      var wrap = document.getElementById('roomHistoryWrap');
      if (wrap) wrap.innerHTML = '<p class="error-text show">'+escapeHtml(e.message)+'</p>';
    });
  }
  // Maps one row from GET /api/invoices?department=room into the same shape
  // the UI already expects from local invoice objects (see generateRoomInvoiceViaServer).
  function mapServerRoomInvoiceListRow(row){
    var staffAcct = state.staff.find(function(s){ return s.staffId === row.created_by_staff_id; });
    var tax = Number(row.total_amount) - Number(row.subtotal);
    var metaRows = [];
    if(row.room_check_in) metaRows.push({ label:'Check-in', value: String(row.room_check_in).slice(0,10) });
    if(row.room_check_out) metaRows.push({ label:'Check-out', value: String(row.room_check_out).slice(0,10) });
    return {
      id: row.id, invoiceNo: row.invoice_no, date: row.created_at,
      customerName: row.customer_name, customerPhone: row.customer_phone,
      refLabel: 'Room', refValue: row.room_no != null ? String(row.room_no) : null,
      metaRows: metaRows, department: row.department,
      subtotal: Number(row.subtotal), tax: tax, cgst: tax/2, sgst: tax/2,
      preDiscountTotal: Number(row.subtotal) + tax, discountAmount: Number(row.discount_amount) || 0,
      promoCode: row.promo_code, total: Number(row.total_amount), paymentMethod: row.payment_method,
      advanceAmount: parseFloat(row.room_advance_amount) || 0, balancePaid: !!row.room_balance_paid,
      restaurant: Object.assign({}, state.restaurant),
      createdByStaffId: row.created_by_staff_id, createdByName: staffAcct ? staffAcct.name : (row.created_by_staff_id || 'Admin')
    };
  }
  document.getElementById('exportRoomHistoryBtn').addEventListener('click', function(){
    exportRowsToExcel('room_bookings', (state.roomInvoices || []).map(function(inv){
      var checkIn = (inv.metaRows.find(function(m){ return m.label==='Check-in'; }) || {}).value || '';
      var checkOut = (inv.metaRows.find(function(m){ return m.label==='Check-out'; }) || {}).value || '';
      return {
        invoiceNo: inv.invoiceNo, date: localDateStr(new Date(inv.date)), guestName: inv.customerName,
        guestPhone: inv.customerPhone, room: inv.refValue, checkIn: checkIn, checkOut: checkOut,
        total: inv.total, paymentMethod: inv.paymentMethod, createdBy: inv.createdByName
      };
    }), [
      { key:'invoiceNo', label:'Invoice No' }, { key:'date', label:'Date' },
      { key:'guestName', label:'Guest Name' }, { key:'guestPhone', label:'Phone' },
      { key:'room', label:'Room No' }, { key:'checkIn', label:'Check-in' }, { key:'checkOut', label:'Check-out' },
      { key:'total', label:'Total (₹)' }, { key:'paymentMethod', label:'Payment Method' }, { key:'createdBy', label:'Staff' }
    ]);
  });
  function renderRoomHistoryFromCache(){
    var wrap = document.getElementById('roomHistoryWrap');
    var summaryWrap = document.getElementById('roomHistorySummary');
    var filterDate = document.getElementById('roomHistDate').value;
    var isStaff = state.session.role === 'staff';
    var all = state.roomInvoices || [];
    if(isStaff){
      var cutoff15 = Date.now() - 15 * 86400000;
      all = all.filter(function(inv){ return new Date(inv.date).getTime() >= cutoff15; });
    }
    var list = all;
    if(filterDate){
      list = list.filter(function(inv){ return localDateStr(new Date(inv.date)) === filterDate; });
    }

    var visibleIds = {};
    list.forEach(function(inv){ visibleIds[inv.id] = true; });
    Object.keys(roomHistorySelected).forEach(function(id){ if(!visibleIds[id]) delete roomHistorySelected[id]; });

    if(all.length === 0){
      summaryWrap.innerHTML = '';
      wrap.innerHTML = emptyState(ICONS.history, 'No room bookings yet', 'Rooms Staff book will show up here.');
      return;
    }

    var totalSales = list.reduce(function(s,i){ return s + (Number(i.total)||0); }, 0);
    summaryWrap.innerHTML = '<div class="summary-strip">'
      + '<div class="summary-chip"><p class="sc-label">Total billed</p><p class="sc-value">'+money(totalSales)+'</p></div>'
      + '<div class="summary-chip"><p class="sc-label">Bookings</p><p class="sc-value">'+list.length+'</p></div>'
      + '</div>';

    if(list.length === 0){
      wrap.innerHTML = emptyState(ICONS.history, 'No bookings on this date', 'Try another date, or clear the search to see everything.');
      return;
    }

    var selectedCount = Object.keys(roomHistorySelected).length;
    var allSelected = selectedCount > 0 && selectedCount === list.length;
    var bulkBarHtml = isStaff ? '' : '<div class="bulk-bar'+(selectedCount>0?' show':'')+'" id="roomHistoryBulkBar">'
      + '<span class="bulk-count" id="roomHistoryBulkCount">'+selectedCount+' selected</span>'
      + '<button type="button" class="btn ghost small" id="roomHistoryClearSelectionBtn">Clear</button>'
      + '<button type="button" class="btn danger small" id="roomHistoryBulkDeleteBtn" style="margin-left:auto;">'
      + '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>'
      + 'Delete selected</button></div>';

    var rows = list.map(function(inv){
      var d = new Date(inv.date).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' });
      var checked = roomHistorySelected[inv.id] ? ' checked' : '';
      var checkIn = metaRowValue(inv, 'Check-in') || '—';
      var checkOut = metaRowValue(inv, 'Check-out') || '—';
      var balance = inv.total - (inv.advanceAmount||0);
      var paymentHtml = !inv.advanceAmount
        ? '<span style="color:var(--text-muted);font-size:12px;">Full amount paid</span>'
        : (inv.balancePaid || balance <= 0)
          ? '<span class="badge success">Fully paid</span>'
          : 'Advance ' + money(inv.advanceAmount) + '<br><span style="color:var(--text-muted);font-size:12px;">Balance ' + money(balance) + ' due</span>'
            + (isStaff ? '' : '<br><button class="btn ghost small" data-mark-room-hist-balance="'+inv.id+'" style="margin-top:4px;">Mark received</button>');
      return '<tr class="'+(roomHistorySelected[inv.id]?'row-selected':'')+'">'
        + (isStaff ? '' : '<td data-label="" class="select-col"><input type="checkbox" class="row-check" data-select-room-invoice="'+inv.id+'"'+checked+'></td>')
        + '<td data-label="Invoice" class="code">'+escapeHtml(inv.invoiceNo)+'</td>'
        + '<td data-label="Date">'+d+'</td>'
        + '<td data-label="Room">'+escapeHtml(inv.refValue ? String(inv.refValue) : '—')+'</td>'
        + '<td data-label="Guest">'+escapeHtml(inv.customerName)+'<br><span style="color:var(--text-muted);font-size:12px;">'+escapeHtml(inv.customerPhone)+'</span></td>'
        + '<td data-label="Check-in">'+escapeHtml(checkIn)+'</td>'
        + '<td data-label="Check-out">'+escapeHtml(checkOut)+'</td>'
        + '<td data-label="Staff">'+escapeHtml(inv.createdByName || '—')+'</td>'
        + '<td data-label="Total" class="amt">'+money(inv.total)+'</td>'
        + '<td data-label="Payment">'+paymentHtml+'</td>'
        + '<td data-label="Actions" style="white-space:nowrap;">'
        + '<button class="btn ghost small" data-view-room="'+inv.id+'">View</button> '
        + (isStaff ? '' : '<button class="btn danger-ghost small" data-delete-room-invoice="'+inv.id+'">Delete</button>')
        + '</td></tr>';
    }).join('');
    wrap.innerHTML = bulkBarHtml
      + '<div class="table-scroll"><table class="dtable"><thead><tr>'
      + (isStaff ? '' : '<th class="select-col"><input type="checkbox" id="roomHistorySelectAll"'+(allSelected?' checked':'')+'></th>')
      + '<th>Invoice</th><th>Date</th><th>Room</th><th>Guest</th><th>Check-in</th><th>Check-out</th><th>Staff</th><th class="amt">Total</th><th>Payment</th><th></th>'
      + '</tr></thead><tbody>'+rows+'</tbody></table></div>';
    wrap.querySelectorAll('[data-mark-room-hist-balance]').forEach(function(btn){
      btn.addEventListener('click', function(e){
        e.stopPropagation();
        api.markRoomBalancePaid(btn.dataset.markRoomHistBalance).then(function(){
          showToast('Balance marked as received');
          return api.getInvoices('room');
        }).then(function(rows){
          state.roomInvoices = rows.map(mapServerRoomInvoiceListRow);
          renderRoomHistoryFromCache();
        }).catch(function(e){ showToast(e.message, 'error'); });
      });
    });

    if(isStaff){
      wrap.querySelectorAll('[data-view-room]').forEach(function(b){
        b.addEventListener('click', function(){
          var inv = state.roomInvoices.find(function(i){ return i.id === b.dataset.viewRoom; });
          if(inv) openInvoiceOverlay(inv);
        });
      });
      return;
    }

    function updateBulkBar(){
      var count = Object.keys(roomHistorySelected).length;
      var bar = document.getElementById('roomHistoryBulkBar');
      bar.classList.toggle('show', count > 0);
      document.getElementById('roomHistoryBulkCount').textContent = count + ' selected';
      var selAll = document.getElementById('roomHistorySelectAll');
      selAll.checked = count > 0 && count === list.length;
    }
    wrap.querySelectorAll('[data-select-room-invoice]').forEach(function(cb){
      cb.addEventListener('change', function(){
        var id = cb.dataset.selectRoomInvoice;
        if(cb.checked){ roomHistorySelected[id] = true; } else { delete roomHistorySelected[id]; }
        cb.closest('tr').classList.toggle('row-selected', cb.checked);
        updateBulkBar();
      });
    });
    document.getElementById('roomHistorySelectAll').addEventListener('change', function(){
      if(this.checked){
        list.forEach(function(inv){ roomHistorySelected[inv.id] = true; });
      } else {
        roomHistorySelected = {};
      }
      renderRoomHistoryFromCache();
    });
    document.getElementById('roomHistoryClearSelectionBtn').addEventListener('click', function(){
      roomHistorySelected = {};
      renderRoomHistoryFromCache();
    });
    document.getElementById('roomHistoryBulkDeleteBtn').addEventListener('click', function(){
      var ids = Object.keys(roomHistorySelected);
      if(ids.length === 0) return;
      openConfirm({
        title: 'Delete '+ids.length+' booking'+(ids.length===1?'':'s')+'?',
        desc: 'These booking records will be permanently removed. This cannot be undone.',
        confirmLabel: 'Delete '+ids.length+' booking'+(ids.length===1?'':'s'),
        onConfirm: function(){
          roomHistorySelected = {};
          Promise.all(ids.map(function(id){ return api.deleteInvoice(id); })).then(function(){
            showToast(ids.length + ' booking' + (ids.length===1?'':'s') + ' deleted');
            renderRoomHistory(); renderDashboard();
          }).catch(function(e){ showToast(e.message, 'error'); });
        }
      });
    });

    wrap.querySelectorAll('[data-view-room]').forEach(function(b){
      b.addEventListener('click', function(){
        var id = b.dataset.viewRoom;
        api.getInvoice(id).then(function(row){
          var inv = mapServerRoomInvoiceListRow(row);
          inv.items = (row.items || []).map(function(it){ return { name: it.name, price: Number(it.unit_price), qty: Number(it.quantity), amount: Number(it.line_total) }; });
          openInvoiceOverlay(inv);
        }).catch(function(e){ showToast(e.message, 'error'); });
      });
    });
    wrap.querySelectorAll('[data-delete-room-invoice]').forEach(function(b){
      b.addEventListener('click', function(){
        var inv = state.roomInvoices.find(function(i){ return i.id === b.dataset.deleteRoomInvoice; });
        if(!inv) return;
        openConfirm({
          title: 'Delete booking '+inv.invoiceNo+'?',
          desc: 'This booking record will be permanently removed. This cannot be undone.',
          confirmLabel: 'Delete booking',
          onConfirm: function(){
            delete roomHistorySelected[inv.id];
            api.deleteInvoice(inv.id).then(function(){
              showToast('Booking deleted'); renderRoomHistory(); renderDashboard();
            }).catch(function(e){ showToast(e.message, 'error'); });
          }
        });
      });
    });
  }
  document.getElementById('roomHistDate').addEventListener('change', function(){
    roomHistorySelected = {};
    renderRoomHistoryFromCache();
  });
  document.getElementById('roomHistDateClear').addEventListener('click', function(){
    document.getElementById('roomHistDate').value = '';
    roomHistorySelected = {};
    renderRoomHistoryFromCache();
  });

  document.getElementById('histDateClear').addEventListener('click', function(){
    document.getElementById('histDate').value = '';
    historySelected = {};
    renderHistoryFromCache();
  });

  // ---------- dashboard / overview (admin) ----------
  function kpiCard(label, value, iconKey, deltaHtml){
    return '<div class="kpi-card"><div class="kpi-top"><span class="kpi-label">'+escapeHtml(label)+'</span><span class="kpi-ico">'+ICONS[iconKey]+'</span></div>'
      + '<p class="kpi-value">'+value+'</p>'
      + (deltaHtml || '')
      + '</div>';
  }
  // One card per business line so Room booking, Banquet hall and Restaurant
  // can each be tracked on a daily basis, instead of one blended total.
  var DASH_DEPTS = [
    { key:'room', label:'Room booking', sub:'Hotel room bookings', icon:'room', cardClass:'dept-card-room', unit:'bookings' },
    { key:'banquet', label:'Banquet hall', sub:'Banquet hall bookings', icon:'banquet', cardClass:'dept-card-banquet', unit:'bookings' },
    { key:'restaurant', label:'Restaurant', sub:'Dine-in & takeaway billing', icon:'menu', cardClass:'dept-card-restaurant', unit:'orders' }
  ];
  // Room and Banquet invoices now live in the cloud; Restaurant invoices are
  // still local-only until that module gets wired the same way. This merges
  // every source so dashboard numbers are accurate for the parts that are
  // already synced, without hiding the part that isn't yet.
  function buildDashboardInvoices(){
    var banquetAsInvoices = (state.banquetBookings || []).filter(function(b){ return b.status !== 'cancelled'; }).map(function(b){
      return { id: b.id, invoiceNo: b.bookingCode, date: b.createdAt, total: b.totalAmount, department: 'banquet', customerName: b.customerName, items: [] };
    });
    return (state.roomInvoices || []).concat(banquetAsInvoices).concat(state.restaurantInvoices || []);
  }
  function renderDeptGrid(){
    var grid = document.getElementById('deptGrid');
    if(!grid) return;
    var allInvoices = buildDashboardInvoices();
    var today = localDateStr(new Date());
    var yesterday = localDateStr(new Date(Date.now() - 86400000));

    grid.innerHTML = DASH_DEPTS.map(function(d){
      var deptInvoices = allInvoices.filter(function(i){ return i.department === d.key; });
      var todayInv = deptInvoices.filter(function(i){ return localDateStr(new Date(i.date)) === today; });
      var yestInv = deptInvoices.filter(function(i){ return localDateStr(new Date(i.date)) === yesterday; });
      var todaySales = todayInv.reduce(function(s,i){ return s + (Number(i.total)||0); }, 0);
      var yestSales = yestInv.reduce(function(s,i){ return s + (Number(i.total)||0); }, 0);

      var deltaHtml = '';
      if(yestSales > 0){
        var pct = ((todaySales - yestSales) / yestSales) * 100;
        var up = pct >= 0;
        deltaHtml = '<div class="dept-stat-row" style="margin-top:-4px;"><span class="dept-stat-delta '+(up?'up':'down')+'">'+ICONS[up?'up':'down']+' '+Math.abs(pct).toFixed(1)+'%</span><span style="font-size:11px;color:var(--text-muted);">vs yesterday</span></div>';
      } else if(deptInvoices.length > 0){
        deltaHtml = '<div class="dept-stat-row" style="margin-top:-4px;"><span style="font-size:11px;color:var(--text-muted);">No sales yesterday to compare</span></div>';
      }

      var recentHtml = deptInvoices.slice(0, 4).map(function(inv){
        var dd = new Date(inv.date).toLocaleDateString('en-IN', { day:'2-digit', month:'short' });
        return '<div class="dash-list-row"><span><span class="dlr-name">'+escapeHtml(inv.customerName || inv.invoiceNo)+'</span> <span class="dlr-meta">'+escapeHtml(inv.invoiceNo)+' · '+dd+'</span></span><span class="dlr-amt">'+money(inv.total)+'</span></div>';
      }).join('');
      if(!recentHtml){ recentHtml = '<p class="dept-empty">No '+d.unit+' yet.</p>'; }

      return '<div class="dept-card '+d.cardClass+'">'
        + '<div class="dept-card-head"><span class="dept-ico">'+ICONS[d.icon]+'</span><div><h3>'+escapeHtml(d.label)+'</h3><p>'+escapeHtml(d.sub)+'</p></div></div>'
        + '<div class="dept-stats">'
          + '<div class="dept-stat-row"><span class="ds-label">Today\'s sales</span><span class="ds-value big">'+money(todaySales)+'</span></div>'
          + deltaHtml
          + '<div class="dept-stat-row"><span class="ds-label">Today\'s '+d.unit+'</span><span class="ds-value">'+todayInv.length+'</span></div>'
          + '<div class="dept-stat-row"><span class="ds-label">Total invoices</span><span class="ds-value">'+deptInvoices.length+'</span></div>'
        + '</div>'
        + '<div class="dept-sub-block"><p class="dept-sub-label">Recent</p>'+recentHtml+'</div>'
        + '</div>';
    }).join('');
  }
  function renderDashboard(){
    if(state.session.role !== 'admin') return;
    var grid = document.getElementById('todayKpiGrid');
    if(!grid) return;

    // Refresh Room, Banquet, and Restaurant's server-backed data first, so the numbers below are current.
    return Promise.all([
      api.getInvoices('room').then(function(rows){ state.roomInvoices = rows.map(mapServerRoomInvoiceListRow); }).catch(function(){}),
      fetchBanquetBookingsFromServer().catch(function(){}),
      api.getInvoices('restaurant').then(function(rows){ state.restaurantInvoices = rows.map(mapServerRestaurantInvoiceListRow); }).catch(function(){}),
      api.getRoomBookings().then(function(rows){ state.allRoomBookings = rows.map(mapServerRoomBookingRaw); }).catch(function(){ state.allRoomBookings = state.allRoomBookings || []; })
    ]).then(function(){

    renderDeptGrid();
    renderTodayKpis();
    updateDashboardClock();

    var allInvoices = buildDashboardInvoices();
    var recentWrap = document.getElementById('dashRecentInvoices');
    var deptIco = { room: ICONS.room, banquet: ICONS.banquet, restaurant: ICONS.dish };
    var deptClass = { room:'dept-card-room', banquet:'dept-card-banquet', restaurant:'dept-card-restaurant' };
    if(allInvoices.length === 0){
      recentWrap.innerHTML = emptyState(ICONS.history, 'No invoices yet', 'Generated bills will appear here.');
    } else {
      var deptTag = { room:'Room', banquet:'Banquet', restaurant:'Restaurant' };
      recentWrap.innerHTML = allInvoices.slice().sort(function(a,b){ return new Date(b.date) - new Date(a.date); }).slice(0,6).map(function(inv){
        var d = new Date(inv.date).toLocaleDateString('en-IN', { day:'2-digit', month:'short' });
        var tag = deptTag[inv.department] || '';
        return '<div class="dash-list-row '+(deptClass[inv.department]||'')+'"><span class="dlr-left"><span class="dlr-ico">'+(deptIco[inv.department]||ICONS.history)+'</span><span class="dlr-body"><span class="dlr-name">'+escapeHtml(inv.invoiceNo)+'</span> <span class="dlr-meta">'+(tag ? tag+' · ' : '')+escapeHtml(inv.customerName)+' · '+d+'</span></span></span><span class="dlr-amt">'+money(inv.total)+'</span></div>';
      }).join('');
    }

    renderPendingPaymentsList();
    renderAnalyticsCharts(getDashboardRange(dashboardRangeKey));
    renderMonthlyRevenueChart();
    });
  }

  // ---------- Today's performance KPIs ----------
  function mapServerRoomBookingRaw(b){
    return { id:b.id, roomId:b.room_id, guestName:b.guest_name, checkIn:b.check_in, checkOut:b.check_out, status:b.status, createdAt:b.created_at };
  }
  function renderTodayKpis(){
    var grid = document.getElementById('todayKpiGrid');
    if(!grid) return;
    var allInvoices = buildDashboardInvoices();
    var today = localDateStr(new Date());

    var totalRooms = state.rooms.length;
    var occupiedNow = state.rooms.filter(function(r){ return r.status === 'occupied'; }).length;
    var occupancyPct = totalRooms ? Math.round((occupiedNow / totalRooms) * 100) : 0;

    var todayInvoices = allInvoices.filter(function(i){ return localDateStr(new Date(i.date)) === today; });
    var todayRevenue = todayInvoices.reduce(function(s,i){ return s + (Number(i.total)||0); }, 0);
    var restaurantToday = todayInvoices.filter(function(i){ return i.department === 'restaurant'; }).reduce(function(s,i){ return s + (Number(i.total)||0); }, 0);
    var banquetToday = todayInvoices.filter(function(i){ return i.department === 'banquet'; }).reduce(function(s,i){ return s + (Number(i.total)||0); }, 0);

    var checkInsToday = (state.allRoomBookings||[]).filter(function(b){ return b.checkIn && localDateStr(new Date(b.checkIn)) === today; }).length;
    var checkOutsToday = (state.allRoomBookings||[]).filter(function(b){ return b.status === 'completed' && b.checkOut && localDateStr(new Date(b.checkOut)) === today; }).length;

    var pendingTotal = (state.banquetBookings||[]).filter(function(b){ return b.status !== 'cancelled' && !b.balancePaid && (b.totalAmount - b.advanceAmount) > 0; })
      .reduce(function(s,b){ return s + (b.totalAmount - b.advanceAmount); }, 0);

    grid.innerHTML =
      kpiCard('Occupancy', occupancyPct + '%', 'room', '<div class="kpi-delta" style="color:var(--text-muted);">'+occupiedNow+' of '+totalRooms+' rooms</div>')
      + kpiCard('Revenue', money(todayRevenue), 'sales')
      + kpiCard('Check-ins', String(checkInsToday), 'orders')
      + kpiCard('Check-outs', String(checkOutsToday), 'history')
      + kpiCard('Restaurant sales', money(restaurantToday), 'dish')
      + kpiCard('Banquet sales', money(banquetToday), 'banquet')
      + kpiCard('Pending payments', money(pendingTotal), 'invoices');

    var secondaryGrid = document.getElementById('kpiGrid');
    if(secondaryGrid){
      var allSales = allInvoices.reduce(function(s,i){ return s + (Number(i.total)||0); }, 0);
      var avgOrderValue = allInvoices.length ? allSales / allInvoices.length : 0;
      secondaryGrid.innerHTML =
        kpiCard('Total invoices', String(allInvoices.length), 'invoices')
        + kpiCard('Active staff', String(currentTenantStaff().length), 'users')
        + kpiCard('Menu items', String(state.menu.length), 'dish')
        + kpiCard('Avg. order value', money(avgOrderValue), 'avg');
    }
  }

  function renderPendingPaymentsList(){
    var wrap = document.getElementById('dashPendingPayments');
    if(!wrap) return;
    var pending = (state.banquetBookings||[]).filter(function(b){ return b.status !== 'cancelled' && !b.balancePaid && (b.totalAmount - b.advanceAmount) > 0; })
      .sort(function(a,b){ return new Date(a.startISO) - new Date(b.startISO); });
    if(pending.length === 0){
      wrap.innerHTML = emptyState(ICONS.check, 'All settled up', 'No outstanding banquet balances right now.');
      return;
    }
    wrap.innerHTML = pending.slice(0, 8).map(function(b){
      var balance = b.totalAmount - b.advanceAmount;
      var d = new Date(b.startISO).toLocaleDateString('en-IN', { day:'2-digit', month:'short' });
      return '<div class="dash-list-row"><span class="dlr-left"><span class="dlr-ico">'+ICONS.banquet+'</span><span class="dlr-body"><span class="dlr-name">'+escapeHtml(b.customerName)+'</span> <span class="dlr-meta">'+escapeHtml(b.bookingCode)+' · Event '+d+'</span></span></span><span class="dlr-amt" style="color:var(--danger);">'+money(balance)+'</span></div>';
    }).join('');
  }

  // ---------- date range filter ----------
  var dashboardRangeKey = 'today';
  function getDashboardRange(key){
    var end = new Date(); end.setHours(23,59,59,999);
    var start = new Date(); start.setHours(0,0,0,0);
    if(key === '7d'){ start.setDate(start.getDate() - 6); }
    else if(key === '30d'){ start.setDate(start.getDate() - 29); }
    else if(key === '3m'){ start.setMonth(start.getMonth() - 3); start.setDate(start.getDate() + 1); }
    else if(key === 'custom'){
      var fromVal = document.getElementById('dashCustomFrom').value;
      var toVal = document.getElementById('dashCustomTo').value;
      if(fromVal) start = new Date(fromVal + 'T00:00:00');
      if(toVal) end = new Date(toVal + 'T23:59:59');
    }
    return { start: start, end: end, key: key };
  }
  function dashboardRangeLabel(range){
    var fmt = function(d){ return d.toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' }); };
    return 'Showing ' + fmt(range.start) + ' – ' + fmt(range.end) + '.';
  }
  document.querySelectorAll('#dashRangeBtns .dfb').forEach(function(btn){
    btn.addEventListener('click', function(){
      dashboardRangeKey = btn.dataset.range;
      document.querySelectorAll('#dashRangeBtns .dfb').forEach(function(b){ b.classList.toggle('active', b === btn); });
      document.getElementById('dashCustomRangeWrap').style.display = dashboardRangeKey === 'custom' ? 'flex' : 'none';
      if(dashboardRangeKey !== 'custom'){ renderAnalyticsCharts(getDashboardRange(dashboardRangeKey)); }
    });
  });
  document.getElementById('dashCustomApply').addEventListener('click', function(){
    if(!document.getElementById('dashCustomFrom').value || !document.getElementById('dashCustomTo').value){
      showToast('Pick both a start and end date.', 'error');
      return;
    }
    renderAnalyticsCharts(getDashboardRange('custom'));
  });

  // ---------- charts ----------
  var revenueChartInst = null, paymentChartInst = null;
  var dashRevenueChartInst = null, dashMonthlyChartInst = null, dashOccupancyChartInst = null, dashPaymentChartInst = null,
      dashRestaurantChartInst = null, dashBanquetChartInst = null, dashTopRoomsChartInst = null, dashTopFoodChartInst = null;

  function eachDayKey(start, end){
    var keys = [];
    var d = new Date(start); d.setHours(0,0,0,0);
    var last = new Date(end); last.setHours(0,0,0,0);
    while(d.getTime() <= last.getTime()){
      keys.push(localDateStr(d));
      d.setDate(d.getDate() + 1);
    }
    return keys;
  }
  function invoicesInRange(range){
    return buildDashboardInvoices().filter(function(inv){
      var t = new Date(inv.date).getTime();
      return t >= range.start.getTime() && t <= range.end.getTime();
    });
  }
  function lineChart(canvasId, existingInst, labels, data, colorHex){
    var canvas = document.getElementById(canvasId);
    if(!canvas) return null;
    if(existingInst) existingInst.destroy();
    var c = chartColors();
    return new Chart(canvas, {
      type: 'line',
      data: { labels: labels, datasets: [{ data: data, borderColor: colorHex, backgroundColor: colorHex + '24', fill: true, tension: .35, pointRadius: labels.length > 20 ? 0 : 3, pointBackgroundColor: colorHex, borderWidth: 2.4 }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins:{ legend:{ display:false }, tooltip:{ callbacks:{ label:function(ctx){ return money(ctx.parsed.y); } } } },
        scales:{
          x:{ grid:{ display:false }, ticks:{ color:c.muted, font:{ family:'Inter', size:10.5 }, maxRotation:0, autoSkip:true, maxTicksLimit:10 } },
          y:{ grid:{ color:c.grid }, ticks:{ color:c.muted, font:{ family:'Inter', size:11 }, callback:function(v){ return state.restaurant.currency + v; } } }
        }
      }
    });
  }
  function chartLibMissingHtml(){
    return '<p style="text-align:center;color:var(--text-muted);font-size:12.5px;padding-top:90px;margin:0;">Charts library failed to load.<br>Check your internet connection, then reload the page.</p>';
  }
  function renderAnalyticsCharts(range){
    if(typeof Chart === 'undefined'){
      ['dashRevenueChart','dashOccupancyChart','dashPaymentChart','dashRestaurantRevenueChart','dashBanquetRevenueChart','dashTopRoomsChart','dashTopFoodChart'].forEach(function(id){
        var canvas = document.getElementById(id);
        if(canvas && canvas.parentElement) canvas.parentElement.innerHTML = chartLibMissingHtml();
      });
      return;
    }
    var c = chartColors();
    document.getElementById('dashRangeLabel').textContent = dashboardRangeLabel(range);
    var list = invoicesInRange(range);
    var dayKeys = eachDayKey(range.start, range.end);
    var dayLabels = dayKeys.map(function(k){ return new Date(k+'T00:00:00').toLocaleDateString('en-IN', { day:'2-digit', month:'short' }); });

    // 1. Daily revenue (all departments)
    var byDay = {}; dayKeys.forEach(function(k){ byDay[k] = 0; });
    list.forEach(function(inv){ var k = localDateStr(new Date(inv.date)); if(byDay.hasOwnProperty(k)) byDay[k] += (Number(inv.total)||0); });
    dashRevenueChartInst = lineChart('dashRevenueChart', dashRevenueChartInst, dayLabels, dayKeys.map(function(k){ return byDay[k]; }), c.accent);

    // 2. Room occupancy per day
    var totalRooms = state.rooms.length || 1;
    var occByDay = dayKeys.map(function(k){
      var dayDate = new Date(k + 'T12:00:00');
      var occupied = (state.allRoomBookings||[]).filter(function(b){
        if(b.status === 'cancelled') return false;
        var ci = new Date(b.checkIn);
        var co = b.checkOut ? new Date(b.checkOut) : new Date();
        return ci.getTime() <= dayDate.getTime() && co.getTime() >= dayDate.getTime();
      }).length;
      return Math.round((occupied / totalRooms) * 100);
    });
    var occCanvas = document.getElementById('dashOccupancyChart');
    if(occCanvas){
      if(dashOccupancyChartInst) dashOccupancyChartInst.destroy();
      dashOccupancyChartInst = new Chart(occCanvas, {
        type: 'line',
        data: { labels: dayLabels, datasets: [{ data: occByDay, borderColor: c.info, backgroundColor: c.info+'24', fill: true, tension:.35, pointRadius: dayLabels.length > 20 ? 0 : 3, pointBackgroundColor: c.info, borderWidth: 2.4 }] },
        options: {
          responsive:true, maintainAspectRatio:false,
          plugins:{ legend:{ display:false }, tooltip:{ callbacks:{ label:function(ctx){ return ctx.parsed.y + '% occupied'; } } } },
          scales:{ x:{ grid:{ display:false }, ticks:{ color:c.muted, font:{ family:'Inter', size:10.5 }, maxRotation:0, autoSkip:true, maxTicksLimit:10 } },
            y:{ grid:{ color:c.grid }, min:0, max:100, ticks:{ color:c.muted, font:{ family:'Inter', size:11 }, callback:function(v){ return v+'%'; } } } }
        }
      });
    }

    // 3. Payment method breakdown
    var payMap = {};
    list.forEach(function(inv){ var m = inv.paymentMethod || 'Cash'; payMap[m] = (payMap[m]||0) + (Number(inv.total)||0); });
    var payKeys = Object.keys(payMap);
    var payCanvas = document.getElementById('dashPaymentChart');
    var payEmpty = document.getElementById('dashPaymentEmpty');
    if(payCanvas){
      if(dashPaymentChartInst) dashPaymentChartInst.destroy();
      if(payKeys.length === 0){
        payCanvas.style.display = 'none'; if(payEmpty) payEmpty.style.display = 'block';
      } else {
        payCanvas.style.display = 'block'; if(payEmpty) payEmpty.style.display = 'none';
        var payPalette = [c.accent, c.info, c.success, c.primary];
        dashPaymentChartInst = new Chart(payCanvas, {
          type: 'doughnut',
          data: { labels: payKeys, datasets: [{ data: payKeys.map(function(k){ return payMap[k]; }), backgroundColor: payKeys.map(function(k,i){ return payPalette[i % payPalette.length]; }), borderWidth: 2, borderColor: c.surface || '#fff' }] },
          options: { responsive:true, maintainAspectRatio:false, cutout:'62%',
            plugins:{ legend:{ position:'bottom', labels:{ color:c.muted, font:{ family:'Inter', size:11.5 }, padding:14, usePointStyle:true } },
              tooltip:{ callbacks:{ label:function(ctx){ return ctx.label + ': ' + money(ctx.parsed); } } } } }
        });
      }
    }

    // 4. Restaurant revenue
    var restDay = {}; dayKeys.forEach(function(k){ restDay[k] = 0; });
    list.filter(function(i){ return i.department === 'restaurant'; }).forEach(function(inv){ var k = localDateStr(new Date(inv.date)); if(restDay.hasOwnProperty(k)) restDay[k] += (Number(inv.total)||0); });
    dashRestaurantChartInst = lineChart('dashRestaurantRevenueChart', dashRestaurantChartInst, dayLabels, dayKeys.map(function(k){ return restDay[k]; }), c.success);

    // 5. Banquet revenue
    var banqDay = {}; dayKeys.forEach(function(k){ banqDay[k] = 0; });
    list.filter(function(i){ return i.department === 'banquet'; }).forEach(function(inv){ var k = localDateStr(new Date(inv.date)); if(banqDay.hasOwnProperty(k)) banqDay[k] += (Number(inv.total)||0); });
    dashBanquetChartInst = lineChart('dashBanquetRevenueChart', dashBanquetChartInst, dayLabels, dayKeys.map(function(k){ return banqDay[k]; }), c.info);

    // 6. Most booked rooms
    var roomCounts = {};
    (state.allRoomBookings||[]).filter(function(b){
      if(b.status === 'cancelled') return false;
      var t = new Date(b.checkIn).getTime();
      return t >= range.start.getTime() && t <= range.end.getTime();
    }).forEach(function(b){ roomCounts[b.roomId] = (roomCounts[b.roomId]||0) + 1; });
    var topRoomIds = Object.keys(roomCounts).sort(function(a,b){ return roomCounts[b]-roomCounts[a]; }).slice(0,8);
    var roomsCanvas = document.getElementById('dashTopRoomsChart');
    var roomsEmpty = document.getElementById('dashTopRoomsEmpty');
    if(roomsCanvas){
      if(dashTopRoomsChartInst) dashTopRoomsChartInst.destroy();
      if(topRoomIds.length === 0){
        roomsCanvas.style.display = 'none'; if(roomsEmpty) roomsEmpty.style.display = 'block';
      } else {
        roomsCanvas.style.display = 'block'; if(roomsEmpty) roomsEmpty.style.display = 'none';
        var roomLabels = topRoomIds.map(function(id){ var r = state.rooms.find(function(x){ return x.id === id; }); return r ? 'Room ' + r.roomNo : 'Room'; });
        dashTopRoomsChartInst = new Chart(roomsCanvas, {
          type: 'bar',
          data: { labels: roomLabels, datasets: [{ data: topRoomIds.map(function(id){ return roomCounts[id]; }), backgroundColor: c.accent, borderRadius: 5, maxBarThickness: 26 }] },
          options: { indexAxis:'y', responsive:true, maintainAspectRatio:false,
            plugins:{ legend:{ display:false }, tooltip:{ callbacks:{ label:function(ctx){ return ctx.parsed.x + ' bookings'; } } } },
            scales:{ x:{ grid:{ color:c.grid }, ticks:{ color:c.muted, font:{ family:'Inter', size:11 }, precision:0 } }, y:{ grid:{ display:false }, ticks:{ color:c.muted, font:{ family:'Inter', size:11.5 } } } } }
        });
      }
    }

    // 7. Most popular food items
    var dishMap = {};
    list.filter(function(inv){ return inv.department === 'restaurant'; }).forEach(function(inv){
      (inv.items||[]).forEach(function(it){ if(!dishMap[it.name]) dishMap[it.name] = 0; dishMap[it.name] += Number(it.qty)||0; });
    });
    var topDishNames = Object.keys(dishMap).sort(function(a,b){ return dishMap[b]-dishMap[a]; }).slice(0,8);
    var foodCanvas = document.getElementById('dashTopFoodChart');
    var foodEmpty = document.getElementById('dashTopFoodEmpty');
    if(foodCanvas){
      if(dashTopFoodChartInst) dashTopFoodChartInst.destroy();
      if(topDishNames.length === 0){
        foodCanvas.style.display = 'none'; if(foodEmpty) foodEmpty.style.display = 'block';
      } else {
        foodCanvas.style.display = 'block'; if(foodEmpty) foodEmpty.style.display = 'none';
        dashTopFoodChartInst = new Chart(foodCanvas, {
          type: 'bar',
          data: { labels: topDishNames, datasets: [{ data: topDishNames.map(function(n){ return dishMap[n]; }), backgroundColor: c.success, borderRadius: 5, maxBarThickness: 26 }] },
          options: { indexAxis:'y', responsive:true, maintainAspectRatio:false,
            plugins:{ legend:{ display:false }, tooltip:{ callbacks:{ label:function(ctx){ return ctx.parsed.x + ' sold'; } } } },
            scales:{ x:{ grid:{ color:c.grid }, ticks:{ color:c.muted, font:{ family:'Inter', size:11 }, precision:0 } }, y:{ grid:{ display:false }, ticks:{ color:c.muted, font:{ family:'Inter', size:11.5 } } } } }
        });
      }
    }
  }
  // Monthly revenue — fixed to the last 12 months, independent of the range filter above.
  function renderMonthlyRevenueChart(){
    if(typeof Chart === 'undefined'){
      var mc = document.getElementById('dashMonthlyRevenueChart');
      if(mc && mc.parentElement) mc.parentElement.innerHTML = chartLibMissingHtml();
      return;
    }
    var c = chartColors();
    var months = [];
    var d = new Date(); d.setDate(1);
    for(var i = 11; i >= 0; i--){
      var m = new Date(d.getFullYear(), d.getMonth() - i, 1);
      months.push({ key: m.getFullYear()+'-'+m.getMonth(), label: m.toLocaleDateString('en-IN',{month:'short', year:'2-digit'}) });
    }
    var byMonth = {}; months.forEach(function(m){ byMonth[m.key] = 0; });
    buildDashboardInvoices().forEach(function(inv){
      var dt = new Date(inv.date);
      var key = dt.getFullYear()+'-'+dt.getMonth();
      if(byMonth.hasOwnProperty(key)) byMonth[key] += (Number(inv.total)||0);
    });
    var canvas = document.getElementById('dashMonthlyRevenueChart');
    if(!canvas) return;
    if(dashMonthlyChartInst) dashMonthlyChartInst.destroy();
    dashMonthlyChartInst = new Chart(canvas, {
      type: 'bar',
      data: { labels: months.map(function(m){ return m.label; }), datasets: [{ data: months.map(function(m){ return byMonth[m.key]; }), backgroundColor: c.primary, borderRadius: 5, maxBarThickness: 34 }] },
      options: { responsive:true, maintainAspectRatio:false,
        plugins:{ legend:{ display:false }, tooltip:{ callbacks:{ label:function(ctx){ return money(ctx.parsed.y); } } } },
        scales:{ x:{ grid:{ display:false }, ticks:{ color:c.muted, font:{ family:'Inter', size:10.5 } } },
          y:{ grid:{ color:c.grid }, ticks:{ color:c.muted, font:{ family:'Inter', size:11 }, callback:function(v){ return state.restaurant.currency + v; } } } }
      }
    });
  }

  function renderSalesAnalysis(){
    return api.getInvoices('restaurant').then(function(rows){
      state.restaurantInvoices = rows.map(mapServerRestaurantInvoiceListRow);
      renderSalesAnalysisFromCache();
    }).catch(function(e){
      var statsEl = document.getElementById('analysisStats');
      if(statsEl) statsEl.innerHTML = '<p class="error-text show">'+escapeHtml(e.message)+'</p>';
    });
  }
  function renderSalesAnalysisFromCache(){
    var filterMonth = document.getElementById('analysisMonth').value;
    var list = state.restaurantInvoices || [];
    var periodLabel = 'All time';
    if(filterMonth){
      list = list.filter(function(inv){
        var d = new Date(inv.date);
        var ym = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0');
        return ym === filterMonth;
      });
      periodLabel = new Date(filterMonth + '-01T00:00:00').toLocaleDateString('en-IN', { month:'long', year:'numeric' });
    }

    var totalSale = list.reduce(function(sum, inv){ return sum + (Number(inv.total) || 0); }, 0);
    var totalOrders = list.length;
    var avgOrder = totalOrders ? totalSale / totalOrders : 0;

    var dishMap = {};
    list.forEach(function(inv){
      (inv.items || []).forEach(function(it){
        if(!dishMap[it.name]) dishMap[it.name] = { name: it.name, qty: 0, revenue: 0 };
        dishMap[it.name].qty += Number(it.qty) || 0;
        dishMap[it.name].revenue += Number(it.amount) || (Number(it.price)||0) * (Number(it.qty)||0);
      });
    });
    var dishes = Object.keys(dishMap).map(function(k){ return dishMap[k]; });
    dishes.sort(function(a,b){ return b.qty - a.qty; });
    var totalDishesSold = dishes.reduce(function(s,d){ return s + d.qty; }, 0);

    var statsEl = document.getElementById('analysisStats');
    statsEl.innerHTML =
      kpiCard('Total sale — ' + periodLabel, money(totalSale), 'sales')
      + kpiCard('Orders', String(totalOrders), 'orders')
      + kpiCard('Dishes sold', String(totalDishesSold), 'dish')
      + kpiCard('Avg. order value', money(avgOrder), 'avg');

    var topEl = document.getElementById('analysisTopDish');
    if(dishes.length === 0){
      topEl.innerHTML = emptyState(ICONS.dish, 'No orders yet', 'Nothing sold in this period.');
    } else {
      var top = dishes[0];
      topEl.innerHTML =
        '<div class="top-dish-card"><p class="td-eyebrow">Most ordered</p>'
        + '<p class="td-name">'+escapeHtml(top.name)+'</p>'
        + '<p class="td-meta">'+top.qty+' sold · '+money(top.revenue)+' in revenue</p>'
        + '</div>';
    }

    var tableEl = document.getElementById('analysisDishTable');
    if(dishes.length === 0){
      tableEl.innerHTML = '';
    } else {
      var rows = dishes.map(function(d, i){
        return '<tr'+(i===0 ? ' class="top-row"' : '')+'>'
          + '<td data-label="Dish">'+escapeHtml(d.name)+(i===0 ? ' <span class="badge warning">Top seller</span>' : '')+'</td>'
          + '<td data-label="Qty sold" class="amt">'+d.qty+'</td>'
          + '<td data-label="Revenue" class="amt">'+money(d.revenue)+'</td>'
          + '</tr>';
      }).join('');
      tableEl.innerHTML = '<div class="table-scroll"><table class="dtable"><thead><tr><th>Dish</th><th class="amt">Qty sold</th><th class="amt">Revenue</th></tr></thead><tbody>'+rows+'</tbody></table></div>';
    }

    renderAnalysisCharts(list);
  }

  function chartColors(){
    return { accent:'#d9a441', primary:'#17375e', muted:'#928c7e', success:'#2f7d52', info:'#2f6690', grid:'#e5e2da' };
  }
  function renderAnalysisCharts(list){
    if(typeof Chart === 'undefined') return;
    var c = chartColors();

    // revenue trend by day
    var byDay = {};
    list.forEach(function(inv){
      var key = localDateStr(new Date(inv.date));
      byDay[key] = (byDay[key] || 0) + (Number(inv.total) || 0);
    });
    var days = Object.keys(byDay).sort();
    var revCanvas = document.getElementById('revenueChart');
    if(revenueChartInst){ revenueChartInst.destroy(); }
    if(days.length === 0){
      revCanvas.getContext('2d').clearRect(0,0,revCanvas.width,revCanvas.height);
    } else {
      var labels = days.map(function(d){ return new Date(d+'T00:00:00').toLocaleDateString('en-IN', { day:'2-digit', month:'short' }); });
      revenueChartInst = new Chart(revCanvas, {
        type: 'line',
        data: { labels: labels, datasets: [{
          label: 'Revenue', data: days.map(function(d){ return byDay[d]; }),
          borderColor: c.accent, backgroundColor: 'rgba(217,164,65,.12)', fill: true, tension: .35,
          pointRadius: 3, pointBackgroundColor: c.accent, borderWidth: 2.4
        }]},
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins:{ legend:{ display:false }, tooltip:{ callbacks:{ label:function(ctx){ return money(ctx.parsed.y); } } } },
          scales:{
            x:{ grid:{ display:false }, ticks:{ color:c.muted, font:{ family:'Inter', size:11 } } },
            y:{ grid:{ color:c.grid }, ticks:{ color:c.muted, font:{ family:'Inter', size:11 }, callback:function(v){ return state.restaurant.currency + v; } } }
          }
        }
      });
    }

    // payment method distribution
    var byMethod = {};
    list.forEach(function(inv){
      var m = inv.paymentMethod || 'Cash';
      byMethod[m] = (byMethod[m] || 0) + 1;
    });
    var methods = Object.keys(byMethod);
    var payCanvas = document.getElementById('paymentChart');
    if(paymentChartInst){ paymentChartInst.destroy(); }
    if(methods.length === 0){
      payCanvas.getContext('2d').clearRect(0,0,payCanvas.width,payCanvas.height);
    } else {
      var palette = [c.primary, c.accent, c.info, c.success];
      paymentChartInst = new Chart(payCanvas, {
        type: 'doughnut',
        data: { labels: methods, datasets: [{ data: methods.map(function(m){ return byMethod[m]; }), backgroundColor: palette, borderWidth: 2, borderColor:'#fff' }] },
        options: {
          responsive:true, maintainAspectRatio:false, cutout:'62%',
          plugins:{ legend:{ position:'bottom', labels:{ color:c.muted, font:{ family:'Inter', size:11.5 }, padding:14, usePointStyle:true } } }
        }
      });
    }
  }
  document.getElementById('analysisMonth').addEventListener('change', renderSalesAnalysisFromCache);
  document.getElementById('analysisMonthClear').addEventListener('click', function(){
    document.getElementById('analysisMonth').value = '';
    renderSalesAnalysisFromCache();
  });

  // ---------- staff management (admin) ----------
  var staffResetOpenId = null;
  document.getElementById('exportStaffBtn').addEventListener('click', function(){
    exportRowsToExcel('staff', currentTenantStaff(), [
      { key:'staffId', label:'Staff ID' },
      { key:'name', label:'Name' },
      { key:'department', label:'Department' },
      { key:'email', label:'Email' },
      { key:'phone', label:'Phone' }
    ]);
  });
  function updateStaffLimitUi(tenantStaff){
    var note = document.getElementById('staffLimitNote');
    var openBtn = document.getElementById('openStaffModalBtn');
    if(!note || !openBtn) return;
    var count = tenantStaff.length;
    var atLimit = count >= MAX_STAFF_ACCOUNTS_NOW();
    note.textContent = count + ' / ' + MAX_STAFF_ACCOUNTS_NOW() + ' departments staffed';
    openBtn.disabled = atLimit;
    openBtn.title = atLimit ? 'All departments are staffed — remove one to add another' : '';
  }
  function renderStaffList(){
    return api.getStaff().then(function(list){
      // server returns snake_case columns — map to the field names the UI already uses
      state.staff = list.map(function(s){
        return { id: s.id, staffId: s.staff_id, name: s.name, email: s.email, phone: s.phone, department: s.department, createdAt: s.created_at, adminId: tenantId() };
      });
      renderStaffListFromCache();
    }).catch(function(e){
      var wrap = document.getElementById('staffListWrap');
      if (wrap) wrap.innerHTML = '<p class="error-text show">'+escapeHtml(e.message)+'</p>';
    });
  }
  function renderStaffListFromCache(){
    var tenantStaff = currentTenantStaff();
    updateStaffLimitUi(tenantStaff);
    var wrap = document.getElementById('staffListWrap');
    if(tenantStaff.length === 0){
      wrap.innerHTML = emptyState(ICONS.staff, 'No staff accounts yet', 'Add your first staff member to get started.',
        '<button class="btn accent small" id="emptyAddStaffBtn">Add staff</button>');
      var eb = document.getElementById('emptyAddStaffBtn');
      if(eb) eb.addEventListener('click', function(){ document.getElementById('openStaffModalBtn').click(); });
      return;
    }
    var rows = tenantStaff.map(function(s){
      var d = new Date(s.createdAt).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' });
      var row = '<tr>'
        + '<td data-label="Staff ID" class="code">'+escapeHtml(s.staffId)+'</td>'
        + '<td data-label="Name">'+escapeHtml(s.name || '—')+'</td>'
        + '<td data-label="Department">'+escapeHtml(departmentLabel(s.department))+'</td>'
        + '<td data-label="Status"><span class="badge success">'+ICONS.check+' Active</span></td>'
        + '<td data-label="Created">'+d+'</td>'
        + '<td data-label="Actions" style="white-space:nowrap;">'
        + '<button class="btn ghost small" data-view-staff="'+s.id+'">View</button> '
        + '<button class="btn ghost small" data-reset="'+s.id+'">Reset password</button> '
        + '<button class="btn danger-ghost small" data-remove="'+s.id+'">Remove</button>'
        + '</td></tr>';
      if(staffResetOpenId === s.id){
        row += '<tr><td colspan="6" style="background:var(--bg);">'
          + '<div style="display:grid;grid-template-columns:1fr 1fr auto auto;gap:12px;align-items:end;padding:14px 6px;">'
          + '<div class="field" style="margin-bottom:0;"><label for="resetPw-'+s.id+'">New password</label><input type="password" id="resetPw-'+s.id+'" placeholder="At least 6 characters"></div>'
          + '<div class="field" style="margin-bottom:0;"><label for="resetPw2-'+s.id+'">Confirm password</label><input type="password" id="resetPw2-'+s.id+'" placeholder="Re-enter"></div>'
          + '<button class="btn accent small" data-save-reset="'+s.id+'">Save</button>'
          + '<button class="btn ghost small" data-cancel-reset="'+s.id+'">Cancel</button>'
          + '</div>'
          + '<p class="error-text" id="resetErr-'+s.id+'" style="padding:0 6px 12px;"></p>'
          + '</td></tr>';
      }
      return row;
    }).join('');
    wrap.innerHTML = '<div class="table-scroll"><table class="dtable"><thead><tr><th>Staff ID</th><th>Name</th><th>Department</th><th>Status</th><th>Created</th><th></th></tr></thead><tbody>'+rows+'</tbody></table></div>';

    wrap.querySelectorAll('[data-view-staff]').forEach(function(btn){
      btn.addEventListener('click', function(){
        var s = state.staff.find(function(x){ return x.id === btn.dataset.viewStaff; });
        if(s) openStaffDetails(s);
      });
    });
    wrap.querySelectorAll('[data-reset]').forEach(function(btn){
      btn.addEventListener('click', function(){
        staffResetOpenId = (staffResetOpenId === btn.dataset.reset) ? null : btn.dataset.reset;
        renderStaffListFromCache();
      });
    });
    wrap.querySelectorAll('[data-cancel-reset]').forEach(function(btn){
      btn.addEventListener('click', function(){ staffResetOpenId = null; renderStaffListFromCache(); });
    });
    wrap.querySelectorAll('[data-save-reset]').forEach(function(btn){
      btn.addEventListener('click', function(){
        var sId = btn.dataset.saveReset;
        var s = state.staff.find(function(x){ return x.id === sId; });
        if(!s) return;
        var pw = document.getElementById('resetPw-'+sId).value;
        var pw2 = document.getElementById('resetPw2-'+sId).value;
        var err = document.getElementById('resetErr-'+sId);
        if(pw.length < 6){ err.textContent = 'Password must be at least 6 characters.'; err.classList.add('show'); return; }
        if(pw !== pw2){ err.textContent = 'Passwords do not match.'; err.classList.add('show'); return; }
        api.resetStaffPassword(sId, pw).then(function(){
          staffResetOpenId = null;
          showToast('Password reset for ' + s.staffId);
          renderStaffListFromCache();
        }).catch(function(e){
          err.textContent = e.message; err.classList.add('show');
        });
      });
    });
    wrap.querySelectorAll('[data-remove]').forEach(function(btn){
      btn.addEventListener('click', function(){
        var s = state.staff.find(function(x){ return x.id === btn.dataset.remove; });
        if(!s) return;
        openConfirm({
          title: 'Remove staff account?',
          desc: '<b>'+escapeHtml(s.staffId)+'</b> will no longer be able to access the billing system.',
          confirmLabel: 'Remove staff',
          onConfirm: function(){
            api.deleteStaff(s.id).then(function(){
              showToast('Staff account removed');
              renderStaffList();
              renderDashboard();
            }).catch(function(e){ showToast(e.message); });
          }
        });
      });
    });
  }
  var staffDetailsCurrent = null;
  function renderStaffDetailsView(s){
    document.getElementById('staffDetailsTitle').textContent = 'Staff details';
    document.getElementById('staffDetailsSub').textContent = 'Everything on file for this staff account.';
    var d = new Date(s.createdAt).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' });
    document.getElementById('staffDetailsBody').innerHTML =
      '<div class="sd-row"><span class="sd-label">Name</span><span class="sd-value">'+escapeHtml(s.name || '—')+'</span></div>'
      + '<div class="sd-row"><span class="sd-label">Staff ID</span><span class="sd-value code">'+escapeHtml(s.staffId)+'</span></div>'
      + '<div class="sd-row"><span class="sd-label">Department</span><span class="sd-value">'+escapeHtml(departmentLabel(s.department))+'</span></div>'
      + '<div class="sd-row"><span class="sd-label">Email</span><span class="sd-value">'+(s.email ? escapeHtml(s.email) : '<span style="color:var(--text-muted);">Not on file</span>')+'</span></div>'
      + '<div class="sd-row"><span class="sd-label">Phone</span><span class="sd-value">'+(s.phone ? escapeHtml(s.phone) : '<span style="color:var(--text-muted);">Not on file</span>')+'</span></div>'
      + '<div class="sd-row"><span class="sd-label">Status</span><span class="sd-value"><span class="badge success">'+ICONS.check+' Active</span></span></div>'
      + '<div class="sd-row"><span class="sd-label">Created</span><span class="sd-value">'+d+'</span></div>';
    document.getElementById('staffDetailsFootView').style.display = 'flex';
    document.getElementById('staffDetailsFootEdit').style.display = 'none';
  }
  function renderStaffDetailsEdit(s){
    document.getElementById('staffDetailsTitle').textContent = 'Edit staff details';
    document.getElementById('staffDetailsSub').textContent = 'Staff ID stays the same — that\'s what they log in with.';
    document.getElementById('staffDetailsBody').innerHTML =
      '<div class="field"><label for="sdEditName">Name</label><input type="text" id="sdEditName" value="'+escapeHtml(s.name||'')+'"></div>'
      + '<div class="field"><label>Staff ID</label><input type="text" value="'+escapeHtml(s.staffId)+'" disabled style="opacity:.6;"></div>'
      + '<div class="grid-2">'
      + '<div class="field"><label for="sdEditEmail">Email</label><input type="email" id="sdEditEmail" value="'+escapeHtml(s.email||'')+'"></div>'
      + '<div class="field"><label for="sdEditPhone">Phone number</label><input type="tel" id="sdEditPhone" value="'+escapeHtml(s.phone||'')+'"></div>'
      + '</div>'
      + '<div class="field" style="margin-bottom:0;"><label for="sdEditDept">Department</label><select id="sdEditDept"></select></div>'
      + '<p class="error-text" id="sdEditError"></p>';
    populateDepartmentSelect(document.getElementById('sdEditDept'), s.department);
    document.getElementById('staffDetailsFootView').style.display = 'none';
    document.getElementById('staffDetailsFootEdit').style.display = 'flex';
  }
  function openStaffDetails(s){
    staffDetailsCurrent = s;
    renderStaffDetailsView(s);
    document.getElementById('staffDetailsScrim').classList.add('show');
  }
  document.getElementById('staffDetailsClose').addEventListener('click', function(){
    document.getElementById('staffDetailsScrim').classList.remove('show');
  });
  document.getElementById('staffDetailsDone').addEventListener('click', function(){
    document.getElementById('staffDetailsScrim').classList.remove('show');
  });
  document.getElementById('staffDetailsEditBtn').addEventListener('click', function(){
    if(staffDetailsCurrent) renderStaffDetailsEdit(staffDetailsCurrent);
  });
  document.getElementById('staffDetailsCancelEdit').addEventListener('click', function(){
    if(staffDetailsCurrent) renderStaffDetailsView(staffDetailsCurrent);
  });
  document.getElementById('staffDetailsSaveBtn').addEventListener('click', function(){
    if(!staffDetailsCurrent) return;
    var btn = this;
    var name = document.getElementById('sdEditName').value.trim();
    var email = document.getElementById('sdEditEmail').value.trim();
    var phone = document.getElementById('sdEditPhone').value.trim();
    var department = document.getElementById('sdEditDept').value;
    var err = document.getElementById('sdEditError');
    if(!name){ err.textContent = 'Enter the staff member\'s name.'; err.classList.add('show'); return; }
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){ err.textContent = 'Enter a valid email address.'; err.classList.add('show'); return; }
    var phoneDigits = phone.replace(/\D/g, '');
    if(phoneDigits.length < 7 || phoneDigits.length > 15){ err.textContent = 'Enter a valid phone number.'; err.classList.add('show'); return; }
    var deptTaken = currentTenantStaff().some(function(x){ return x.department === department && x.id !== staffDetailsCurrent.id; });
    if(deptTaken){ err.textContent = departmentLabel(department)+' already has a staff account. Remove it to move this account there.'; err.classList.add('show'); return; }
    err.classList.remove('show');

    setBtnLoading(btn, true, 'Saving…');
    api.updateStaff(staffDetailsCurrent.id, name, email, phone, department).then(function(updated){
      setBtnLoading(btn, false, null, 'Save changes');
      showToast('Staff details updated');
      var mapped = { id: updated.id, staffId: updated.staff_id, name: updated.name, email: updated.email, phone: updated.phone, department: updated.department, createdAt: updated.created_at, adminId: tenantId() };
      var idx = state.staff.findIndex(function(x){ return x.id === mapped.id; });
      if(idx !== -1) state.staff[idx] = mapped;
      staffDetailsCurrent = mapped;
      renderStaffListFromCache();
      renderStaffDetailsView(mapped);
    }).catch(function(e){
      setBtnLoading(btn, false, null, 'Save changes');
      err.textContent = e.message; err.classList.add('show');
    });
  });
  document.getElementById('addStaffBtn').addEventListener('click', function(){
    var btn = this;
    var name = document.getElementById('staffName').value.trim();
    var staffId = document.getElementById('staffId').value.trim();
    var email = document.getElementById('staffEmail').value.trim();
    var phone = document.getElementById('staffPhone').value.trim();
    var department = document.getElementById('staffDepartment').value;
    var pw = document.getElementById('staffPassword').value;
    var pw2 = document.getElementById('staffPasswordConfirm').value;
    var err = document.getElementById('staffError');

    var tenantStaff = currentTenantStaff();
    if(tenantStaff.length >= MAX_STAFF_ACCOUNTS_NOW()){ err.textContent = 'All departments included in your plan are staffed. Remove one, or upgrade your plan to add more.'; err.classList.add('show'); return; }
    if(!name){ err.textContent = 'Enter the staff member\'s name.'; err.classList.add('show'); return; }
    if(!department){ err.textContent = 'Select a department.'; err.classList.add('show'); return; }
    var deptTaken = tenantStaff.some(function(s){ return s.department === department; });
    if(deptTaken){ err.textContent = departmentLabel(department)+' already has a staff account. Remove it to add another.'; err.classList.add('show'); return; }
    if(!staffId){ err.textContent = 'Enter a Staff ID.'; err.classList.add('show'); return; }
    var exists = state.staff.some(function(s){ return s.staffId.toLowerCase() === staffId.toLowerCase(); });
    if(exists){ err.textContent = 'That Staff ID is already in use.'; err.classList.add('show'); return; }
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){ err.textContent = 'Enter a valid email address.'; err.classList.add('show'); return; }
    var phoneDigits = phone.replace(/\D/g, '');
    if(phoneDigits.length < 7 || phoneDigits.length > 15){ err.textContent = 'Enter a valid phone number.'; err.classList.add('show'); return; }
    if(pw.length < 6){ err.textContent = 'Password must be at least 6 characters.'; err.classList.add('show'); return; }
    if(pw !== pw2){ err.textContent = 'Passwords do not match.'; err.classList.add('show'); return; }
    err.classList.remove('show');

    setBtnLoading(btn, true, 'Adding…');
    api.createStaff(staffId, name, email, phone, department, pw).then(function(){
      setBtnLoading(btn, false, null, 'Add staff');
      showToast('Staff account created');
      document.getElementById('staffName').value = '';
      document.getElementById('staffId').value = '';
      document.getElementById('staffEmail').value = '';
      document.getElementById('staffPhone').value = '';
      document.getElementById('staffPassword').value = '';
      document.getElementById('staffPasswordConfirm').value = '';
      staffModalScrim.classList.remove('show');
      renderStaffList();
      renderDashboard();
    }).catch(function(e){
      setBtnLoading(btn, false, null, 'Add staff');
      err.textContent = e.message; err.classList.add('show');
    });
  });
  bindEnterToSubmit(['staffName','staffId','staffEmail','staffPhone','staffPassword','staffPasswordConfirm'], 'addStaffBtn');

  // ---------- promo codes ----------
  function promoStatus(promo){
    if(promo.expiryDate){
      var today = new Date(); today.setHours(0,0,0,0);
      var exp = new Date(promo.expiryDate + 'T23:59:59');
      if(exp < today){ return 'Expired'; }
    }
    if(promo.maxUses != null && promo.usedCount >= promo.maxUses){ return 'Limit reached'; }
    return 'Active';
  }
  function isPromoUsable(promo){ return promoStatus(promo) === 'Active'; }

  function renderPromoList(){
    var wrap = document.getElementById('promoListWrap');
    if(!wrap) return;
    return fetchPromoCodesFromServer().then(function(){ renderPromoListFromCache(); }).catch(function(e){
      wrap.innerHTML = '<p class="error-text show">'+escapeHtml(e.message)+'</p>';
    });
  }
  function renderPromoListFromCache(){
    var wrap = document.getElementById('promoListWrap');
    if(!wrap) return;
    if(state.promoCodes.length === 0){
      wrap.innerHTML = emptyState(ICONS.promo, 'No promo codes yet', 'Add your first code to offer discounts at billing.',
        '<button class="btn accent small" id="emptyAddPromoBtn">Add code</button>');
      var eb = document.getElementById('emptyAddPromoBtn');
      if(eb) eb.addEventListener('click', function(){ document.getElementById('openPromoModalBtn').click(); });
      return;
    }
    var rows = state.promoCodes.map(function(p){
      var discountLabel = p.discountType === 'percent' ? (p.discountValue + '% off') : (money(p.discountValue) + ' off');
      var expiryLabel = p.expiryDate ? new Date(p.expiryDate + 'T00:00:00').toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' }) : 'No expiry';
      var usesLabel = (p.usedCount || 0) + ' / ' + (p.maxUses != null ? p.maxUses : '∞');
      var status = promoStatus(p);
      var badgeClass = status === 'Active' ? 'success' : (status === 'Expired' ? 'danger' : 'warning');
      return '<tr>'
        + '<td data-label="Code" class="code">'+escapeHtml(p.code)+'</td>'
        + '<td data-label="Discount">'+escapeHtml(discountLabel)+'</td>'
        + '<td data-label="Expiry">'+escapeHtml(expiryLabel)+'</td>'
        + '<td data-label="Uses">'+escapeHtml(usesLabel)+'</td>'
        + '<td data-label="Status"><span class="badge '+badgeClass+'">'+escapeHtml(status.toUpperCase())+'</span></td>'
        + '<td data-label="Actions"><button class="btn danger-ghost small" data-delete-promo="'+p.id+'">Delete</button></td>'
        + '</tr>';
    }).join('');
    wrap.innerHTML = '<div class="table-scroll"><table class="dtable"><thead><tr><th>Code</th><th>Discount</th><th>Expiry</th><th>Uses</th><th>Status</th><th></th></tr></thead><tbody>'+rows+'</tbody></table></div>';
    wrap.querySelectorAll('[data-delete-promo]').forEach(function(btn){
      btn.addEventListener('click', function(){
        var p = state.promoCodes.find(function(x){ return x.id === btn.dataset.deletePromo; });
        if(!p) return;
        openConfirm({
          title: 'Delete promo code?',
          desc: '<b>'+escapeHtml(p.code)+'</b> will no longer be usable at billing.',
          confirmLabel: 'Delete code',
          onConfirm: function(){
            api.deletePromoCode(p.id).then(function(){
              showToast('Promo code deleted'); renderPromoList();
            }).catch(function(e){ showToast(e.message, 'error'); });
          }
        });
      });
    });
  }
  document.getElementById('addPromoBtn').addEventListener('click', function(){
    var btn = this;
    var code = document.getElementById('promoCode').value.trim().toUpperCase();
    var type = document.getElementById('promoType').value;
    var value = parseFloat(document.getElementById('promoValue').value);
    var expiry = document.getElementById('promoExpiry').value || null;
    var maxUsesRaw = document.getElementById('promoMaxUses').value;
    var maxUses = maxUsesRaw ? parseInt(maxUsesRaw, 10) : null;
    var err = document.getElementById('promoAddError');

    if(!code){ err.textContent = 'Enter a code.'; err.classList.add('show'); return; }
    var exists = state.promoCodes.some(function(p){ return p.code === code; });
    if(exists){ err.textContent = 'That code already exists.'; err.classList.add('show'); return; }
    if(isNaN(value) || value <= 0){ err.textContent = 'Enter a valid discount value.'; err.classList.add('show'); return; }
    if(type === 'percent' && value > 100){ err.textContent = 'Percentage can\'t be more than 100.'; err.classList.add('show'); return; }
    err.classList.remove('show');

    setBtnLoading(btn, true, 'Adding…');
    api.createPromoCode({ code: code, discountType: type, discountValue: value, expiryDate: expiry, maxUses: maxUses }).then(function(){
      setBtnLoading(btn, false, null, 'Add code');
      showToast('Promo code added');
      document.getElementById('promoCode').value = '';
      document.getElementById('promoValue').value = '';
      document.getElementById('promoExpiry').value = '';
      document.getElementById('promoMaxUses').value = '';
      promoModalScrim.classList.remove('show');
      renderPromoList();
    }).catch(function(e){
      setBtnLoading(btn, false, null, 'Add code');
      err.textContent = e.message; err.classList.add('show');
    });
  });

  // ---------- init ----------
  // Session validity now lives server-side: the JWT in localStorage (set by
  // api.js on login) is the only thing that says "is this person logged in".
  // We ask the backend "is this token still good, and who is it for" via
  // /api/auth/me instead of matching against locally-cached admin/staff lists.
  loadAll().then(function(){
    if(!api.getToken()){
      state.session = null;
      resetGateToDefault();
      return;
    }
    api.me().then(function(res){
      var u = res.user;
      if(u.role === 'admin'){
        state.session = { role:'admin', adminId: u.adminId, email: u.email, firstName: u.firstName, lastName: u.lastName, photo: u.photo || null };
      } else {
        state.session = { role:'staff', staffId: u.staffId, name: u.name, department: u.department, adminId: u.adminId, photo: u.photo || null };
      }
      return loadTenantData(u.adminId);
    }).then(function(){
      proceedAfterLogin();
    }).catch(function(){
      // token missing/expired/invalid — api.js already cleared it on a 401
      state.session = null;
      resetGateToDefault();
    });
  });

  // ---------- public bridge for assets/js/voice-commands.js ----------
  // Deliberately tiny: voice commands never get their own copy of business
  // logic, they only ever call the SAME functions the buttons call — so
  // voice inherits every permission/plan check automatically, for free.
  window.EazzioApp = {
    switchTab: switchTab,
    showToast: showToast,
    isVoiceEnabled: function(){
      return !!(state.session && state.session.role === 'admin' &&
        state.subscription && (state.subscription.features || []).indexOf('voice') !== -1);
    },
    // Returns a flat list of { label, sub, go() } across every search
    // category (pages, rooms, staff, menu items, halls, promos, etc.) —
    // the exact same results the topbar search box would show.
    search: function(query){
      var groups = buildSearchGroups(query);
      var flat = [];
      groups.forEach(function(g){ g.items.forEach(function(item){ flat.push(item); }); });
      return flat;
    },
    // Opens the existing search overlay pre-filled with a query, for when
    // a voice command is ambiguous (multiple matches) and the admin should
    // pick — reuses the exact same UI a manual search would show.
    openSearchUI: function(query){
      var input = document.getElementById('globalSearchInput') || globalSearchInput;
      input.value = query;
      input.dispatchEvent(new Event('input'));
      document.getElementById('topbarSearch').classList.add('mobile-open');
      input.focus();
    }
  };

  // ---------- premium tactile ripple (touch/click feedback on buttons) ----------
  document.addEventListener('pointerdown', function(e){
    var el = e.target.closest ? e.target.closest('.btn, .icon-btn, .pm-btn') : null;
    if(!el || el.disabled) return;
    var rect = el.getBoundingClientRect();
    var size = Math.max(rect.width, rect.height) * 1.6;
    var span = document.createElement('span');
    span.className = 'ripple';
    span.style.width = span.style.height = size + 'px';
    span.style.left = ((e.clientX || (rect.left + rect.width/2)) - rect.left - size/2) + 'px';
    span.style.top = ((e.clientY || (rect.top + rect.height/2)) - rect.top - size/2) + 'px';
    el.appendChild(span);
    span.addEventListener('animationend', function(){ span.remove(); });
  }, { passive:true });
})();