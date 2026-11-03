// Serialización de los timestamps SIN zona del snapshot (`datetime`,
// `filledAt` son `timestamp without time zone`, hora local del mercado).
//
// pg los devuelve como Date parseada en la zona local del proceso; se
// re-serializa desde los componentes LOCALES para no desplazar la hora
// (toISOString() la correría a UTC). ISO 8601 sin offset.

const pad = (value: number): string => String(value).padStart(2, "0");

/** Date (timestamp sin zona) → "YYYY-MM-DDTHH:mm:ss" (hora local del mercado). */
export const serializeLocalTimestamp = (value: Date): string =>
  `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}` +
  `T${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
