// ============================================================
// api.js — service layer for the Resort Management System frontend.
// All network calls to the backend live here. index.html should call
// these functions instead of storageGet/storageSet for anything that
// used to be tenant/account data (rooms, bookings, staff, invoices, etc).
//
// Theme + sidebar-collapsed preferences are the ONLY things that should
// keep using localStorage directly — everything else goes through here.
// ============================================================
(function (global) {
  // Change this to your deployed backend URL once you deploy (Phase 9).
  const API_BASE = 'https://resort-backend-lb7u.onrender.com/api';

  let authToken = null;
  try { authToken = window.localStorage.getItem('invoice-desk:auth-token'); } catch (e) {}

  function setToken(token) {
    authToken = token;
    try {
      if (token) window.localStorage.setItem('invoice-desk:auth-token', token);
      else window.localStorage.removeItem('invoice-desk:auth-token');
    } catch (e) {}
  }

  async function request(method, path, body) {
    let res;
    try {
      res = await fetch(API_BASE + path, {
        method,
        headers: Object.assign(
          { 'Content-Type': 'application/json' },
          authToken ? { Authorization: 'Bearer ' + authToken } : {}
        ),
        body: body !== undefined ? JSON.stringify(body) : undefined
      });
    } catch (networkErr) {
      // fetch() itself throws when there's no connection / server unreachable / CORS blocked
      const err = new Error('Unable to connect to the server. Please check your internet connection.');
      err.isNetworkError = true;
      throw err;
    }

    if (res.status === 204) return null;

    let data = null;
    try { data = await res.json(); } catch (e) { /* empty body */ }

    if (!res.ok) {
      if (res.status === 401) {
        setToken(null); // session expired or invalid — force re-login
      }
      const message = (data && data.error) || `Request failed (${res.status}).`;
      const err = new Error(message);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  const api = {
    setToken,
    getToken: () => authToken,

    // ---------- auth ----------
    adminSignup: (firstName, lastName, email, password) =>
      request('POST', '/auth/admin/signup', { firstName, lastName, email, password })
        .then(r => { setToken(r.token); return r.user; }),

    adminLogin: (email, password) =>
      request('POST', '/auth/admin/login', { email, password })
        .then(r => { setToken(r.token); return r.user; }),

    adminGoogleLogin: (accessToken) =>
      request('POST', '/auth/admin/google', { accessToken })
        .then(r => { setToken(r.token); return r.user; }),

    staffLogin: (staffId, password) =>
      request('POST', '/auth/staff/login', { staffId, password })
        .then(r => { setToken(r.token); return r.user; }),

    me: () => request('GET', '/auth/me'),
    updateAdminProfile: (firstName, lastName, photo) => request('PUT', '/auth/admin/profile', { firstName, lastName, photo }),
    updateStaffProfile: (name, photo) => request('PUT', '/auth/staff/profile', { name, photo }),

    logout: () => setToken(null),

    // ---------- staff management ----------
    getStaff: () => request('GET', '/staff'),
    createStaff: (staffId, name, department, password) =>
      request('POST', '/staff', { staffId, name, department, password }),
    deleteStaff: (id) => request('DELETE', '/staff/' + id),
    resetStaffPassword: (id, password) => request('PUT', '/staff/' + id + '/reset-password', { password }),

    // ---------- rooms ----------
    getRoomFloors: () => request('GET', '/rooms/floors'),
    addRoomFloor: (floor, roomCount) => request('POST', '/rooms/floors', { floor, roomCount }),
    updateRoomFloor: (id, roomCount) => request('PUT', '/rooms/floors/' + id, { roomCount }),
    deleteRoomFloor: (id) => request('DELETE', '/rooms/floors/' + id),

    getRoomCategories: () => request('GET', '/rooms/categories'),
    addRoomCategory: (name) => request('POST', '/rooms/categories', { name }),
    deleteRoomCategory: (id) => request('DELETE', '/rooms/categories/' + id),

    getRooms: () => request('GET', '/rooms'),
    createRoom: (room) => request('POST', '/rooms', room),
    updateRoom: (id, room) => request('PUT', '/rooms/' + id, room),
    deleteRoom: (id) => request('DELETE', '/rooms/' + id),

    getRoomBookings: (status) => request('GET', '/rooms/bookings' + (status ? '?status=' + status : '')),
    createRoomBooking: (booking) => request('POST', '/rooms/bookings', booking),
    checkoutRoomBooking: (id) => request('PUT', '/rooms/bookings/' + id + '/checkout'),
    lookupRoomGuest: (roomNo) => request('GET', '/rooms/lookup/' + encodeURIComponent(roomNo)),

    // ---------- banquets ----------
    getBanquetHalls: () => request('GET', '/banquets/halls'),
    createBanquetHall: (hall) => request('POST', '/banquets/halls', hall),
    updateBanquetHall: (id, hall) => request('PUT', '/banquets/halls/' + id, hall),
    deleteBanquetHall: (id) => request('DELETE', '/banquets/halls/' + id),

    getBanquetBookings: () => request('GET', '/banquets/bookings'),
    createBanquetBooking: (booking) => request('POST', '/banquets/bookings', booking),
    setBanquetBookingStatus: (id, status) => request('PUT', '/banquets/bookings/' + id + '/status', { status }),

    // ---------- restaurant ----------
    getMenu: () => request('GET', '/restaurant/menu'),
    getDeletedMenu: () => request('GET', '/restaurant/menu/deleted'),
    createMenuItem: (item) => request('POST', '/restaurant/menu', item),
    updateMenuItem: (id, item) => request('PUT', '/restaurant/menu/' + id, item),
    deleteMenuItem: (id) => request('DELETE', '/restaurant/menu/' + id),
    restoreMenuItem: (id) => request('POST', '/restaurant/menu/' + id + '/restore'),

    getTables: () => request('GET', '/restaurant/tables'),
    saveTable: (tableNo, tableState) => request('PUT', '/restaurant/tables/' + tableNo, tableState),

    getPromoCodes: () => request('GET', '/restaurant/promo-codes'),
    createPromoCode: (promo) => request('POST', '/restaurant/promo-codes', promo),
    deletePromoCode: (id) => request('DELETE', '/restaurant/promo-codes/' + id),

    // ---------- invoices ----------
    getInvoices: (department) => request('GET', '/invoices' + (department ? '?department=' + department : '')),
    getInvoice: (id) => request('GET', '/invoices/' + id),
    createInvoice: (invoice) => request('POST', '/invoices', invoice),
    deleteInvoice: (id) => request('DELETE', '/invoices/' + id),
    uploadInvoicePdf: (id, pdfBase64) => request('POST', '/invoices/' + id + '/pdf', { pdfBase64 }),

    // ---------- settings ----------
    getHotelSettings: () => request('GET', '/settings/hotel'),
    updateHotelSettings: (settings) => request('PUT', '/settings/hotel', settings),
    getRestaurantSettings: () => request('GET', '/settings/restaurant'),
    updateRestaurantSettings: (settings) => request('PUT', '/settings/restaurant', settings),

    // ---------- subscription ----------
    getSubscription: () => request('GET', '/subscription'),
    subscribeToPlan: () => request('POST', '/subscription/subscribe')
    // FUTURE RAZORPAY: after Checkout succeeds, call a new
    // api.verifySubscriptionPayment(razorpayResponse) here that POSTs to
    // /api/subscription/verify — see subscription.js on the backend.
  };

  global.api = api;
})(window);