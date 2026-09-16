// ============================================================
// api.js — service layer for the Hotel Management System frontend.
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

  const TOKEN_KEY = 'invoice-desk:auth-token';

  let authToken = null;
  // "Remember Me" on the login screen decides where the token lives: checked
  // (default) persists it in localStorage across browser restarts; unchecked
  // keeps it in sessionStorage only, so it's gone once the tab/browser closes.
  // On load we check both, since we don't yet know which one the person used.
  try { authToken = window.sessionStorage.getItem(TOKEN_KEY) || window.localStorage.getItem(TOKEN_KEY); } catch (e) {}

  function setToken(token, remember) {
    authToken = token;
    try {
      if (!token) {
        window.localStorage.removeItem(TOKEN_KEY);
        window.sessionStorage.removeItem(TOKEN_KEY);
      } else if (remember === false) {
        window.sessionStorage.setItem(TOKEN_KEY, token);
        window.localStorage.removeItem(TOKEN_KEY);
      } else {
        window.localStorage.setItem(TOKEN_KEY, token);
        window.sessionStorage.removeItem(TOKEN_KEY);
      }
    } catch (e) {}
  }

  // ============================================================
  // DEMO MODE — a fully self-contained, fake dataset used for the
  // "Dashboard Demo" button on the login screen. When active, every API
  // call is intercepted here: reads resolve with fixed sample data below,
  // writes are rejected with a friendly message. Nothing ever touches the
  // real backend or database — this is intentional, so a demo visitor can
  // never see, modify, or interfere with any real hotel's data.
  // ============================================================
  let demoMode = false;
  function enterDemoMode() { demoMode = true; }
  function exitDemoMode() { demoMode = false; }
  function isDemoMode() { return demoMode; }

  function daysAgo(n, h, m) { const d = new Date(); d.setDate(d.getDate() - n); d.setHours(h != null ? h : 10, m || 0, 0, 0); return d.toISOString(); }
  function daysFromNow(n, h, m) { const d = new Date(); d.setDate(d.getDate() + n); d.setHours(h != null ? h : 12, m || 0, 0, 0); return d.toISOString(); }

  const DEMO_RESTAURANT_EXTRA = {
    name: 'The Grand Vista Resort', phone: '+91 98765 43210', email: 'frontdesk@grandvista.demo',
    address: 'Plot 12, Lakeview Road, Udaipur, Rajasthan 313001', gstin: '08ABCDE1234F1Z5',
    taxRate: 12, currency: '₹', invoicePrefix: 'GV',
    footer: 'Thank you for choosing The Grand Vista Resort. This is a computer-generated invoice.',
    logo: '', stamp: '', signature: '',
    standardCheckInTime: '12:00', standardCheckOutTime: '11:00',
    earlyCheckinFeePerHour: 300, lateCheckoutFeePerHour: 250
  };

  const DEMO_STAFF = [
    { id: 'demo-staff-1', staff_id: 'demo01', name: 'Aman Kumar', email: 'aman@grandvista.demo', phone: '9876543211', department: 'room', created_at: daysAgo(120) },
    { id: 'demo-staff-2', staff_id: 'demo02', name: 'Priya Singh', email: 'priya@grandvista.demo', phone: '9876543212', department: 'banquet', created_at: daysAgo(110) },
    { id: 'demo-staff-3', staff_id: 'demo03', name: 'Rahul Verma', email: 'rahul@grandvista.demo', phone: '9876543213', department: 'restaurant', created_at: daysAgo(100) }
  ];

  const DEMO_ROOM_FLOORS = [
    { id: 'demo-floor-1', floor: 'Ground Floor', room_count: 5 },
    { id: 'demo-floor-2', floor: 'First Floor', room_count: 5 }
  ];
  const DEMO_ROOM_CATEGORIES = [
    { id: 'demo-cat-standard', name: 'Standard' },
    { id: 'demo-cat-deluxe', name: 'Deluxe' },
    { id: 'demo-cat-suite', name: 'Suite' }
  ];
  const DEMO_ROOM_DEFS = [
    { room_no: '101', floor: 'Ground Floor', category_id: 'demo-cat-standard', bed_type: 'Twin', ac: false, price: 2200 },
    { room_no: '102', floor: 'Ground Floor', category_id: 'demo-cat-standard', bed_type: 'Double', ac: true, price: 2800 },
    { room_no: '103', floor: 'Ground Floor', category_id: 'demo-cat-deluxe', bed_type: 'Double', ac: true, price: 3800 },
    { room_no: '104', floor: 'Ground Floor', category_id: 'demo-cat-deluxe', bed_type: 'Double', ac: true, price: 3800 },
    { room_no: '105', floor: 'Ground Floor', category_id: 'demo-cat-suite', bed_type: 'King', ac: true, price: 6200 },
    { room_no: '201', floor: 'First Floor', category_id: 'demo-cat-standard', bed_type: 'Twin', ac: true, price: 2600 },
    { room_no: '202', floor: 'First Floor', category_id: 'demo-cat-deluxe', bed_type: 'Double', ac: true, price: 3900 },
    { room_no: '203', floor: 'First Floor', category_id: 'demo-cat-deluxe', bed_type: 'Double', ac: true, price: 3900 },
    { room_no: '204', floor: 'First Floor', category_id: 'demo-cat-suite', bed_type: 'King', ac: true, price: 6500 },
    { room_no: '205', floor: 'First Floor', category_id: 'demo-cat-suite', bed_type: 'King', ac: true, price: 6800 }
  ];
  const DEMO_ROOMS = DEMO_ROOM_DEFS.map(function (r, i) {
    return {
      id: 'demo-room-' + r.room_no, room_no: r.room_no, floor: r.floor, category_id: r.category_id,
      bed_type: r.bed_type, ac: r.ac, max_adults: 2, max_children: 1, price: r.price,
      amenities: ['Wi-Fi', 'TV', 'Attached Bathroom', 'Hot Water'], extra_bed_allowed: true, extra_bed_price: 500,
      out_of_order: false,
      booking_id: null, guest_name: null, guest_phone: null, check_in: null, check_out: null, invoice_id: null,
      advance_amount: 0, balance_paid: false
    };
  });
  // Occupy rooms 102, 104 and 202 right now, each linked to a real demo invoice below.
  DEMO_ROOMS.find(function (r) { return r.room_no === '102'; }).booking_id = 'demo-rb-1';
  Object.assign(DEMO_ROOMS.find(function (r) { return r.room_no === '102'; }), {
    guest_name: 'Rohit Sharma', guest_phone: '9123456780', check_in: daysAgo(1, 13, 30), check_out: null,
    invoice_id: 'demo-inv-room-1', advance_amount: 1500, balance_paid: false
  });
  DEMO_ROOMS.find(function (r) { return r.room_no === '104'; }).booking_id = 'demo-rb-2';
  Object.assign(DEMO_ROOMS.find(function (r) { return r.room_no === '104'; }), {
    guest_name: 'Ananya Iyer', guest_phone: '9123456781', check_in: daysAgo(0, 11, 0), check_out: null,
    invoice_id: 'demo-inv-room-2', advance_amount: 0, balance_paid: false
  });
  DEMO_ROOMS.find(function (r) { return r.room_no === '202'; }).booking_id = 'demo-rb-3';
  Object.assign(DEMO_ROOMS.find(function (r) { return r.room_no === '202'; }), {
    guest_name: 'Karan Mehta', guest_phone: '9123456782', check_in: daysAgo(2, 15, 0), check_out: null,
    invoice_id: 'demo-inv-room-3', advance_amount: 4000, balance_paid: true
  });

  // Every room booking ever made — active ones above plus completed history,
  // used for the dashboard's occupancy chart and "most booked rooms".
  const DEMO_GUEST_NAMES = ['Rohit Sharma','Ananya Iyer','Karan Mehta','Sneha Reddy','Vikram Joshi','Pooja Nair','Arjun Kapoor','Divya Menon','Rajesh Gupta','Neha Kulkarni','Suresh Rao','Kavya Pillai'];
  const DEMO_ROOM_BOOKINGS = [
    { id: 'demo-rb-1', room_id: 'demo-room-102', guest_name: 'Rohit Sharma', guest_phone: '9123456780', check_in: daysAgo(1, 13, 30), check_out: null, status: 'active', invoice_id: 'demo-inv-room-1', created_at: daysAgo(1, 13, 30) },
    { id: 'demo-rb-2', room_id: 'demo-room-104', guest_name: 'Ananya Iyer', guest_phone: '9123456781', check_in: daysAgo(0, 11, 0), check_out: null, status: 'active', invoice_id: 'demo-inv-room-2', created_at: daysAgo(0, 11, 0) },
    { id: 'demo-rb-3', room_id: 'demo-room-202', guest_name: 'Karan Mehta', guest_phone: '9123456782', check_in: daysAgo(2, 15, 0), check_out: null, status: 'active', invoice_id: 'demo-inv-room-3', created_at: daysAgo(2, 15, 0) }
  ];
  [3, 4, 5, 6, 7, 9, 10, 12, 14, 16, 18, 21, 24, 27].forEach(function (n, i) {
    const roomNo = DEMO_ROOM_DEFS[i % DEMO_ROOM_DEFS.length].room_no;
    const stay = 1 + (i % 3);
    DEMO_ROOM_BOOKINGS.push({
      id: 'demo-rb-hist-' + n, room_id: 'demo-room-' + roomNo,
      guest_name: DEMO_GUEST_NAMES[i % DEMO_GUEST_NAMES.length], guest_phone: '90000000' + (10 + i),
      check_in: daysAgo(n, 13, 0), check_out: daysAgo(n - stay, 11, 0), status: 'completed',
      invoice_id: 'demo-inv-room-hist-' + n, created_at: daysAgo(n, 13, 0)
    });
  });

  const DEMO_BANQUET_HALLS = [
    { id: 'demo-hall-1', name: 'Royal Petite Hall', capacity: 80, facilities: ['Stage', 'Sound System', 'AC'], out_of_order: false,
      pricing: { hour: { enabled: true, price: 4000 }, day: { enabled: true, price: 28000 }, week: { enabled: false, price: 0 } } },
    { id: 'demo-hall-2', name: 'Grand Ballroom', capacity: 250, facilities: ['Stage', 'Sound System', 'AC', 'Projector', 'Valet Parking'], out_of_order: false,
      pricing: { hour: { enabled: true, price: 9000 }, day: { enabled: true, price: 65000 }, week: { enabled: true, price: 380000 } } }
  ];
  const DEMO_BANQUET_BOOKINGS = [
    { id: 'demo-bb-1', booking_code: 'BH-DEMO-0001', hall_id: 'demo-hall-1', customer_name: 'Sulekha Devi', customer_phone: '8825315745',
      guest_count: 50, event_type: 'Birthday Party', food_package: 'Veg Standard', decoration_package: 'Basic',
      pricing_basis: 'day', unit_price: 28000, duration_count: 1, start_at: daysFromNow(5, 12, 0), end_at: daysFromNow(6, 0, 0),
      total_amount: 45000, status: 'booked', invoice_id: 'demo-inv-banq-1', advance_amount: 15000, advance_payment_method: 'UPI',
      balance_paid: false, balance_paid_at: null, created_by_staff_id: 'demo02', created_by_name: 'Priya Singh', created_at: daysAgo(6) },
    { id: 'demo-bb-2', booking_code: 'BH-DEMO-0002', hall_id: 'demo-hall-2', customer_name: 'Vikram & Ritu Wedding', customer_phone: '9988776655',
      guest_count: 220, event_type: 'Wedding', food_package: 'Non-Veg Premium', decoration_package: 'Luxury',
      pricing_basis: 'day', unit_price: 65000, duration_count: 1, start_at: daysFromNow(20, 17, 0), end_at: daysFromNow(21, 2, 0),
      total_amount: 285000, status: 'booked', invoice_id: 'demo-inv-banq-2', advance_amount: 100000, advance_payment_method: 'Card',
      balance_paid: false, balance_paid_at: null, created_by_staff_id: 'demo02', created_by_name: 'Priya Singh', created_at: daysAgo(15) },
    { id: 'demo-bb-3', booking_code: 'BH-DEMO-0003', hall_id: 'demo-hall-1', customer_name: 'Infotech Solutions Pvt Ltd', customer_phone: '9112233445',
      guest_count: 60, event_type: 'Conference / Corporate Event', food_package: 'Veg Premium', decoration_package: '',
      pricing_basis: 'hour', unit_price: 4000, duration_count: 6, start_at: daysAgo(8, 9, 0), end_at: daysAgo(8, 17, 0),
      total_amount: 24000, status: 'completed', invoice_id: 'demo-inv-banq-3', advance_amount: 24000, advance_payment_method: 'Cash',
      balance_paid: true, balance_paid_at: daysAgo(8), created_by_staff_id: 'demo02', created_by_name: 'Priya Singh', created_at: daysAgo(12) },
    { id: 'demo-bb-4', booking_code: 'BH-DEMO-0004', hall_id: 'demo-hall-2', customer_name: 'Meera Nair', customer_phone: '9001122334',
      guest_count: 140, event_type: 'Anniversary', food_package: 'Non-Veg Standard', decoration_package: 'Premium',
      pricing_basis: 'day', unit_price: 65000, duration_count: 1, start_at: daysAgo(18, 18, 0), end_at: daysAgo(17, 1, 0),
      total_amount: 118000, status: 'completed', invoice_id: 'demo-inv-banq-4', advance_amount: 118000, advance_payment_method: 'UPI',
      balance_paid: true, balance_paid_at: daysAgo(17), created_by_staff_id: 'demo02', created_by_name: 'Priya Singh', created_at: daysAgo(25) }
  ];

  const DEMO_DISH_DEFS = [
    { name: 'Paneer Butter Masala', category: 'Main Course', price: 280, is_veg: true },
    { name: 'Butter Chicken', category: 'Main Course', price: 340, is_veg: false },
    { name: 'Veg Biryani', category: 'Rice', price: 220, is_veg: true },
    { name: 'Chicken Biryani', category: 'Rice', price: 300, is_veg: false },
    { name: 'Dal Makhani', category: 'Main Course', price: 210, is_veg: true },
    { name: 'Tandoori Roti', category: 'Breads', price: 35, is_veg: true },
    { name: 'Butter Naan', category: 'Breads', price: 55, is_veg: true },
    { name: 'Gulab Jamun', category: 'Dessert', price: 90, is_veg: true },
    { name: 'Cold Coffee', category: 'Beverages', price: 120, is_veg: true },
    { name: 'Masala Papad', category: 'Starters', price: 70, is_veg: true },
    { name: 'Chicken Tikka', category: 'Starters', price: 320, is_veg: false },
    { name: 'Veg Spring Rolls', category: 'Starters', price: 190, is_veg: true }
  ];
  const DEMO_MENU = DEMO_DISH_DEFS.map(function (d, i) {
    return { id: 'demo-menu-' + i, name: d.name, category: d.category, price: d.price, is_veg: d.is_veg, deleted_at: null };
  });
  const DEMO_TABLES = [1, 2, 3, 4, 5, 6].map(function (n) {
    if (n === 2) {
      return { id: 'demo-table-2', table_no: 2, status: 'active', customer_name: 'Walk-in Guest', customer_phone: '',
        items: [{ name: 'Butter Chicken', price: 340, qty: 1, amount: 340 }, { name: 'Butter Naan', price: 55, qty: 2, amount: 110 }],
        applied_promo: null, payment_method: 'Cash', updated_at: daysAgo(0, 13, 10) };
    }
    return { id: 'demo-table-' + n, table_no: n, status: 'available', customer_name: '', customer_phone: '', items: [], applied_promo: null, payment_method: 'Cash', updated_at: daysAgo(1) };
  });
  const DEMO_PROMO_CODES = [
    { id: 'demo-promo-1', code: 'WELCOME10', discount_type: 'percent', discount_value: 10, expiry_date: null, max_uses: null, used_count: 6, created_at: daysAgo(90) }
  ];

  function demoLineItems(names) {
    return names.map(function (n) {
      const dish = DEMO_DISH_DEFS.find(function (d) { return d.name === n.name; });
      const qty = n.qty || 1;
      const price = dish ? dish.price : 100;
      return { name: n.name, quantity: qty, unit_price: price, line_total: price * qty };
    });
  }
  const DEMO_RESTAURANT_ORDERS = [
    ['Butter Chicken','Butter Naan','Butter Naan'], ['Paneer Butter Masala','Tandoori Roti','Tandoori Roti'],
    ['Chicken Biryani'], ['Veg Biryani','Masala Papad'], ['Chicken Tikka','Cold Coffee'],
    ['Dal Makhani','Butter Naan'], ['Veg Spring Rolls','Cold Coffee','Cold Coffee'], ['Butter Chicken','Veg Biryani']
  ];
  const DEMO_RESTAURANT_INVOICES = [];
  for (let n = 0, seq = 1; n < 28; n++) {
    const ordersToday = n % 3 === 0 ? 2 : 1;
    for (let k = 0; k < ordersToday; k++) {
      const orderNames = DEMO_RESTAURANT_ORDERS[(n + k) % DEMO_RESTAURANT_ORDERS.length].map(function (nm) { return { name: nm }; });
      const items = demoLineItems(orderNames);
      const subtotal = items.reduce(function (s, it) { return s + it.line_total; }, 0);
      const tax = Math.round(subtotal * 0.05);
      const total = subtotal + tax;
      const id = 'demo-inv-rest-' + n + '-' + k;
      DEMO_RESTAURANT_INVOICES.push({
        id: id, invoice_no: 'GV-REST-' + String(seq).padStart(4, '0'), department: 'restaurant',
        customer_name: DEMO_GUEST_NAMES[(n + k) % DEMO_GUEST_NAMES.length], customer_phone: '90000000' + (20 + n),
        table_no: (n % 6) + 1, room_booking_id: null, banquet_booking_id: null,
        subtotal: subtotal, discount_amount: 0, promo_code: null, total_amount: total,
        payment_method: ['Cash', 'UPI', 'Card'][(n + k) % 3], created_by_staff_id: 'demo03',
        created_at: daysAgo(n, 12 + (k * 6), (n * 7) % 60), room_no: null, room_check_in: null, room_check_out: null,
        room_advance_amount: 0, room_balance_paid: false, banquet_advance_amount: 0, banquet_balance_paid: false,
        items: items
      });
      seq++;
    }
  }

  function roomInvoice(id, invoiceNo, roomBooking, roomNo, extraItem, createdAt) {
    const room = DEMO_ROOMS.find(function (r) { return r.room_no === roomNo; });
    const nights = roomBooking.check_out
      ? Math.max(1, Math.round((new Date(roomBooking.check_out) - new Date(roomBooking.check_in)) / 86400000))
      : Math.max(1, Math.round((Date.now() - new Date(roomBooking.check_in)) / 86400000) || 1);
    const items = [{ name: 'Room ' + roomNo + ' — ' + nights + ' night' + (nights === 1 ? '' : 's'), quantity: nights, unit_price: room.price, line_total: room.price * nights }];
    if (extraItem) items.push(extraItem);
    const subtotal = items.reduce(function (s, it) { return s + it.line_total; }, 0);
    const tax = Math.round(subtotal * 0.12);
    const total = subtotal + tax;
    return {
      id: id, invoice_no: invoiceNo, department: 'room', customer_name: roomBooking.guest_name, customer_phone: roomBooking.guest_phone,
      table_no: null, room_booking_id: roomBooking.id, banquet_booking_id: null,
      subtotal: subtotal, discount_amount: 0, promo_code: null, total_amount: total, payment_method: 'Cash',
      created_by_staff_id: 'demo01', created_at: createdAt || roomBooking.check_in,
      room_no: roomNo, room_check_in: roomBooking.check_in, room_check_out: roomBooking.check_out,
      room_advance_amount: room.advance_amount || 0, room_balance_paid: room.balance_paid || false,
      banquet_advance_amount: 0, banquet_balance_paid: false, items: items
    };
  }
  const DEMO_ROOM_INVOICES = [
    roomInvoice('demo-inv-room-1', 'GV-ROOM-0001', DEMO_ROOM_BOOKINGS[0], '102'),
    roomInvoice('demo-inv-room-2', 'GV-ROOM-0002', DEMO_ROOM_BOOKINGS[1], '104'),
    roomInvoice('demo-inv-room-3', 'GV-ROOM-0003', DEMO_ROOM_BOOKINGS[2], '202')
  ];
  DEMO_ROOM_BOOKINGS.filter(function (b) { return b.status === 'completed'; }).forEach(function (b, i) {
    const roomNo = b.room_id.replace('demo-room-', '');
    DEMO_ROOM_INVOICES.push(roomInvoice(b.invoice_id, 'GV-ROOM-' + String(4 + i).padStart(4, '0'), b, roomNo, null, b.check_in));
  });

  function banquetInvoice(booking) {
    const hall = DEMO_BANQUET_HALLS.find(function (h) { return h.id === booking.hall_id; });
    const items = [{ name: hall.name + ' — ' + booking.pricing_basis + ' × ' + booking.duration_count, quantity: booking.duration_count, unit_price: booking.unit_price, line_total: booking.unit_price * booking.duration_count }];
    if (booking.food_package) { const perPlate = Math.round((booking.total_amount * 0.3) / booking.guest_count); items.push({ name: 'Food Package — ' + booking.food_package + ' (' + booking.guest_count + ' plates)', quantity: booking.guest_count, unit_price: perPlate, line_total: perPlate * booking.guest_count }); }
    if (booking.decoration_package) { items.push({ name: 'Decoration — ' + booking.decoration_package, quantity: 1, unit_price: Math.round(booking.total_amount * 0.08), line_total: Math.round(booking.total_amount * 0.08) }); }
    const subtotal = items.reduce(function (s, it) { return s + it.line_total; }, 0);
    return {
      id: booking.invoice_id, invoice_no: 'GV-BANQ-' + booking.booking_code.slice(-4), department: 'banquet',
      customer_name: booking.customer_name, customer_phone: booking.customer_phone, table_no: null,
      room_booking_id: null, banquet_booking_id: booking.id, subtotal: subtotal, discount_amount: 0, promo_code: null,
      total_amount: booking.total_amount, payment_method: booking.advance_payment_method || 'Cash',
      created_by_staff_id: 'demo02', created_at: booking.created_at, room_no: null, room_check_in: null, room_check_out: null,
      room_advance_amount: 0, room_balance_paid: false,
      banquet_advance_amount: booking.advance_amount, banquet_balance_paid: booking.balance_paid, items: items
    };
  }
  const DEMO_BANQUET_INVOICES = DEMO_BANQUET_BOOKINGS.map(banquetInvoice);

  const DEMO_INVOICES = DEMO_ROOM_INVOICES.concat(DEMO_BANQUET_INVOICES, DEMO_RESTAURANT_INVOICES);

  const DEMO_SUBSCRIPTION = {
    id: 'demo-sub', admin_id: 'demo', status: 'active', plan_name: 'Standard Plan', amount: '12000.00',
    start_date: daysAgo(60), expiry_date: daysFromNow(305), payment_provider: 'demo', payment_id: null,
    razorpay_order_id: null, promo_code_used: null, gstRate: 0.18, gstAmount: 2160, totalAmount: 14160
  };
  const DEMO_HOTEL_SETTINGS_ROW = { admin_id: 'demo', hotel_name: DEMO_RESTAURANT_EXTRA.name, address: DEMO_RESTAURANT_EXTRA.address, phone: DEMO_RESTAURANT_EXTRA.phone, logo_url: null, invoice_seq: DEMO_INVOICES.length };
  const DEMO_SESSION_USER = { role: 'admin', adminId: 'demo', email: 'demo@eazzio.app', firstName: 'Demo', lastName: 'Admin', photo: null };

  function demoGetPayload(pathname, parts, params) {
    if (pathname === '/auth/me') return { user: DEMO_SESSION_USER };
    if (pathname === '/staff') return DEMO_STAFF;
    if (pathname === '/rooms/floors') return DEMO_ROOM_FLOORS;
    if (pathname === '/rooms/categories') return DEMO_ROOM_CATEGORIES;
    if (pathname === '/rooms') return DEMO_ROOMS;
    if (pathname === '/rooms/bookings') {
      const status = params.get('status');
      return status ? DEMO_ROOM_BOOKINGS.filter(function (b) { return b.status === status; }) : DEMO_ROOM_BOOKINGS;
    }
    if (parts[0] === 'rooms' && parts[1] === 'lookup') { throw new Error('No in-house guest found for that room.'); }
    if (pathname === '/banquets/halls') return DEMO_BANQUET_HALLS;
    if (pathname === '/banquets/bookings') return DEMO_BANQUET_BOOKINGS;
    if (pathname === '/restaurant/menu') return DEMO_MENU;
    if (pathname === '/restaurant/menu/deleted') return [];
    if (pathname === '/restaurant/tables') return DEMO_TABLES;
    if (pathname === '/restaurant/promo-codes') return DEMO_PROMO_CODES;
    if (parts[0] === 'invoices' && parts.length === 2) {
      const inv = DEMO_INVOICES.find(function (i) { return i.id === parts[1]; });
      if (!inv) throw new Error('Invoice not found.');
      return inv;
    }
    if (pathname === '/invoices') {
      const dept = params.get('department');
      return (dept ? DEMO_INVOICES.filter(function (i) { return i.department === dept; }) : DEMO_INVOICES)
        .slice().sort(function (a, b) { return new Date(b.created_at) - new Date(a.created_at); });
    }
    if (pathname === '/settings/hotel') return DEMO_HOTEL_SETTINGS_ROW;
    if (pathname === '/settings/restaurant') return { admin_id: 'demo', table_count: 6, extra: DEMO_RESTAURANT_EXTRA };
    if (pathname === '/subscription') return DEMO_SUBSCRIPTION;
    throw new Error('Not available in this demo.');
  }

  function demoRequest(method, path) {
    const splitPath = path.split('?');
    const pathname = splitPath[0];
    const params = new URLSearchParams(splitPath[1] || '');
    const parts = pathname.split('/').filter(Boolean);
    return new Promise(function (resolve, reject) {
      setTimeout(function () {
        if (method !== 'GET') {
          reject(new Error('This is a live demo — sign up for a free account to save real changes.'));
          return;
        }
        try {
          resolve(demoGetPayload(pathname, parts, params));
        } catch (e) {
          reject(e);
        }
      }, 200);
    });
  }

  async function request(method, path, body) {
    if (demoMode) return demoRequest(method, path);
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
    enterDemoMode,
    exitDemoMode,
    isDemoMode,

    // ---------- auth ----------
    adminSignup: (firstName, lastName, email, password) =>
      request('POST', '/auth/admin/signup', { firstName, lastName, email, password })
        .then(r => { setToken(r.token); return r.user; }),

    adminLogin: (email, password, remember) =>
      request('POST', '/auth/admin/login', { email, password })
        .then(r => { setToken(r.token, remember); return r.user; }),

    adminGoogleLogin: (accessToken, remember) =>
      request('POST', '/auth/admin/google', { accessToken })
        .then(r => { setToken(r.token, remember); return r.user; }),

    staffLogin: (staffId, password, remember) =>
      request('POST', '/auth/staff/login', { staffId, password })
        .then(r => { setToken(r.token, remember); return r.user; }),

    me: () => request('GET', '/auth/me'),
    updateAdminProfile: (firstName, lastName, photo) => request('PUT', '/auth/admin/profile', { firstName, lastName, photo }),
    updateStaffProfile: (name, photo) => request('PUT', '/auth/staff/profile', { name, photo }),

    logout: () => setToken(null),

    // ---------- staff management ----------
    getStaff: () => request('GET', '/staff'),
    createStaff: (staffId, name, email, phone, department, password) =>
      request('POST', '/staff', { staffId, name, email, phone, department, password }),
    updateStaff: (id, name, email, phone, department) =>
      request('PUT', '/staff/' + id, { name, email, phone, department }),
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
    markRoomBalancePaid: (id) => request('PUT', '/rooms/bookings/' + id + '/balance'),
    lookupRoomGuest: (roomNo) => request('GET', '/rooms/lookup/' + encodeURIComponent(roomNo)),
    getGuestHistory: (phone) => request('GET', '/rooms/guest-history?phone=' + encodeURIComponent(phone)),

    // ---------- banquets ----------
    getBanquetHalls: () => request('GET', '/banquets/halls'),
    createBanquetHall: (hall) => request('POST', '/banquets/halls', hall),
    updateBanquetHall: (id, hall) => request('PUT', '/banquets/halls/' + id, hall),
    deleteBanquetHall: (id) => request('DELETE', '/banquets/halls/' + id),

    getBanquetBookings: () => request('GET', '/banquets/bookings'),
    createBanquetBooking: (booking) => request('POST', '/banquets/bookings', booking),
    setBanquetBookingStatus: (id, status) => request('PUT', '/banquets/bookings/' + id + '/status', { status }),
    markBanquetBalancePaid: (id) => request('PUT', '/banquets/bookings/' + id + '/balance'),

    // ---------- restaurant ----------
    getMenu: () => request('GET', '/restaurant/menu'),
    getDeletedMenu: () => request('GET', '/restaurant/menu/deleted'),
    createMenuItem: (item) => request('POST', '/restaurant/menu', item),
    updateMenuItem: (id, item) => request('PUT', '/restaurant/menu/' + id, item),
    setMenuItemAvailability: (id, available) => request('PUT', '/restaurant/menu/' + id + '/availability', { available }),
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
    getSubscriptionPlans: () => request('GET', '/subscription/plans'),
    validateSubscriptionPromo: (code, planType) => request('POST', '/subscription/validate-promo', { code, planType }),
    subscribeToPlan: (planType, promoCode) => request('POST', '/subscription/subscribe', { planType, promoCode: promoCode || null }),
    verifySubscriptionPayment: (payload) => request('POST', '/subscription/verify', payload)
  };

  global.api = api;
})(window);