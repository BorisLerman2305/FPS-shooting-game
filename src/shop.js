// Shop catalog — paired with the server-side list in server.js. Keep the
// IDs + costs in sync; if you change one, change the other.
//
// Each entry has:
//   id          — string key, also used in the user.ownedItems array
//   kind        — 'weapon' or 'perk'
//   name        — Hebrew display name
//   cost        — coin price
//   icon        — emoji shown on the shop card
//   description — Hebrew one-liner
//
// Weapons whose `id` matches a key in WEAPONS (in main.js) are unlockable
// loadout slots. Perks are passive boosts applied at startGame().

export const SHOP_ITEMS = {
  rpg: {
    id: 'rpg', kind: 'weapon', cost: 100,
    name: 'RPG', icon: '🚀',
    description: 'משגר רקטות — פגיעה אדירה, פיצוץ AOE, אבל איטי לטעון.',
  },
  tommyGun: {
    id: 'tommyGun', kind: 'weapon', cost: 250,
    name: 'תת-מקלע מאפיה', icon: '🪈',
    description: 'תת-מקלע אגדי עם מחסנית עגולה. ירי אוטומטי מהיר, 50 כדורים.',
  },
  lightsaber: {
    id: 'lightsaber', kind: 'weapon', cost: 500,
    name: 'חרב לייזר', icon: '🗡️',
    description: 'להב אנרגיה זוהר, נזק מטורף, טווח גדול יותר מחרב רגילה.',
  },
  crossbow: {
    id: 'crossbow', kind: 'weapon', cost: 150,
    name: 'קשת', icon: '🏹',
    description: 'שקטה, פגיעה גבוהה, טעינה איטית. מצוינת לצליפה.',
  },
  minigun: {
    id: 'minigun', kind: 'weapon', cost: 400,
    name: 'מיניגן', icon: '⚙️',
    description: '100 כדורים, RPM אדיר. אש מתמדת ללא רחמים.',
  },
  hpBoost: {
    id: 'hpBoost', kind: 'perk', cost: 200,
    name: 'תוספת חיים', icon: '❤️',
    description: 'מקסימום HP עולה מ-100 ל-125.',
  },
  staminaBoost: {
    id: 'staminaBoost', kind: 'perk', cost: 150,
    name: 'תוספת סטמינה', icon: '⚡',
    description: 'מקסימום סטמינה מ-100 ל-130 — ספרינטים ארוכים יותר.',
  },
  grenadeMax: {
    id: 'grenadeMax', kind: 'perk', cost: 100,
    name: 'תיק רימונים', icon: '💣',
    description: 'נשא עד 7 רימונים במקום 5.',
  },

  // ─── Weapon attachments — cheap upgrades that auto-apply each match ─────
  scopeRifle: {
    id: 'scopeRifle', kind: 'attach', cost: 80,
    name: 'כוונת לרובה סער', icon: '🔭',
    description: 'מוסיף זום (מקש ימני) לרובה הסער — צליפה מדויקת מרחוק.',
  },
  bigMagRifle: {
    id: 'bigMagRifle', kind: 'attach', cost: 60,
    name: 'מחסנית גדולה — רובה סער', icon: '📦',
    description: 'מחסנית רובה הסער עולה מ-30 ל-45 כדורים.',
  },
  bigMagPistol: {
    id: 'bigMagPistol', kind: 'attach', cost: 40,
    name: 'מחסנית גדולה — אקדח', icon: '📦',
    description: 'מחסנית האקדח עולה מ-12 ל-18 כדורים.',
  },
  fastReload: {
    id: 'fastReload', kind: 'attach', cost: 120,
    name: 'טעינה מהירה', icon: '⏱️',
    description: 'כל זמני הטעינה מתקצרים ב-35% — לכל הנשקים.',
  },
  extraPellets: {
    id: 'extraPellets', kind: 'attach', cost: 80,
    name: 'קליעי-על לרובה ציד', icon: '💥',
    description: 'רובה ציד יורה 11 כדוריות במקום 8 — פיזור רחב, נזק עצום.',
  },
  sharpSword: {
    id: 'sharpSword', kind: 'attach', cost: 70,
    name: 'חרב מחודדת', icon: '⚔️',
    description: 'נזק החרב עולה מ-60 ל-90 — הריגה בחתך אחד.',
  },
};

export const SHOP_ORDER = [
  'rpg', 'tommyGun', 'lightsaber', 'crossbow', 'minigun',
  'hpBoost', 'staminaBoost', 'grenadeMax',
  'scopeRifle', 'bigMagRifle', 'bigMagPistol', 'fastReload', 'extraPellets', 'sharpSword',
];

export function isOwned(user, itemId) {
  if (!user || !user.ownedItems) return false;
  return user.ownedItems.includes(itemId);
}
