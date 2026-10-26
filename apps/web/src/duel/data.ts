/** Mock-данные игрового экрана (docs/ui-spec.md §4–5). */

export interface Dealer {
  name: string;
  scene: 'Кабаре' | 'Лобби' | 'Природа' | 'Кресло';
  tint: string;
  /** Минимальная ставка за столом. */
  min: number;
  busy?: boolean;
}

export const DEALERS: Dealer[] = [
  { name: 'Алина', scene: 'Кабаре', tint: '#B0202E', min: 1 },
  { name: 'Ева', scene: 'Лобби', tint: '#A47A3A', min: 5 },
  { name: 'Мила', scene: 'Природа', tint: '#4E8A4A', min: 1 },
  { name: 'Соня', scene: 'Кресло', tint: '#7A4A2A', min: 10, busy: true },
  { name: 'Лера', scene: 'Кабаре', tint: '#5A3AB0', min: 25 },
  { name: 'Кира', scene: 'Лобби', tint: '#2A7AA4', min: 5 },
  { name: 'Ника', scene: 'Природа', tint: '#C0603A', min: 1 },
  { name: 'Яна', scene: 'Кресло', tint: '#A43A7A', min: 10 },
  { name: 'Вика', scene: 'Кабаре', tint: '#3AA48A', min: 5 },
  { name: 'Даша', scene: 'Лобби', tint: '#8A8A3A', min: 1 },
  { name: 'Зоя', scene: 'Природа', tint: '#3A5AA4', min: 25, busy: true },
  { name: 'Майя', scene: 'Кресло', tint: '#A4503A', min: 5 },
];

export const CHIPS = [
  { value: 1, color: '#5C6BC0' },
  { value: 5, color: '#E53935' },
  { value: 10, color: '#1E88E5' },
  { value: 25, color: '#43A047' },
  { value: 100, color: '#212121' },
] as const;

export const chipColor = (value: number) =>
  [...CHIPS].reverse().find((c) => value >= c.value)?.color ?? CHIPS[0].color;

/**
 * Режим «Крупье отвечает взаимностью»: только аксессуары и верхняя одежда.
 * Список фиксирован (на бэкенде тоже) — других значений не предусмотрено.
 */
export const ITEMS = [
  { id: 'glasses', name: 'Очки', emoji: '🕶️', price: 5 },
  { id: 'hat', name: 'Шляпа', emoji: '👒', price: 5 },
  { id: 'scarf', name: 'Шарф', emoji: '🧣', price: 10 },
  { id: 'earrings', name: 'Серьги', emoji: '💎', price: 10 },
  { id: 'gloves', name: 'Перчатки', emoji: '🧤', price: 15 },
  { id: 'shoes', name: 'Туфли', emoji: '👠', price: 20 },
  { id: 'jacket', name: 'Пиджак', emoji: '🧥', price: 25 },
] as const;
export type ItemId = (typeof ITEMS)[number]['id'];
export const itemById = (id: string | null) => ITEMS.find((i) => i.id === id) ?? null;

/** Раундов с крупье до режима взаимности (белое кольцо). */
export const ROUNDS_TO_RECIPROCITY = 3;
/** Тайминги раунда, мс: приём ставки → раскрытие → итог. */
export const REVEAL_AFTER_MS = 4_000;
export const DONE_AFTER_MS = 5_500;
/** Окно приёма ставок для таймера на сцене, с. */
export const BET_WINDOW_SEC = 15;
/** Стартовый баланс в фишках; внутри логики деньги — в сотых (как FUN в ledger, 10⁻²). */
export const START_BALANCE = 1_000;

/** Комиссия площадки (docs/decisions.md): сбор со ставки и комиссия с выигрыша, в б.п. */
export const STAKE_FEE_BPS = 229;
export const WIN_FEE_BPS = 1_000;
export const RECIPROCITY_WIN_FEE_BPS = 2_000;
