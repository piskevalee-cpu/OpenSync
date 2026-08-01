export function cleanUsername(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().normalize('NFC');
  return cleaned || null;
}

export function normalizeUsername(username) {
  const cleaned = cleanUsername(username);
  return cleaned ? cleaned.toLowerCase() : null;
}
