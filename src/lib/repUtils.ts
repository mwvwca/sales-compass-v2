export function normalizeRepName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}
