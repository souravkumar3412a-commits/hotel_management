// Row validation for the Excel/CSV imports (rooms and menu items).
//
// The browser already checks every row and shows the admin a preview, but this
// file is the real gatekeeper: the server never trusts what the browser sent,
// so every row is validated again here before anything is written.

// Must stay in sync with DEFAULT_AMENITIES and the bed-type <select> in the frontend.
const AMENITIES = ['Wi-Fi', 'TV', 'Attached Bathroom', 'Hot Water', 'Refrigerator', 'Wardrobe', 'Balcony', 'Room Service', 'Geyser', 'Telephone', 'Desk'];
const BED_TYPES = ['Single Bed', 'Double Bed', 'Twin Beds', 'Queen Bed', 'King Bed'];
const MAX_IMPORT_ROWS = 500;

function clean(v) {
  return v === undefined || v === null ? '' : String(v).trim();
}

// "Yes"/"No" style cells. Blank falls back to `dflt`; anything unrecognised is an error.
function parseYesNo(v, dflt, yesWords, noWords) {
  const s = clean(v).toLowerCase();
  if (s === '') return { ok: true, value: dflt };
  if (yesWords.indexOf(s) !== -1) return { ok: true, value: true };
  if (noWords.indexOf(s) !== -1) return { ok: true, value: false };
  return { ok: false };
}
const YES = ['yes', 'y', 'true', '1', 'allowed'];
const NO = ['no', 'n', 'false', '0', 'not allowed'];

function parseNumber(v) {
  const s = clean(v).replace(/,/g, '').replace(/^[\u20B9$]\s*/, '');
  if (s === '' || !/^-?\d+(\.\d+)?$/.test(s)) return NaN;
  return parseFloat(s);
}
function parseIntStrict(v) {
  const s = clean(v);
  if (!/^\d+$/.test(s)) return NaN;
  return parseInt(s, 10);
}

function matchBedType(v) {
  const s = clean(v).toLowerCase().replace(/\s+/g, ' ');
  if (s === '') return 'Double Bed';
  for (const b of BED_TYPES) {
    const full = b.toLowerCase();
    const short = full.replace(/ (bed|beds)$/, '');
    if (s === full || s === short || s === short + ' bed' || s === short + ' beds') return b;
  }
  return null;
}

function parseAmenities(v) {
  if (Array.isArray(v)) v = v.join(',');
  const parts = clean(v).split(/[,;|\n]/).map((p) => p.trim()).filter(Boolean);
  const found = [];
  const unknown = [];
  parts.forEach((p) => {
    const hit = AMENITIES.find((a) => a.toLowerCase() === p.toLowerCase() || a.toLowerCase().replace(/[-\s]/g, '') === p.toLowerCase().replace(/[-\s]/g, ''));
    if (hit) { if (found.indexOf(hit) === -1) found.push(hit); }
    else unknown.push(p.slice(0, 40));
  });
  return { found, unknown };
}

// Room numbers follow the app's own convention: floor number followed by two digits
// (101 = floor 1, room 01; 1205 = floor 12, room 05). The floor is worked out from
// the number, so a row can never disagree with itself.
function validateRoomRow(raw) {
  const errors = [];
  const warnings = [];
  const roomNo = parseIntStrict(raw.roomNo);
  let floor = null, pos = null;
  if (isNaN(roomNo)) {
    errors.push('Room number must be a whole number like 101, 205 or 1203.');
  } else {
    floor = Math.floor(roomNo / 100);
    pos = roomNo % 100;
    if (floor < 1 || pos < 1 || roomNo > 9999) {
      errors.push('Room number must be the floor number followed by two digits (e.g. 101, 205, 1203).');
    }
  }
  const category = clean(raw.category);
  if (!category) errors.push('Category is required.');
  else if (category.length > 60) errors.push('Category name is too long (60 characters max).');

  const bedType = matchBedType(raw.bedType);
  if (bedType === null) errors.push('Bed type "' + clean(raw.bedType).slice(0, 30) + '" isn\'t recognised. Use one of: ' + BED_TYPES.join(', ') + '.');

  const ac = parseYesNo(raw.ac, true, YES.concat(['ac', 'a/c']), NO.concat(['non-ac', 'non ac', 'nonac', 'non a/c']));
  if (!ac.ok) errors.push('AC must be Yes or No.');

  let maxAdults = 2, maxChildren = 1;
  if (clean(raw.maxAdults) !== '') {
    maxAdults = parseIntStrict(raw.maxAdults);
    if (isNaN(maxAdults) || maxAdults < 1 || maxAdults > 10) errors.push('Max adults must be a number from 1 to 10.');
  }
  if (clean(raw.maxChildren) !== '') {
    maxChildren = parseIntStrict(raw.maxChildren);
    if (isNaN(maxChildren) || maxChildren < 0 || maxChildren > 10) errors.push('Max children must be a number from 0 to 10.');
  }

  const price = parseNumber(raw.price);
  if (isNaN(price) || price <= 0) errors.push('Price per night must be a number greater than 0.');
  else if (price > 10000000) errors.push('Price per night looks too high.');

  const am = parseAmenities(raw.amenities);
  if (am.unknown.length) warnings.push('Ignored amenities we don\'t have: ' + am.unknown.join(', ') + '.');

  const extra = parseYesNo(raw.extraBed, false, YES, NO);
  if (!extra.ok) errors.push('Extra bed allowed must be Yes or No.');
  let extraBedPrice = 0;
  if (extra.ok && extra.value) {
    if (clean(raw.extraBedPrice) !== '') {
      extraBedPrice = parseNumber(raw.extraBedPrice);
      if (isNaN(extraBedPrice) || extraBedPrice < 0) errors.push('Extra bed price must be a number (0 or more).');
    }
  }

  return {
    errors, warnings,
    value: errors.length ? null : {
      roomNo, floor, pos, category, bedType, ac: ac.value, maxAdults, maxChildren, price,
      amenities: am.found, extraBedAllowed: extra.value, extraBedPrice
    }
  };
}

function validateMenuRow(raw) {
  const errors = [];
  const name = clean(raw.name);
  if (!name) errors.push('Item name is required.');
  else if (name.length > 80) errors.push('Item name is too long (80 characters max).');
  const category = clean(raw.category) || 'Other';
  if (category.length > 40) errors.push('Category name is too long (40 characters max).');
  const price = parseNumber(raw.price);
  if (isNaN(price) || price < 0) errors.push('Price must be a number (0 or more).');
  else if (price > 1000000) errors.push('Price looks too high.');
  const veg = parseYesNo(raw.veg, true,
    ['veg', 'v', 'vegetarian', 'yes', 'y', 'true', '1'],
    ['non-veg', 'non veg', 'nonveg', 'nv', 'non-vegetarian', 'no', 'n', 'false', '0']);
  if (!veg.ok) errors.push('Veg / Non-Veg must be "Veg" or "Non-Veg".');
  return {
    errors, warnings: [],
    value: errors.length ? null : { name, category, price, isVeg: veg.value }
  };
}

module.exports = { AMENITIES, BED_TYPES, MAX_IMPORT_ROWS, validateRoomRow, validateMenuRow };