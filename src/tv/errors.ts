import { randomUUID } from 'node:crypto';
import { ProviderError } from '../providers/types.js';
export class AppError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}
export function publicError(error: unknown) {
  return { status: error instanceof AppError || error instanceof ProviderError ? error.status : 500,
    body: { code: error instanceof AppError ? error.code : 'OPERATION_FAILED', message: error instanceof AppError || error instanceof ProviderError ? error.message : 'Operation failed. Check configuration and service health.', requestId: randomUUID() } };
}
export function fields(input: unknown, allowed: string[]) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) throw new AppError('INVALID_FIELDS', 'Invalid or unknown fields');
}
export function text(value: unknown, name: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) throw new AppError('INVALID_FIELD', `Invalid ${name}`);
  return value.trim();
}
export function snowflake(value: unknown) { const id = text(value, 'Discord ID', 22); if (!/^\d{16,22}$/.test(id)) throw new AppError('INVALID_ID', 'Discord IDs must be snowflake strings'); return id; }
export function integer(value: unknown, min: number, max: number, fallback: number) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) throw new AppError('INVALID_NUMBER', `Expected integer ${min}–${max}`);
  return Number(value);
}
